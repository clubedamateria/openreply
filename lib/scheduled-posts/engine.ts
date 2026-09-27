import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import {
  createCarouselChildContainer,
  createCarouselContainer,
  createImageContainer,
  createReelsContainer,
  getContainerStatus,
  getContentPublishingLimit,
  getMediaPermalink,
  listRecentMedia,
  MetaApiError,
  publishMediaContainer,
  type ContainerStatusCode,
} from "@/lib/meta/client";
import { deleteMediaFiles, listMediaFiles } from "@/lib/storage/media";
import { sendPublishFailureAlert, sendPublishWarningAlert } from "@/lib/email/alert";
import { withAdvisoryLock, type LockResult } from "@/lib/scheduled-posts/advisory-lock";
import type {
  InstagramProvider,
  PrismaClient,
  ScheduledPostMediaType,
  ScheduledPostStatus,
} from "@/app/generated/prisma/client";
import type { Prisma } from "@/app/generated/prisma/client";

/**
 * Two-phase publisher for `ScheduledPost`, driven once a minute by
 * `/api/cron/publish-scheduled`. See docs/2026-09-27-agendados-comentarios.md
 * for the full spec, and its "Mudanças pós-revisão" section for the
 * double-publish-safety rules implemented here.
 *
 * Every state transition goes through a conditional `updateMany({ where: {
 * id, status: <expected>, containerId: <expected> } })`, checking
 * `count === 1`. That — plus never calling a one-way Meta endpoint
 * (media_publish) twice for the same containerId — is what makes this safe
 * against two overlapping cron ticks, a crash mid-tick, or a lost HTTP
 * response from Meta.
 */

// Every phase takes the Prisma client as a parameter (rather than importing
// the module-level `prisma` directly) purely so tests can substitute a fake
// — see lib/scheduled-posts/advisory-lock.ts for why the advisory lock is
// NOT implemented as a wrapping `$transaction` (which would make this a
// `Prisma.TransactionClient` instead).
type Db = PrismaClient;

// A post is prepared (container created) once it is within 15 minutes of its
// scheduled time — Reels processing alone can take past a minute, so waiting
// until the exact minute would routinely miss the slot.
const PREPARE_WINDOW_MS = 15 * 60 * 1000;
// ERROR/EXPIRED containers are recreated up to this many times before the
// post is given up on.
const MAX_ATTEMPTS = 3;
// A container-status poll that keeps throwing (network/Meta outage) is
// retried next tick with no recreation (bloqueador 3) — but if it never
// recovers, the post must not wait forever either.
const STUCK_POLLING_THRESHOLD_MS = 30 * 60 * 1000;
// A row left in PUBLISHING (claimed, then the process died or the
// media_publish response was lost) gets reconciled once it's been
// untouched for this long.
const RECONCILE_STUCK_PUBLISHING_AFTER_MS = 3 * 60 * 1000;
// PUBLISHED posts keep their media files for a day (permalink screenshots,
// manual re-checks), then the cron deletes them to keep the VM's disk from
// filling up. contentHash is NEVER cleared here — see the dedup check in
// app/api/scheduled-posts/route.ts.
const CLEANUP_PUBLISHED_AFTER_MS = 24 * 60 * 60 * 1000;
// FAILED/CANCELED posts keep their files a week, in case someone wants to
// inspect or reschedule with the same upload.
const CLEANUP_FAILED_OR_CANCELED_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
// A file on disk that no SCHEDULED/PREPARING/PUBLISHING post references
// (upload that was never turned into a post, or left behind by a bug) is
// swept after this long — long enough that an upload in progress from the
// panel is never at risk.
const ORPHAN_FILE_AFTER_MS = 48 * 60 * 60 * 1000;
// Per-tick caps (bloqueador 11): the rest waits for next minute rather than
// letting one slow tick balloon.
const MAX_PREPARE_PER_TICK = 10;
const MAX_PUBLISH_PER_TICK = 10;

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v)(\?|#|$)/i.test(url);
}

/** An explicit, well-formed 4xx rejection from Meta — as opposed to a
 * network error, timeout, invalid JSON, or 5xx, all of which are ambiguous
 * about whether the call actually landed (bloqueador 4). */
function isExplicit4xxMetaError(err: unknown): boolean {
  return (
    err instanceof MetaApiError && err.httpStatus >= 400 && err.httpStatus < 500
  );
}

export interface PublishScheduledResult {
  prepared: number;
  published: number;
  failed: number;
  deferredQuota: number;
  reconciled: number;
  cleaned: number;
  orphansDeleted: number;
}

function emptyResult(): PublishScheduledResult {
  return {
    prepared: 0,
    published: 0,
    failed: 0,
    deferredQuota: 0,
    reconciled: 0,
    cleaned: 0,
    orphansDeleted: 0,
  };
}

// --- Shared shapes ---------------------------------------------------------

interface AccountForPublish {
  provider: InstagramProvider;
  accessToken: string;
  instagramId: string;
  username: string;
}

interface PostForPublish {
  id: string;
  workspaceId: string;
  mediaType: ScheduledPostMediaType;
  mediaUrls: string[];
  caption: string;
  shareToFeed: boolean;
  coverUrl: string | null;
  attempts: number;
  containerId: string | null;
  updatedAt: Date;
  instagramAccount: AccountForPublish;
}

interface CreatedContainer {
  containerId: string;
  childContainerIds: string[];
}

async function createContainerForPost(
  accessToken: string,
  igUserId: string,
  post: Pick<PostForPublish, "mediaType" | "mediaUrls" | "caption" | "shareToFeed" | "coverUrl">
): Promise<CreatedContainer> {
  if (post.mediaType === "REELS") {
    const container = await createReelsContainer(accessToken, igUserId, {
      videoUrl: post.mediaUrls[0],
      caption: post.caption,
      shareToFeed: post.shareToFeed,
      coverUrl: post.coverUrl ?? undefined,
    });
    return { containerId: container.id, childContainerIds: [] };
  }

  if (post.mediaType === "IMAGE") {
    const container = await createImageContainer(accessToken, igUserId, {
      imageUrl: post.mediaUrls[0],
      caption: post.caption,
    });
    return { containerId: container.id, childContainerIds: [] };
  }

  // CAROUSEL: every slide is its own container first, created in order —
  // that order is what determines slide order in the published post.
  const childContainerIds: string[] = [];
  for (const mediaUrl of post.mediaUrls) {
    const child = await createCarouselChildContainer(accessToken, igUserId, {
      mediaUrl,
      isVideo: isVideoUrl(mediaUrl),
    });
    childContainerIds.push(child.id);
  }
  const parent = await createCarouselContainer(accessToken, igUserId, {
    childContainerIds,
    caption: post.caption,
  });
  return { containerId: parent.id, childContainerIds };
}

async function markFailed(
  tx: Db,
  post: PostForPublish,
  message: string,
  attempts: number,
  result: PublishScheduledResult
): Promise<void> {
  const updated = await tx.scheduledPost.updateMany({
    where: { id: post.id, status: { in: ["PREPARING", "PUBLISHING"] } },
    data: { status: "FAILED", errorMessage: message, attempts },
  });
  if (updated.count === 0) return;

  result.failed += 1;
  await sendPublishFailureAlert({
    workspaceId: post.workspaceId,
    scheduledPostId: post.id,
    username: post.instagramAccount.username,
    errorMessage: message,
  });
}

/**
 * Decrypt the account's token for this post, failing this post alone
 * (bloqueador 10): a corrupted/undecryptable token is not transient — there
 * is nothing to gain from retrying it like a Meta outage — so it goes
 * straight to FAILED with an alert instead of consuming the container-retry
 * budget or, worse, throwing out of the caller's loop and skipping every
 * later post in the same tick.
 */
async function decryptOrFail(
  tx: Db,
  post: PostForPublish,
  result: PublishScheduledResult
): Promise<string | null> {
  try {
    return decryptToken(post.instagramAccount.accessToken);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(
      tx,
      post,
      `Token de acesso corrompido ou não decifrável: ${message}`,
      post.attempts + 1,
      result
    );
    return null;
  }
}

/**
 * A container came back ERROR/EXPIRED (an explicit status code, never a
 * network exception — see bloqueador 3). Recreates the container (fresh
 * containerId, reset child ids) and keeps the post in PREPARING for the next
 * tick to poll — unless attempts are exhausted, in which case it goes
 * straight to FAILED.
 */
async function handleContainerFailure(
  tx: Db,
  post: PostForPublish,
  err: unknown,
  result: PublishScheduledResult
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const attempts = post.attempts + 1;

  if (attempts >= MAX_ATTEMPTS) {
    await markFailed(tx, post, message, attempts, result);
    return;
  }

  const accessToken = await decryptOrFail(tx, post, result);
  if (accessToken === null) return;

  try {
    const created = await createContainerForPost(
      accessToken,
      post.instagramAccount.instagramId,
      post
    );
    await tx.scheduledPost.updateMany({
      where: { id: post.id, status: { in: ["PREPARING", "PUBLISHING"] } },
      data: {
        status: "PREPARING",
        containerId: created.containerId,
        childContainerIds: created.childContainerIds,
        attempts,
        errorMessage: message,
      },
    });
  } catch (recreateErr) {
    const recreateMessage =
      recreateErr instanceof Error ? recreateErr.message : String(recreateErr);
    // The recreation attempt itself still counts — otherwise a Meta outage
    // would let the same post retry forever instead of eventually failing.
    await tx.scheduledPost.updateMany({
      where: { id: post.id, status: { in: ["PREPARING", "PUBLISHING"] } },
      data: {
        status: "PREPARING",
        attempts,
        errorMessage: `${message}; recriação do container falhou: ${recreateMessage}`,
      },
    });
  }
}

/**
 * A container's status_code came back PUBLISHED even though our own row
 * never recorded a successful media_publish (bloqueador 2) — this happens
 * when a previous tick's media_publish call succeeded on Meta's side but its
 * HTTP response was lost (crash, network drop, timeout) before we could
 * write mediaId. Since the content IS already live, this never re-publishes
 * — it only tries to find the resulting media (by matching caption; a
 * timestamp match is implicit since `listRecentMedia` only returns the most
 * recent items) so the panel can show a permalink.
 *
 * If the match is missing or ambiguous (more than one candidate with the
 * same caption), the post is still marked PUBLISHED — republishing would be
 * far worse than a missing permalink — but with `mediaId: null` and an email
 * alert asking a human to fill it in.
 */
async function handlePublishedContainer(
  tx: Db,
  post: PostForPublish,
  accessToken: string,
  now: Date,
  result: PublishScheduledResult,
  fromStatus: Extract<ScheduledPostStatus, "PREPARING" | "PUBLISHING">
): Promise<void> {
  let mediaId: string | null = null;
  let permalink: string | null = null;
  let matchNote = "nenhum candidato em listRecentMedia bateu com a legenda";

  try {
    const recent = await listRecentMedia(accessToken, post.instagramAccount.instagramId, 10);
    const candidates = recent.filter((m) => (m.caption ?? "") === post.caption);
    if (candidates.length === 1) {
      mediaId = candidates[0].id;
      permalink = candidates[0].permalink ?? null;
    } else if (candidates.length > 1) {
      matchNote = `${candidates.length} candidatos bateram com a legenda — ambíguo demais para confiar`;
    }
  } catch (err) {
    matchNote = `listRecentMedia falhou: ${err instanceof Error ? err.message : String(err)}`;
  }

  const baseWhere = { id: post.id, status: fromStatus, containerId: post.containerId };
  let claimedCount = 0;
  try {
    const updated = await tx.scheduledPost.updateMany({
      where: baseWhere,
      data: {
        status: "PUBLISHED",
        mediaId,
        permalink,
        publishedAt: now,
        errorMessage: mediaId ? null : `Publicado sem mediaId confirmado: ${matchNote}`,
      },
    });
    claimedCount = updated.count;
  } catch {
    // Most likely a unique-constraint clash on mediaId (a wrong/duplicate
    // match). Meta has already published this — falling back to no mediaId
    // is still correct; falling through to "leave it unresolved" is not.
    const fallback = await tx.scheduledPost.updateMany({
      where: baseWhere,
      data: {
        status: "PUBLISHED",
        publishedAt: now,
        errorMessage: `Publicado, mas gravação do mediaId falhou (provável colisão): ${matchNote}`,
      },
    });
    claimedCount = fallback.count;
    mediaId = null;
  }

  if (claimedCount === 0) return; // another tick already resolved this row

  result.published += 1;
  if (!mediaId) {
    await sendPublishWarningAlert({
      workspaceId: post.workspaceId,
      scheduledPostId: post.id,
      username: post.instagramAccount.username,
      message: matchNote,
    });
  }
}

// --- Phase 1: prepare -------------------------------------------------------

async function prepareDuePosts(tx: Db, now: Date, result: PublishScheduledResult): Promise<void> {
  const cutoff = new Date(now.getTime() + PREPARE_WINDOW_MS);

  const due = await tx.scheduledPost.findMany({
    where: { status: "SCHEDULED", scheduledFor: { lte: cutoff } },
    include: { instagramAccount: true },
    take: MAX_PREPARE_PER_TICK,
    orderBy: { scheduledFor: "asc" },
  });

  for (const post of due) {
    // Conditional claim: only one overlapping cron tick moves a given post
    // out of SCHEDULED.
    const claimed = await tx.scheduledPost.updateMany({
      where: { id: post.id, status: "SCHEDULED" },
      data: { status: "PREPARING" },
    });
    if (claimed.count === 0) continue;

    if (post.instagramAccount.provider !== "META") {
      await markFailed(
        tx,
        post,
        "Conta usa o provedor Zernio, que não publica agendados nesta versão — reconecte a conta pela Meta em Configurações.",
        post.attempts,
        result
      );
      continue;
    }

    const accessToken = await decryptOrFail(tx, post, result);
    if (accessToken === null) continue;

    try {
      const created = await createContainerForPost(
        accessToken,
        post.instagramAccount.instagramId,
        post
      );
      // Guarded by status too: only write the just-created containerId if
      // the row is still where we left it (PREPARING) — a crash between the
      // claim above and here just leaves containerId null for the next tick
      // to retry from scratch, never a stale overwrite.
      await tx.scheduledPost.updateMany({
        where: { id: post.id, status: "PREPARING" },
        data: {
          containerId: created.containerId,
          childContainerIds: created.childContainerIds,
        },
      });
      result.prepared += 1;
    } catch (err) {
      await handleContainerFailure(tx, post, err, result);
    }
  }
}

// --- Phase 2: publish --------------------------------------------------------

async function publishReadyPosts(tx: Db, now: Date, result: PublishScheduledResult): Promise<void> {
  const preparing = await tx.scheduledPost.findMany({
    where: { status: "PREPARING", scheduledFor: { lte: now }, mediaId: null },
    include: { instagramAccount: true },
    take: MAX_PUBLISH_PER_TICK,
    orderBy: { scheduledFor: "asc" },
  });

  for (const post of preparing) {
    if (post.instagramAccount.provider !== "META") {
      await markFailed(
        tx,
        post,
        "Conta usa o provedor Zernio, que não publica agendados nesta versão — reconecte a conta pela Meta em Configurações.",
        post.attempts,
        result
      );
      continue;
    }

    if (!post.containerId) {
      await handleContainerFailure(tx, post, new Error("Post sem container preparado"), result);
      continue;
    }

    const accessToken = await decryptOrFail(tx, post, result);
    if (accessToken === null) continue;

    let statusCode: ContainerStatusCode;
    try {
      const status = await getContainerStatus(accessToken, post.containerId);
      statusCode = status.status_code;
    } catch (err) {
      // Bloqueador 3: a network/Meta exception while polling is NOT grounds
      // to recreate the container — it says nothing about the container
      // itself, only that this one check failed. Just wait for next tick,
      // unless this has been going on so long it needs a human.
      if (now.getTime() - post.updatedAt.getTime() >= STUCK_POLLING_THRESHOLD_MS) {
        const message = err instanceof Error ? err.message : String(err);
        await markFailed(
          tx,
          post,
          `Consulta de status do container falhou repetidamente por 30+ minutos: ${message}`,
          post.attempts + 1,
          result
        );
      } else {
        console.warn(
          `[Agendados] falha ao consultar status do container (post ${post.id}), tentando de novo no próximo tick:`,
          err
        );
      }
      continue;
    }

    if (statusCode === "PUBLISHED") {
      // media_publish from an earlier tick landed on Meta's side but this
      // row never found out (its response was lost). Never call
      // media_publish again for this container.
      await handlePublishedContainer(tx, post, accessToken, now, result, "PREPARING");
      continue;
    }
    if (statusCode === "IN_PROGRESS") continue; // still processing, try again next minute
    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      await handleContainerFailure(tx, post, new Error(`Container do Instagram voltou ${statusCode}`), result);
      continue;
    }
    if (statusCode !== "FINISHED") continue; // unexpected code — wait for a clearer one

    // Fail open on a quota-check error: better to attempt the publish (which
    // itself would surface a real Meta rate-limit error) than to stall a
    // ready post indefinitely because the limit endpoint hiccuped.
    const limit = await getContentPublishingLimit(
      accessToken,
      post.instagramAccount.instagramId
    ).catch(() => null);
    if (limit && limit.quota_usage >= limit.config.quota_total) {
      result.deferredQuota += 1;
      console.warn(
        `[Agendados] cota de publicação cheia para @${post.instagramAccount.username} (${limit.quota_usage}/${limit.config.quota_total}), adiando post ${post.id}`
      );
      continue;
    }

    // Conditional claim, guarded by containerId too: only the tick that saw
    // this exact FINISHED container gets to call media_publish for it.
    const claimed = await tx.scheduledPost.updateMany({
      where: { id: post.id, status: "PREPARING", containerId: post.containerId, mediaId: null },
      data: { status: "PUBLISHING" },
    });
    if (claimed.count === 0) continue;

    try {
      const published = await publishMediaContainer(
        accessToken,
        post.instagramAccount.instagramId,
        post.containerId
      );

      // Bloqueador 1: mediaId is written the instant Meta confirms — before
      // the permalink fetch — because this is the irreversible step. If the
      // process dies right after this write, the post already reads as
      // PUBLISHED, so no later tick can call media_publish again for it.
      const claim = await tx.scheduledPost.updateMany({
        where: { id: post.id, status: "PUBLISHING", containerId: post.containerId },
        data: { status: "PUBLISHED", mediaId: published.id, publishedAt: now, errorMessage: null },
      });

      if (claim.count === 1) {
        result.published += 1;
        const permalink = await getMediaPermalink(accessToken, published.id).catch(() => null);
        if (permalink?.permalink) {
          await tx.scheduledPost.updateMany({
            where: { id: post.id, mediaId: published.id },
            data: { permalink: permalink.permalink },
          });
        }
        // else: left null, backfilled by backfillMissingPermalinks below.
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (isExplicit4xxMetaError(err)) {
        // A clean rejection from Meta — but that alone doesn't prove nothing
        // happened, so re-check the container before treating it as safe to
        // retry from PREPARING.
        let recheckStatus: ContainerStatusCode | null = null;
        try {
          recheckStatus = (await getContainerStatus(accessToken, post.containerId)).status_code;
        } catch {
          recheckStatus = null;
        }

        if (recheckStatus === "PUBLISHED") {
          await handlePublishedContainer(tx, post, accessToken, now, result, "PUBLISHING");
        } else if (recheckStatus === "FINISHED") {
          await tx.scheduledPost.updateMany({
            where: { id: post.id, status: "PUBLISHING", containerId: post.containerId },
            data: { status: "PREPARING", errorMessage: message },
          });
        }
        // Anything else (recheck failed, or an unexpected code): stays in
        // PUBLISHING — reconcileStuckPublishing resolves it once it's stale.
        continue;
      }

      // Bloqueador 4: ambiguous failure (network error, timeout, invalid
      // JSON, 5xx) — media_publish may have gone through on Meta's side
      // despite the error. Do NOT revert to PREPARING (that risks a second
      // media_publish against the same container). Leave it in PUBLISHING;
      // reconcileStuckPublishing resolves it by checking the container
      // directly once it's had time to settle.
      console.warn(
        `[Agendados] media_publish ambíguo para post ${post.id} (mantido em PUBLISHING p/ reconciliação):`,
        message
      );
    }
  }
}

/** PUBLISHED rows missing a permalink (the fetch after media_publish failed)
 * get one retry per tick — best-effort, never blocks anything else. */
async function backfillMissingPermalinks(
  tx: Db,
  now: Date,
  result: PublishScheduledResult
): Promise<void> {
  const cutoff = new Date(now.getTime() - CLEANUP_PUBLISHED_AFTER_MS);
  const missing = await tx.scheduledPost.findMany({
    where: { status: "PUBLISHED", mediaId: { not: null }, permalink: null, publishedAt: { gte: cutoff } },
    include: { instagramAccount: true },
    take: 10,
  });

  for (const post of missing) {
    if (post.instagramAccount.provider !== "META" || !post.mediaId) continue;
    try {
      const accessToken = decryptToken(post.instagramAccount.accessToken);
      const permalink = await getMediaPermalink(accessToken, post.mediaId);
      if (permalink.permalink) {
        await tx.scheduledPost.updateMany({
          where: { id: post.id, mediaId: post.mediaId },
          data: { permalink: permalink.permalink },
        });
      }
    } catch (err) {
      console.warn(`[Agendados] backfill de permalink falhou para ${post.id}:`, err);
    }
  }
  void result; // reserved for future counting; not a required metric today
}

// --- Phase 3: reconcile stuck PUBLISHING rows -------------------------------

/**
 * Bloqueador 6: a row can be stuck in PUBLISHING if the process died right
 * after the claim (before or during the media_publish call) or if a
 * media_publish response was lost. Rather than poll it every tick forever,
 * only rows untouched for 3+ minutes are checked — the container is the
 * single source of truth for what actually happened. This NEVER recreates a
 * container directly (that only happens from PREPARING, via
 * handleContainerFailure) — ERROR/EXPIRED here goes straight to FAILED.
 */
async function reconcileStuckPublishing(
  tx: Db,
  now: Date,
  result: PublishScheduledResult
): Promise<void> {
  const staleBefore = new Date(now.getTime() - RECONCILE_STUCK_PUBLISHING_AFTER_MS);
  const stuck = await tx.scheduledPost.findMany({
    where: { status: "PUBLISHING", updatedAt: { lte: staleBefore } },
    include: { instagramAccount: true },
    take: 20,
  });

  for (const post of stuck) {
    if (!post.containerId) {
      await markFailed(tx, post, "Preso em PUBLISHING sem containerId", post.attempts + 1, result);
      continue;
    }

    const accessToken = await decryptOrFail(tx, post, result);
    if (accessToken === null) continue;

    let statusCode: ContainerStatusCode;
    try {
      statusCode = (await getContainerStatus(accessToken, post.containerId)).status_code;
    } catch (err) {
      // Still ambiguous — leave it for the next reconciliation pass. Do not
      // recreate, do not fail (yet); a genuinely dead post is eventually
      // caught because updatedAt keeps getting further in the past... but to
      // avoid an infinite silent stall, escalate after it's been stuck 10x
      // the reconcile window.
      if (now.getTime() - post.updatedAt.getTime() >= RECONCILE_STUCK_PUBLISHING_AFTER_MS * 10) {
        const message = err instanceof Error ? err.message : String(err);
        await markFailed(
          tx,
          post,
          `Preso em PUBLISHING e consulta de status seguiu falhando: ${message}`,
          post.attempts + 1,
          result
        );
      }
      continue;
    }

    if (statusCode === "PUBLISHED") {
      await handlePublishedContainer(tx, post, accessToken, now, result, "PUBLISHING");
      result.reconciled += 1;
    } else if (statusCode === "FINISHED") {
      // media_publish never actually landed — safe to let the next publish
      // pass try again with the same (still valid) container.
      const updated = await tx.scheduledPost.updateMany({
        where: { id: post.id, status: "PUBLISHING", containerId: post.containerId },
        data: { status: "PREPARING", errorMessage: "Reconciliado: container FINISHED sem publicação confirmada" },
      });
      if (updated.count === 1) result.reconciled += 1;
    } else if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      await markFailed(
        tx,
        post,
        `Preso em PUBLISHING; container voltou ${statusCode} na reconciliação`,
        post.attempts + 1,
        result
      );
      result.reconciled += 1;
    }
    // IN_PROGRESS: unexpected for a container that was FINISHED when
    // media_publish was called, but just wait — no action needed.
  }
}

// --- Phase 4: disk cleanup ---------------------------------------------------

async function cleanupPublishedFiles(tx: Db, now: Date, result: PublishScheduledResult): Promise<void> {
  const cutoff = new Date(now.getTime() - CLEANUP_PUBLISHED_AFTER_MS);
  await cleanupFilesFor(tx, result, {
    status: "PUBLISHED",
    publishedAt: { lte: cutoff },
    OR: [{ storagePaths: { isEmpty: false } }, { coverPath: { not: null } }],
  });
}

async function cleanupAbandonedFiles(tx: Db, now: Date, result: PublishScheduledResult): Promise<void> {
  const cutoff = new Date(now.getTime() - CLEANUP_FAILED_OR_CANCELED_AFTER_MS);
  await cleanupFilesFor(tx, result, {
    status: { in: ["FAILED", "CANCELED"] },
    updatedAt: { lte: cutoff },
    OR: [{ storagePaths: { isEmpty: false } }, { coverPath: { not: null } }],
  });
}

async function cleanupFilesFor(
  tx: Db,
  result: PublishScheduledResult,
  where: Prisma.ScheduledPostWhereInput
): Promise<void> {
  const toClean = await tx.scheduledPost.findMany({
    where,
    select: { id: true, storagePaths: true, coverPath: true },
    take: 50,
  });

  for (const post of toClean) {
    const filenames = [...post.storagePaths, ...(post.coverPath ? [post.coverPath] : [])];
    try {
      await deleteMediaFiles(filenames);
      // contentHash is deliberately left untouched (bloqueador 3 / dedup):
      // the file is gone, but its hash must keep blocking a re-schedule of
      // the same content indefinitely.
      await tx.scheduledPost.update({
        where: { id: post.id },
        data: { storagePaths: [], coverPath: null },
      });
      result.cleaned += 1;
    } catch (err) {
      console.error(`[Agendados] limpeza de arquivos falhou para ${post.id}:`, err);
    }
  }
}

/** Files on disk older than 48h that no active (SCHEDULED/PREPARING/
 * PUBLISHING) post references — an upload that never became a post, or a
 * leftover from a bug. PUBLISHED/FAILED/CANCELED posts' own files are
 * handled by the two functions above, by post id, not by this sweep. */
async function cleanupOrphanFiles(tx: Db, now: Date, result: PublishScheduledResult): Promise<void> {
  const active = await tx.scheduledPost.findMany({
    where: { status: { in: ["SCHEDULED", "PREPARING", "PUBLISHING"] } },
    select: { storagePaths: true, coverPath: true },
  });
  const referenced = new Set<string>();
  for (const post of active) {
    for (const p of post.storagePaths) referenced.add(p);
    if (post.coverPath) referenced.add(post.coverPath);
  }

  const files = await listMediaFiles();
  const orphanCutoff = now.getTime() - ORPHAN_FILE_AFTER_MS;
  const orphans = files
    .filter((f) => !referenced.has(f.filename) && f.mtimeMs <= orphanCutoff)
    .map((f) => f.filename);

  if (orphans.length === 0) return;
  await deleteMediaFiles(orphans);
  result.orphansDeleted += orphans.length;
}

// --- Entry point -------------------------------------------------------------

export type PublishScheduledCronResult = LockResult<PublishScheduledResult>;

/** See lib/scheduled-posts/advisory-lock.ts for the full rationale behind
 * how the global lock (bloqueador 7) is implemented. */
export async function runPublishScheduledCron(
  now: Date = new Date()
): Promise<PublishScheduledCronResult> {
  return withAdvisoryLock(async () => {
    const result = emptyResult();
    await prepareDuePosts(prisma, now, result);
    await publishReadyPosts(prisma, now, result);
    await reconcileStuckPublishing(prisma, now, result);
    await backfillMissingPermalinks(prisma, now, result);
    await cleanupPublishedFiles(prisma, now, result);
    await cleanupAbandonedFiles(prisma, now, result);
    await cleanupOrphanFiles(prisma, now, result);
    return result;
  });
}
