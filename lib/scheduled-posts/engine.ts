import { randomUUID } from "node:crypto";
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
import {
  createZernioPost,
  getZernioPost,
  listZernioPosts,
  type TikTokSettingsPayload,
  type YoutubePlatformSpecificData,
  type ZernioPlatformName,
  type ZernioPost,
} from "@/lib/zernio/client";
import { getZernioApiKey } from "@/lib/env";
import { tikTokSettingsSchema, youtubeSettingsSchema } from "@/lib/scheduled-posts/schema";
import { deleteMediaFiles, listMediaFiles } from "@/lib/storage/media";
import {
  sendPublishFailureAlert,
  sendPublishWarningAlert,
  sendZernioPublishFailureAlert,
  sendZernioPublishWarningAlert,
} from "@/lib/email/alert";
import { withAdvisoryLock, type LockHandle, type LockResult } from "@/lib/scheduled-posts/advisory-lock";
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
 * id, status: <exact status this call observed>, containerId: <containerId
 * this call observed> } })`, checking `count === 1`. That — plus never
 * calling a one-way Meta endpoint (media_publish) twice for the same
 * containerId — is what makes this safe against two overlapping cron ticks,
 * a crash mid-tick, or a lost HTTP response from Meta. The status match is
 * intentionally exact (not `{ in: [...] }`): each call site knows precisely
 * what status its own row transition just put (or found) the row in, and
 * matching anything looser would let a stale caller "succeed" at writing
 * over a state a different, newer tick already moved the row past (Rodada 3,
 * achado 2 — see reconcileStuckPublishing below for the scenario this closes).
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
// A file on disk that no ScheduledPost row (of any status) references
// (upload that was never turned into a post, or left behind by a bug) is
// swept after this long — long enough that an upload in progress from the
// panel is never at risk.
const ORPHAN_FILE_AFTER_MS = 48 * 60 * 60 * 1000;
// A `.tmp-*` file (an upload that never completed — the process was killed
// mid-stream, or the client hung up) is swept much sooner: it can never be
// referenced by any row (rows only ever get the final, renamed filename), so
// there is no post whose retention it needs to outlive.
const TMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;
// Rodada 3, achado 6: a container's status_code coming back PUBLISHED is
// matched to a `listRecentMedia` item only if that item's own timestamp is
// no older than this many minutes before the row was claimed into
// PUBLISHING — without this, an unrelated older post with the same (or an
// empty) caption could be mismatched.
const RECONCILE_MATCH_SLACK_MS = 2 * 60 * 1000;
// Per-tick caps (bloqueador 11): the rest waits for next minute rather than
// letting one slow tick balloon.
const MAX_PREPARE_PER_TICK = 10;
const MAX_PUBLISH_PER_TICK = 10;
// Rodada 5, achado 4: createZernioPost's own call can take up to its new
// 240s timeout (TikTok/YouTube publishing synchronously inside publishNow) —
// capped much lower than MAX_PUBLISH_PER_TICK so one tick can never balloon
// past the cron's own budget; the rest waits for the next minute.
const MAX_ZERNIO_PUBLISH_PER_TICK = 3;
// Rodada 5, achado 3 (achado 10): slack subtracted from `claimedAt` before
// sending `fromDate` to `listZernioPosts` — wide enough to tolerate a little
// clock skew between this process and Zernio without pulling in unrelated
// history.
const RECONCILE_LIST_FROM_DATE_SLACK_MS = 5 * 60 * 1000;

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

/**
 * Rodada 3, achado 2: thrown when a phase notices (via `lock.isHeld()`)
 * that the advisory-lock connection dropped mid-tick, right before it would
 * otherwise call a one-way Meta endpoint (media_publish) or create a new
 * container. Caught once, at the top of `runPublishScheduledCron` — the
 * safest thing to do on a lost lock is stop touching anything else this
 * tick, since another process may already be running with the lock by now.
 */
class LockLostError extends Error {
  constructor() {
    super("advisory lock lost mid-tick");
  }
}

/** Tolerates a `withAdvisoryLock` test double that (unlike the real
 * implementation) doesn't pass a lock handle to its callback — treated as
 * "assume still held", since those tests are specifically about proving
 * per-statement guards are safe even without any lock at all. */
function asLockHandle(lock: LockHandle | undefined): LockHandle {
  return lock && typeof lock.isHeld === "function" ? lock : { isHeld: () => true };
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

export function emptyResult(): PublishScheduledResult {
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

/**
 * Fase 4 made `ScheduledPost.instagramAccountId` optional (a TIKTOK/YOUTUBE
 * row has none), so Prisma's generated type for `include: { instagramAccount:
 * true }` is now `InstagramAccount | null` everywhere, including in the four
 * Instagram-only queries below — each of which already filters
 * `platform: "INSTAGRAM"` in its `where`, which the database's own CHECK
 * constraint (prisma/migrations/20260928120000_zernio_platforms) guarantees
 * always has a non-null instagramAccountId. This narrows the type back to
 * match that runtime guarantee instead of sprinkling `!` at every call site.
 */
function withInstagramAccount<T extends { instagramAccount: AccountForPublish | null }>(
  rows: T[]
): (T & { instagramAccount: AccountForPublish })[] {
  return rows.map((row) => ({ ...row, instagramAccount: row.instagramAccount as AccountForPublish }));
}

export interface PostForPublish {
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

/**
 * Marks a post FAILED — but only if it is still exactly where this caller
 * last saw it (`fromStatus` + the containerId this caller read). A stale
 * caller (a tick that read the row long ago and is only now getting around
 * to failing it) silently no-ops instead of clobbering a status/containerId
 * a newer tick already moved the row to (Rodada 3, achado 2/R4).
 *
 * `outcomeUncertain` records that we genuinely do not know whether Meta
 * ended up publishing this content before we gave up — set only when a
 * media_publish call (or a row already in PUBLISHING) could not be
 * confirmed one way or the other. The retry/reschedule endpoint
 * (app/api/scheduled-posts/[id]/route.ts) uses this to refuse a blind retry
 * of a post that might already be live (Rodada 3, achado 1).
 */
async function markFailed(
  tx: Db,
  post: PostForPublish,
  message: string,
  attempts: number,
  result: PublishScheduledResult,
  fromStatus: ScheduledPostStatus,
  outcomeUncertain = false
): Promise<void> {
  const updated = await tx.scheduledPost.updateMany({
    where: { id: post.id, status: fromStatus, containerId: post.containerId },
    data: { status: "FAILED", errorMessage: message, attempts, outcomeUncertain },
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
  result: PublishScheduledResult,
  fromStatus: ScheduledPostStatus
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
      result,
      fromStatus
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
 *
 * Every caller reaches this function with the row still in PREPARING (see
 * call sites in prepareDuePosts/publishReadyPosts) — `fromStatus` for its own
 * guarded writes is hardcoded to "PREPARING" for that reason, not threaded
 * in as a parameter.
 */
async function handleContainerFailure(
  tx: Db,
  post: PostForPublish,
  err: unknown,
  result: PublishScheduledResult,
  lock: LockHandle
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const attempts = post.attempts + 1;

  if (attempts >= MAX_ATTEMPTS) {
    await markFailed(tx, post, message, attempts, result, "PREPARING");
    return;
  }

  const accessToken = await decryptOrFail(tx, post, result, "PREPARING");
  if (accessToken === null) return;

  if (!lock.isHeld()) {
    console.warn(
      `[Agendados] lock consultivo caiu — abortando o resto do tick antes de recriar o container do post ${post.id}`
    );
    throw new LockLostError();
  }

  try {
    const created = await createContainerForPost(
      accessToken,
      post.instagramAccount.instagramId,
      post
    );
    await tx.scheduledPost.updateMany({
      where: { id: post.id, status: "PREPARING", containerId: post.containerId },
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
      where: { id: post.id, status: "PREPARING", containerId: post.containerId },
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
 * — it only tries to find the resulting media so the panel can show a
 * permalink.
 *
 * Rodada 3, achado 6: a candidate from `listRecentMedia` only counts if its
 * own `timestamp` is no older than `post.updatedAt` (the moment this row was
 * claimed into PUBLISHING) minus a couple of minutes' slack — without that,
 * an older post that happens to share the same caption (or, if the caption
 * is empty, just happens to be the most recent upload) could be mismatched,
 * stealing its mediaId/permalink. A caption match still requires exactly one
 * candidate in that window; an empty caption never matches by caption at all
 * — it only accepts a single candidate purely by being the only one in the
 * window.
 *
 * If the match is missing or ambiguous, the post is still marked PUBLISHED
 * (republishing would be far worse than a missing permalink) but with
 * `mediaId: null` and an email alert asking a human to fill it in.
 *
 * Exported for reuse by the retry/reschedule endpoint
 * (app/api/scheduled-posts/[id]/route.ts), which runs the exact same
 * reconciliation before ever allowing a retry of a post whose previous
 * outcome is uncertain (Rodada 3, achado 1) — `fromStatus` there is
 * "FAILED" rather than PREPARING/PUBLISHING.
 */
export async function reconcilePublishedContainer(
  tx: Db,
  post: PostForPublish,
  accessToken: string,
  now: Date,
  result: PublishScheduledResult,
  fromStatus: ScheduledPostStatus
): Promise<void> {
  let mediaId: string | null = null;
  let permalink: string | null = null;
  let matchNote = "nenhum candidato em listRecentMedia dentro da janela de tempo";

  const windowStartMs = post.updatedAt.getTime() - RECONCILE_MATCH_SLACK_MS;

  try {
    const recent = await listRecentMedia(accessToken, post.instagramAccount.instagramId, 10);
    const inWindow = recent.filter((m) => new Date(m.timestamp).getTime() >= windowStartMs);

    let candidates = inWindow;
    if (post.caption) {
      candidates = inWindow.filter((m) => (m.caption ?? "") === post.caption);
      if (candidates.length > 1) {
        matchNote = `${candidates.length} candidatos bateram com a legenda dentro da janela de tempo — ambíguo demais para confiar`;
        candidates = [];
      } else if (candidates.length === 0) {
        matchNote = "nenhuma mídia recente na janela de tempo bateu com a legenda";
      }
    } else if (inWindow.length !== 1) {
      matchNote =
        inWindow.length === 0
          ? "legenda vazia e nenhuma mídia na janela de tempo"
          : `legenda vazia e ${inWindow.length} mídias na janela de tempo — ambíguo demais para confiar`;
      candidates = [];
    }
    // Empty caption + exactly one candidate in the window: `candidates` is
    // already `inWindow` (length 1) from the initial assignment above.

    if (candidates.length === 1) {
      mediaId = candidates[0].id;
      permalink = candidates[0].permalink ?? null;
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

async function prepareDuePosts(
  tx: Db,
  now: Date,
  result: PublishScheduledResult,
  lock: LockHandle
): Promise<void> {
  const cutoff = new Date(now.getTime() + PREPARE_WINDOW_MS);

  const due = withInstagramAccount(
    await tx.scheduledPost.findMany({
      where: { status: "SCHEDULED", platform: "INSTAGRAM", scheduledFor: { lte: cutoff } },
      include: { instagramAccount: true },
      take: MAX_PREPARE_PER_TICK,
      orderBy: { scheduledFor: "asc" },
    })
  );

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
        result,
        "PREPARING"
      );
      continue;
    }

    const accessToken = await decryptOrFail(tx, post, result, "PREPARING");
    if (accessToken === null) continue;

    if (!lock.isHeld()) {
      console.warn(
        `[Agendados] lock consultivo caiu — abortando o resto do tick antes de criar o container do post ${post.id}`
      );
      throw new LockLostError();
    }

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
      await handleContainerFailure(tx, post, err, result, lock);
    }
  }
}

// --- Phase 2: publish --------------------------------------------------------

async function publishReadyPosts(
  tx: Db,
  now: Date,
  result: PublishScheduledResult,
  lock: LockHandle
): Promise<void> {
  const preparing = withInstagramAccount(
    await tx.scheduledPost.findMany({
      where: { status: "PREPARING", platform: "INSTAGRAM", scheduledFor: { lte: now }, mediaId: null },
      include: { instagramAccount: true },
      take: MAX_PUBLISH_PER_TICK,
      orderBy: { scheduledFor: "asc" },
    })
  );

  for (const post of preparing) {
    if (post.instagramAccount.provider !== "META") {
      await markFailed(
        tx,
        post,
        "Conta usa o provedor Zernio, que não publica agendados nesta versão — reconecte a conta pela Meta em Configurações.",
        post.attempts,
        result,
        "PREPARING"
      );
      continue;
    }

    if (!post.containerId) {
      await handleContainerFailure(tx, post, new Error("Post sem container preparado"), result, lock);
      continue;
    }

    const accessToken = await decryptOrFail(tx, post, result, "PREPARING");
    if (accessToken === null) continue;

    let statusCode: ContainerStatusCode;
    try {
      const status = await getContainerStatus(accessToken, post.containerId);
      statusCode = status.status_code;
    } catch (err) {
      // Bloqueador 3: a network/Meta exception while polling is NOT grounds
      // to recreate the container — it says nothing about the container
      // itself, only that this one check failed. Just wait for next tick,
      // unless this has been going on so long it needs a human. Nothing was
      // ever published from this path (media_publish is only reached once
      // the container comes back FINISHED below), so the outcome here is
      // never uncertain — it's a plain, safe-to-retry-from-scratch failure.
      if (now.getTime() - post.updatedAt.getTime() >= STUCK_POLLING_THRESHOLD_MS) {
        const message = err instanceof Error ? err.message : String(err);
        await markFailed(
          tx,
          post,
          `Consulta de status do container falhou repetidamente por 30+ minutos: ${message}`,
          post.attempts + 1,
          result,
          "PREPARING"
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
      await reconcilePublishedContainer(tx, post, accessToken, now, result, "PREPARING");
      continue;
    }
    if (statusCode === "IN_PROGRESS") continue; // still processing, try again next minute
    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      await handleContainerFailure(tx, post, new Error(`Container do Instagram voltou ${statusCode}`), result, lock);
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

    if (!lock.isHeld()) {
      // The claim above already landed, so the row is safely parked in
      // PUBLISHING either way — reconcileStuckPublishing (which does not
      // need the lock, it never creates a container or calls media_publish)
      // resolves it later. Stopping here, rather than calling media_publish
      // without confidence the lock is still exclusive, is the whole point.
      console.warn(
        `[Agendados] lock consultivo caiu — abortando antes de publicar o post ${post.id} (fica em PUBLISHING para reconciliação)`
      );
      throw new LockLostError();
    }

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
          await reconcilePublishedContainer(tx, post, accessToken, now, result, "PUBLISHING");
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

// --- Phase 2b: publish (TIKTOK/YOUTUBE via Zernio) --------------------------
//
// Fase 4. A different, simpler shape than the Instagram flow above: Zernio
// has no separate "container" to prepare/poll ahead of time — a single
// `POST /posts` (with `publishNow: true`) both creates and (usually,
// TikTok took ~18s in testing) finishes the publish, so a due SCHEDULED row
// goes straight to PUBLISHING, with no PREPARING step at all.

/** Exported for reuse by app/api/scheduled-posts/[id]/route.ts's
 * checkRetrySafety, which needs to pick out the right `platforms[]` entry
 * from a `GET /posts/{id}` response the same way this module does. */
export function zernioPlatformName(platform: "TIKTOK" | "YOUTUBE"): ZernioPlatformName {
  return platform === "TIKTOK" ? "tiktok" : "youtube";
}

function zernioPlatformLabel(platform: "TIKTOK" | "YOUTUBE"): string {
  return platform === "TIKTOK" ? "TikTok" : "YouTube Shorts";
}

function buildTikTokSettingsPayload(settings: Prisma.JsonValue): TikTokSettingsPayload {
  const parsed = tikTokSettingsSchema.parse(settings);
  return {
    privacy_level: parsed.privacyLevel,
    allow_comment: parsed.allowComment,
    allow_duet: parsed.allowDuet,
    allow_stitch: parsed.allowStitch,
    // The single "revisei o conteúdo e concordo com a Music Usage
    // Confirmation" checkbox in the panel feeds both TikTok fields.
    content_preview_confirmed: parsed.consentGiven,
    express_consent_given: parsed.consentGiven,
  };
}

function buildYoutubeSpecificDataPayload(settings: Prisma.JsonValue): YoutubePlatformSpecificData {
  const parsed = youtubeSettingsSchema.parse(settings);
  return { title: parsed.title, visibility: parsed.visibility, madeForKids: parsed.madeForKids };
}

/**
 * Same shape as `markFailed` above (guarded exact-status + a one-way-call
 * identifier — `zernioPostId` here instead of `containerId`), for the same
 * reason: a stale tick that reads this row long before it fails it must not
 * clobber a status/zernioPostId a newer tick already moved the row past.
 */
async function markZernioFailed(
  tx: Db,
  post: Pick<
    Prisma.ScheduledPostGetPayload<object>,
    "id" | "workspaceId" | "platform" | "zernioPostId" | "attempts"
  >,
  message: string,
  attempts: number,
  result: PublishScheduledResult,
  fromStatus: ScheduledPostStatus,
  outcomeUncertain = false
): Promise<void> {
  const updated = await tx.scheduledPost.updateMany({
    where: { id: post.id, status: fromStatus, zernioPostId: post.zernioPostId },
    data: { status: "FAILED", errorMessage: message, attempts, outcomeUncertain },
  });
  if (updated.count === 0) return;

  result.failed += 1;
  await sendZernioPublishFailureAlert({
    workspaceId: post.workspaceId,
    scheduledPostId: post.id,
    platform: zernioPlatformLabel(post.platform as "TIKTOK" | "YOUTUBE"),
    errorMessage: message,
  });
}

/**
 * Applies the `platforms[]` entry from a fresh `POST /posts`/`GET
 * /posts/{id}` response to the row — shared by the initial publish call, the
 * polling reconciliation below, AND `checkRetrySafety` in
 * app/api/scheduled-posts/[id]/route.ts (which calls this with
 * `fromStatus: "FAILED"` the same way Instagram's own
 * `reconcilePublishedContainer` is reused there), since all three see the
 * same response shape and must resolve it the same way.
 */
export async function applyZernioPlatformResult(
  tx: Db,
  post: Prisma.ScheduledPostGetPayload<object>,
  zernioPostId: string,
  platformResult: NonNullable<ZernioPost["platforms"]>[number] | undefined,
  now: Date,
  result: PublishScheduledResult,
  fromStatus: ScheduledPostStatus = "PUBLISHING"
): Promise<"published" | "failed" | "pending"> {
  if (platformResult?.status === "published") {
    const updated = await tx.scheduledPost.updateMany({
      where: { id: post.id, status: fromStatus, zernioPostId },
      data: {
        status: "PUBLISHED",
        permalink: platformResult.platformPostUrl,
        publishedAt: now,
        errorMessage: null,
      },
    });
    if (updated.count === 1) result.published += 1;
    return "published";
  }

  if (platformResult?.status === "failed") {
    await markZernioFailed(
      tx,
      { ...post, zernioPostId },
      platformResult.errorMessage ?? "Falha reportada pela Zernio",
      post.attempts + 1,
      result,
      fromStatus
    );
    return "failed";
  }

  return "pending"; // still processing — reconcileZernioPublishing polls it next tick(s)
}

async function publishZernioReadyPosts(
  tx: Db,
  now: Date,
  result: PublishScheduledResult,
  lock: LockHandle
): Promise<void> {
  const apiKey = getZernioApiKey();

  const due = await tx.scheduledPost.findMany({
    where: { status: "SCHEDULED", platform: { in: ["TIKTOK", "YOUTUBE"] }, scheduledFor: { lte: now } },
    take: MAX_ZERNIO_PUBLISH_PER_TICK,
    orderBy: { scheduledFor: "asc" },
  });

  for (const post of due) {
    // Rodada 5, achado 2: the idempotency key is generated HERE, in the same
    // conditional write that claims SCHEDULED->PUBLISHING — not derived from
    // `attempts` (which a retry/reschedule resets to 0, silently reviving a
    // key that has been dead in Zernio's 24h idempotency window for a day).
    // `claimedAt` is written in the same call (achado 3): it — not
    // `updatedAt`, which on a FAILED row is the moment of failure — is what
    // the reconciliation window below is measured from.
    const newIdempotencyKey = randomUUID();
    const claimed = await tx.scheduledPost.updateMany({
      where: { id: post.id, status: "SCHEDULED" },
      data: { status: "PUBLISHING", zernioIdempotencyKey: newIdempotencyKey, claimedAt: now },
    });
    if (claimed.count === 0) continue;

    if (!apiKey || !post.zernioAccountId) {
      await markZernioFailed(
        tx,
        post,
        "Zernio não configurado (ZERNIO_API_KEY ou a conta da plataforma ausente no ambiente) — reconfigure e reagende.",
        post.attempts + 1,
        result,
        "PUBLISHING"
      );
      continue;
    }

    let tiktokSettings: TikTokSettingsPayload | undefined;
    let youtubeSpecificData: YoutubePlatformSpecificData | undefined;
    try {
      if (post.platform === "TIKTOK") tiktokSettings = buildTikTokSettingsPayload(post.platformSettings);
      if (post.platform === "YOUTUBE") youtubeSpecificData = buildYoutubeSpecificDataPayload(post.platformSettings);
    } catch (err) {
      // Not transient (bad/missing platformSettings on the row itself) —
      // straight to FAILED, same reasoning as decryptOrFail for Instagram.
      const message = err instanceof Error ? err.message : String(err);
      await markZernioFailed(tx, post, `Configuração da plataforma inválida: ${message}`, post.attempts + 1, result, "PUBLISHING");
      continue;
    }

    if (!lock.isHeld()) {
      console.warn(
        `[Agendados] lock consultivo caiu — abortando antes de publicar (Zernio) o post ${post.id} (fica em PUBLISHING para reconciliação)`
      );
      throw new LockLostError();
    }

    let zpost: ZernioPost;
    try {
      zpost = await createZernioPost(
        apiKey,
        {
          content: post.caption,
          mediaUrl: post.mediaUrls[0],
          platform: zernioPlatformName(post.platform as "TIKTOK" | "YOUTUBE"),
          accountId: post.zernioAccountId,
          tiktokSettings,
          youtubeSpecificData,
          // Rodada 5, achado 3: lets reconcileZernioByList match a lost
          // response back to this exact row by id, instead of only by the
          // fuzzier content+media+time-window heuristic.
          metadata: { scheduledPostId: post.id, claimKey: newIdempotencyKey },
        },
        newIdempotencyKey
      );
    } catch (err) {
      if (isExplicit4xxMetaError(err)) {
        // A clean, synchronous rejection from Zernio itself, before it ever
        // dispatched to TikTok/YouTube — certain nothing was posted.
        const message = err instanceof Error ? err.message : String(err);
        await markZernioFailed(tx, post, message, post.attempts + 1, result, "PUBLISHING");
      } else {
        // Network error, timeout, 5xx, invalid JSON: ambiguous — the POST
        // may have landed on Zernio's side despite the error. Never repeat
        // it; leave the row in PUBLISHING (no zernioPostId), resolved later
        // by reconcileZernioPublishing's list-based search.
        console.warn(
          `[Agendados] POST /posts (Zernio) ambíguo para post ${post.id} (mantido em PUBLISHING p/ reconciliação):`,
          err instanceof Error ? err.message : err
        );
      }
      continue;
    }

    // zernioPostId gravado IMEDIATAMENTE — before even looking at whether
    // TikTok/YouTube itself finished publishing — so no later tick can ever
    // call POST /posts again for this row.
    const claimedId = await tx.scheduledPost.updateMany({
      where: { id: post.id, status: "PUBLISHING", zernioPostId: null },
      data: { zernioPostId: zpost._id },
    });
    if (claimedId.count === 0) continue; // a stale tick — another already resolved this row

    // Rodada 5, achado 2: a repeated/idempotent response can come back
    // without `platforms` at all — `?? []` plus `.find` (never `?? [0]`)
    // means "no entry for our platform" resolves to `undefined`, which
    // applyZernioPlatformResult already treats as "pending" (poll again next
    // tick), never as an exception.
    const platformResult = (zpost.platforms ?? []).find(
      (p) => p.platform === zernioPlatformName(post.platform as "TIKTOK" | "YOUTUBE")
    );
    await applyZernioPlatformResult(tx, post, zpost._id, platformResult, now, result);
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
  const missing = withInstagramAccount(
    await tx.scheduledPost.findMany({
      where: { status: "PUBLISHED", platform: "INSTAGRAM", mediaId: { not: null }, permalink: null, publishedAt: { gte: cutoff } },
      include: { instagramAccount: true },
      take: 10,
    })
  );

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

/** Rodada 5, achado 7: `backfillMissingPermalinks` above only ever looked at
 * INSTAGRAM rows — a TikTok/YouTube post whose `POST /posts` response landed
 * without `platformPostUrl` yet (Zernio's own doc: it comes back `null` right
 * after publishing, `GET /posts/{id}` is what eventually has it) never got a
 * link filled in. Best-effort, capped at 5/tick, same as the Instagram
 * version never blocking anything else. */
async function backfillMissingZernioPermalinks(
  tx: Db,
  now: Date,
  result: PublishScheduledResult
): Promise<void> {
  const apiKey = getZernioApiKey();
  if (!apiKey) return;

  const cutoff = new Date(now.getTime() - CLEANUP_PUBLISHED_AFTER_MS);
  const missing = await tx.scheduledPost.findMany({
    where: {
      status: "PUBLISHED",
      platform: { in: ["TIKTOK", "YOUTUBE"] },
      zernioPostId: { not: null },
      permalink: null,
      publishedAt: { gte: cutoff },
    },
    take: 5,
  });

  for (const post of missing) {
    if (!post.zernioPostId) continue;
    try {
      const remote = await getZernioPost(apiKey, post.zernioPostId);
      const platformName = zernioPlatformName(post.platform as "TIKTOK" | "YOUTUBE");
      const platformResult = (remote.platforms ?? []).find((p) => p.platform === platformName);
      if (platformResult?.platformPostUrl) {
        await tx.scheduledPost.updateMany({
          where: { id: post.id, zernioPostId: post.zernioPostId },
          data: { permalink: platformResult.platformPostUrl },
        });
      }
    } catch (err) {
      console.warn(`[Agendados] backfill de permalink (Zernio) falhou para ${post.id}:`, err);
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
 * handleContainerFailure) — ERROR/EXPIRED here goes straight to FAILED. This
 * phase never creates a container or calls media_publish itself, so it does
 * not need the advisory-lock handle the way prepareDuePosts/publishReadyPosts
 * do.
 *
 * Rodada 3, achado 2 (R4): every markFailed call below passes the EXACT
 * status ("PUBLISHING") and containerId this function itself just read for
 * this row. If a concurrent tick has, in the meantime, already resolved the
 * row (e.g. media_publish finally landed and wrote PUBLISHED), that guard
 * makes this call a safe no-op instead of overwriting a real publish with
 * FAILED.
 */
async function reconcileStuckPublishing(
  tx: Db,
  now: Date,
  result: PublishScheduledResult
): Promise<void> {
  const staleBefore = new Date(now.getTime() - RECONCILE_STUCK_PUBLISHING_AFTER_MS);
  const stuck = withInstagramAccount(
    await tx.scheduledPost.findMany({
      where: { status: "PUBLISHING", platform: "INSTAGRAM", updatedAt: { lte: staleBefore } },
      include: { instagramAccount: true },
      take: 20,
    })
  );

  for (const post of stuck) {
    if (!post.containerId) {
      await markFailed(tx, post, "Preso em PUBLISHING sem containerId", post.attempts + 1, result, "PUBLISHING");
      continue;
    }

    const accessToken = await decryptOrFail(tx, post, result, "PUBLISHING");
    if (accessToken === null) continue;

    let statusCode: ContainerStatusCode;
    try {
      statusCode = (await getContainerStatus(accessToken, post.containerId)).status_code;
    } catch (err) {
      // Still ambiguous — leave it for the next reconciliation pass. Do not
      // recreate, do not fail (yet); a genuinely dead post is eventually
      // caught because updatedAt keeps getting further in the past... but to
      // avoid an infinite silent stall, escalate after it's been stuck 10x
      // the reconcile window. At that point we genuinely cannot tell whether
      // Meta ever published this — outcomeUncertain records exactly that,
      // so retry/reschedule refuses to blindly recreate the container.
      if (now.getTime() - post.updatedAt.getTime() >= RECONCILE_STUCK_PUBLISHING_AFTER_MS * 10) {
        const message = err instanceof Error ? err.message : String(err);
        await markFailed(
          tx,
          post,
          `Preso em PUBLISHING e consulta de status seguiu falhando: ${message}`,
          post.attempts + 1,
          result,
          "PUBLISHING",
          true
        );
      }
      continue;
    }

    if (statusCode === "PUBLISHED") {
      await reconcilePublishedContainer(tx, post, accessToken, now, result, "PUBLISHING");
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
      // A confirmed, explicit status from Meta: we KNOW this was not
      // published, so the outcome is certain — safe to retry from scratch.
      await markFailed(
        tx,
        post,
        `Preso em PUBLISHING; container voltou ${statusCode} na reconciliação`,
        post.attempts + 1,
        result,
        "PUBLISHING"
      );
      result.reconciled += 1;
    }
    // IN_PROGRESS: unexpected for a container that was FINISHED when
    // media_publish was called, but just wait — no action needed.
  }
}

// --- Phase 3b: reconcile PUBLISHING rows (TIKTOK/YOUTUBE via Zernio) -------

/**
 * A row with no `zernioPostId` can only mean the `POST /posts` call itself
 * was ambiguous (publishZernioReadyPosts left it in PUBLISHING without one).
 * There is no container to poll here — the only way back is `GET /posts`
 * (list), matched by content + media URL + the same claim-moment time
 * window Instagram's own reconciliation uses (RECONCILE_MATCH_SLACK_MS).
 * Not verified against the real Zernio API (see lib/zernio/client.ts) —
 * every failure mode (endpoint doesn't support this filter, unexpected
 * shape, network error) is treated identically to "couldn't reconcile this
 * tick", never as proof the post doesn't exist. Returns `true` once the row
 * has been resolved (PUBLISHED or FAILED) — the caller stops treating it as
 * stuck either way.
 */
/**
 * Exported for reuse by `checkRetrySafety` in
 * app/api/scheduled-posts/[id]/route.ts, the same way Instagram's
 * `reconcilePublishedContainer` is — called there with `fromStatus:
 * "FAILED"` instead of the cron's own "PUBLISHING", against a row that has
 * no `zernioPostId` to poll directly.
 */
export async function reconcileZernioByList(
  tx: Db,
  post: Prisma.ScheduledPostGetPayload<object>,
  apiKey: string,
  now: Date,
  result: PublishScheduledResult,
  fromStatus: ScheduledPostStatus = "PUBLISHING"
): Promise<"published" | "failed" | "pending"> {
  if (!post.zernioAccountId) return "pending";

  // Rodada 5, achado 3: the window (and the `fromDate` sent to the API) is
  // measured from the CLAIM moment (`claimedAt`), never `updatedAt` — on a
  // FAILED row `updatedAt` is the moment of failure, which is always AFTER
  // the claim and would wrongly exclude the very post being searched for.
  // `claimedAt` is only ever null for a row claimed before this column
  // existed (never happened in production — the migration was never
  // applied); `updatedAt` is kept as a defensive fallback for that case.
  const claimedAt = post.claimedAt ?? post.updatedAt;
  const windowStartMs = claimedAt.getTime() - RECONCILE_MATCH_SLACK_MS;
  const fromDate = new Date(claimedAt.getTime() - RECONCILE_LIST_FROM_DATE_SLACK_MS);
  const mediaUrl = post.mediaUrls[0];
  const platformName = zernioPlatformName(post.platform as "TIKTOK" | "YOUTUBE");

  let list: ZernioPost[];
  try {
    list = await listZernioPosts(apiKey, { accountId: post.zernioAccountId, limit: 20, fromDate });
  } catch (err) {
    console.warn(`[Agendados] listZernioPosts falhou ao reconciliar o post ${post.id}:`, err);
    return "pending";
  }

  // Rodada 5, achado 3: match FIRST by the `metadata.scheduledPostId` this
  // row's own POST sent — exact and unambiguous. Only fall back to the
  // fuzzier content+media+time-window heuristic (Rodada 3's original design)
  // when metadata is absent or matches nothing, since `metadata` on the list
  // response is not confirmed by the docs (see lib/zernio/client.ts).
  let match = list.find((p) => p.metadata?.scheduledPostId === post.id);

  if (!match) {
    const candidates = list.filter((p) => {
      const createdMs = p.createdAt ? new Date(p.createdAt).getTime() : NaN;
      if (!Number.isFinite(createdMs) || createdMs < windowStartMs) return false;
      const contentMatches = (p.content ?? "") === post.caption;
      const mediaMatches = (p.mediaItems ?? []).some((m) => m.url === mediaUrl);
      return contentMatches && mediaMatches;
    });
    // 0 candidates: not found (yet, or ever — Zernio's own retention on this
    // listing is unknown). 2+: ambiguous, same as Instagram's own reconcile —
    // safer to keep waiting than to guess. Either way, not resolved this tick.
    if (candidates.length !== 1) return "pending";
    match = candidates[0];
  }

  // Rodada 5, achado 3 (achado 10): match ONLY the exact platform-name entry
  // — no `?? platforms[0]` fallback. A missing entry is "still pending",
  // never "adopt whatever's first".
  const platformResult = (match.platforms ?? []).find((p) => p.platform === platformName);
  // Found the post, but its own platform status is itself still unresolved
  // — nothing to adopt yet, try again next tick.
  if (!platformResult || (platformResult.status !== "published" && platformResult.status !== "failed")) {
    return "pending";
  }

  // Adopt the found id now, so a future tick (if this one's write below
  // somehow doesn't land) can poll it directly instead of re-running this
  // fuzzier search.
  const claimedId = await tx.scheduledPost.updateMany({
    where: { id: post.id, status: fromStatus, zernioPostId: null },
    data: { zernioPostId: match._id },
  });
  if (claimedId.count === 0) return platformResult.status; // another caller already resolved it

  const outcome = await applyZernioPlatformResult(tx, post, match._id, platformResult, now, result, fromStatus);
  result.reconciled += 1;

  // This recovery path is fuzzier than a direct zernioPostId poll (content +
  // media URL + time window, not an exact id) — worth a human's sanity
  // check even though the row is no longer stuck.
  await sendZernioPublishWarningAlert({
    workspaceId: post.workspaceId,
    scheduledPostId: post.id,
    platform: zernioPlatformLabel(post.platform as "TIKTOK" | "YOUTUBE"),
    message:
      "Resultado recuperado por busca na listagem da Zernio (a resposta do POST original tinha se perdido) — confira se está correto.",
  });

  return outcome;
}

/**
 * Every PUBLISHING row for TIKTOK/YOUTUBE, every tick — unlike Instagram's
 * `reconcileStuckPublishing`, this is not gated by a staleness window at the
 * top: Zernio resolves most posts within seconds to a couple of minutes
 * (TikTok took ~18s in testing), so polling promptly matters. A row that
 * genuinely cannot be resolved (Zernio itself stuck, or the ambiguous-POST
 * case never turning up in the list search) only escalates to
 * FAILED+outcomeUncertain — same threshold and same reasoning as Instagram's
 * own "consulta seguiu falhando" branch — once it has been stuck for
 * `STUCK_POLLING_THRESHOLD_MS`.
 */
async function reconcileZernioPublishing(tx: Db, now: Date, result: PublishScheduledResult): Promise<void> {
  const publishing = await tx.scheduledPost.findMany({
    where: { status: "PUBLISHING", platform: { in: ["TIKTOK", "YOUTUBE"] } },
    take: 20,
  });

  const apiKey = getZernioApiKey();

  for (const post of publishing) {
    const stuckForMs = now.getTime() - post.updatedAt.getTime();

    if (!apiKey) {
      // Rodada 5, achado 8: an early `return` here used to skip the WHOLE
      // loop whenever ZERNIO_API_KEY was missing, leaving every PUBLISHING
      // row stuck forever — despite the old comment's own claim that
      // STUCK_POLLING_THRESHOLD_MS "still eventually escalates" it (it never
      // ran). Now each row keeps being checked against that same 30-minute
      // threshold and escalates to FAILED+outcomeUncertain with an alert;
      // only the reconciliation call itself (which needs the key) is
      // skipped.
      if (stuckForMs >= STUCK_POLLING_THRESHOLD_MS) {
        await markZernioFailed(
          tx,
          post,
          "ZERNIO_API_KEY não configurado — não foi possível reconciliar por 30+ minutos",
          post.attempts + 1,
          result,
          "PUBLISHING",
          true
        );
      }
      continue;
    }

    if (post.zernioPostId) {
      try {
        const remote = await getZernioPost(apiKey, post.zernioPostId);
        const platformName = zernioPlatformName(post.platform as "TIKTOK" | "YOUTUBE");
        // Rodada 5, achado 2: no `?? platforms[0]` — a missing entry for our
        // own platform is "still pending", not "adopt whatever's first".
        const platformResult = (remote.platforms ?? []).find((p) => p.platform === platformName);
        const outcome = await applyZernioPlatformResult(tx, post, post.zernioPostId, platformResult, now, result);
        if (outcome !== "pending") {
          result.reconciled += 1;
        } else if (stuckForMs >= STUCK_POLLING_THRESHOLD_MS) {
          await markZernioFailed(
            tx,
            post,
            `Preso em PUBLISHING (Zernio) além de 30+ minutos; último status: ${platformResult?.status ?? "desconhecido"}`,
            post.attempts + 1,
            result,
            "PUBLISHING",
            true
          );
        }
      } catch (err) {
        if (stuckForMs >= STUCK_POLLING_THRESHOLD_MS) {
          const message = err instanceof Error ? err.message : String(err);
          await markZernioFailed(
            tx,
            post,
            `Consulta de status na Zernio falhou repetidamente por 30+ minutos: ${message}`,
            post.attempts + 1,
            result,
            "PUBLISHING",
            true
          );
        } else {
          console.warn(`[Agendados] GET /posts/{id} (Zernio) falhou para o post ${post.id}, tentando de novo no próximo tick:`, err);
        }
      }
      continue;
    }

    // No zernioPostId: the original POST was ambiguous. Try the fuzzier
    // list-based recovery; only give up (FAILED + outcomeUncertain) once
    // it's been stuck a long while with no confident match.
    let outcome: "published" | "failed" | "pending" = "pending";
    try {
      outcome = await reconcileZernioByList(tx, post, apiKey, now, result);
    } catch (err) {
      console.warn(`[Agendados] reconciliação por listagem (Zernio) falhou para o post ${post.id}:`, err);
    }
    if (outcome === "pending" && stuckForMs >= STUCK_POLLING_THRESHOLD_MS) {
      await markZernioFailed(
        tx,
        post,
        "POST na Zernio ficou ambíguo (resposta original perdida) e não foi possível confirmar pela listagem depois de 30+ minutos",
        post.attempts + 1,
        result,
        "PUBLISHING",
        true
      );
    }
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
    select: { id: true, status: true, storagePaths: true, coverPath: true },
    take: 50,
  });

  for (const post of toClean) {
    const filenames = [...post.storagePaths, ...(post.coverPath ? [post.coverPath] : [])];
    try {
      // Fase 4: the same uploaded file can now be named by more than one
      // ScheduledPost row — one per destination platform, all created from
      // the same upload in the "Novo post" form/CLI batch. Only unlink a
      // filename from disk once no OTHER row (any status, any platform)
      // still names it; a still-referenced filename just has THIS post's own
      // pointer cleared below, exactly as before Fase 4. (The scenario this
      // closes: an Instagram post published 2 days ago and a TikTok post of
      // the same file scheduled for tomorrow — the Instagram row's own 24h
      // retention is up, but the file must survive until TikTok publishes
      // and its own retention passes too.)
      const stillReferencedBy =
        filenames.length === 0
          ? []
          : await tx.scheduledPost.findMany({
              where: {
                id: { not: post.id },
                OR: [{ storagePaths: { hasSome: filenames } }, { coverPath: { in: filenames } }],
              },
              select: { storagePaths: true, coverPath: true },
            });
      const stillProtected = new Set<string>();
      for (const other of stillReferencedBy) {
        for (const f of other.storagePaths) if (filenames.includes(f)) stillProtected.add(f);
        if (other.coverPath && filenames.includes(other.coverPath)) stillProtected.add(other.coverPath);
      }
      const toDelete = filenames.filter((f) => !stillProtected.has(f));
      if (toDelete.length > 0) await deleteMediaFiles(toDelete);

      // Guarded by the exact status this query just found the row in
      // (Rodada 3, achado 4): a post retried/rescheduled between the read
      // above and this write is no longer PUBLISHED/FAILED/CANCELED, so this
      // no-ops instead of wiping storagePaths out from under a post that is
      // active again.
      //
      // contentHash is deliberately left untouched either way (bloqueador 3
      // / dedup): the file is gone, but its hash must keep blocking a
      // re-schedule of the same content indefinitely.
      await tx.scheduledPost.updateMany({
        where: { id: post.id, status: post.status },
        data: { storagePaths: [], coverPath: null },
      });
      result.cleaned += 1;
    } catch (err) {
      console.error(`[Agendados] limpeza de arquivos falhou para ${post.id}:`, err);
    }
  }
}

/** Files on disk older than 48h that no ScheduledPost row — of ANY status —
 * still references are true orphans: an upload that never became a post, or
 * a leftover from a bug. A post's OWN files, for as long as its row still
 * names them, are never touched here regardless of the post's status or age
 * — cleanupPublishedFiles/cleanupAbandonedFiles are what retire those, each
 * on its own schedule, by clearing storagePaths/coverPath once done (which
 * is exactly what drops them out of the "referenced" set below on the next
 * tick). `.tmp-*` files (uploads that never finished) are swept separately,
 * after a much shorter age, since no row can ever reference one by name. */
async function cleanupOrphanFiles(tx: Db, now: Date, result: PublishScheduledResult): Promise<void> {
  const referenced = new Set<string>();
  const allPosts = await tx.scheduledPost.findMany({
    select: { storagePaths: true, coverPath: true },
  });
  for (const post of allPosts) {
    for (const p of post.storagePaths) referenced.add(p);
    if (post.coverPath) referenced.add(post.coverPath);
  }

  const files = await listMediaFiles();
  const orphanCutoff = now.getTime() - ORPHAN_FILE_AFTER_MS;
  const tmpCutoff = now.getTime() - TMP_FILE_MAX_AGE_MS;
  const toDelete = files
    .filter((f) =>
      f.isTmp ? f.mtimeMs <= tmpCutoff : !referenced.has(f.filename) && f.mtimeMs <= orphanCutoff
    )
    .map((f) => f.filename);

  if (toDelete.length === 0) return;
  await deleteMediaFiles(toDelete);
  result.orphansDeleted += toDelete.length;
}

// --- Entry point -------------------------------------------------------------

export type PublishScheduledCronResult = LockResult<PublishScheduledResult>;

/** See lib/scheduled-posts/advisory-lock.ts for the full rationale behind
 * how the global lock (bloqueador 7) is implemented, and `LockLostError`
 * above for what happens if it drops mid-tick. */
export async function runPublishScheduledCron(
  now: Date = new Date()
): Promise<PublishScheduledCronResult> {
  return withAdvisoryLock(async (lockArg) => {
    const lock = asLockHandle(lockArg);
    const result = emptyResult();
    try {
      // Rodada 5, achado 4: Instagram's own two phases run BEFORE Zernio's —
      // on purpose. createZernioPost can now take up to 240s (see
      // ZERNIO_CREATE_POST_TIMEOUT_MS), and MAX_ZERNIO_PUBLISH_PER_TICK caps
      // it at 3 posts/tick so a slow Zernio call never eats the whole
      // minute — but running Instagram first either way means a slow/absent
      // Zernio never delays Instagram's own publish-scheduled work within
      // the same tick.
      await prepareDuePosts(prisma, now, result, lock);
      await publishReadyPosts(prisma, now, result, lock);
      await publishZernioReadyPosts(prisma, now, result, lock);
      await reconcileStuckPublishing(prisma, now, result);
      await reconcileZernioPublishing(prisma, now, result);
      await backfillMissingPermalinks(prisma, now, result);
      await backfillMissingZernioPermalinks(prisma, now, result);
      await cleanupPublishedFiles(prisma, now, result);
      await cleanupAbandonedFiles(prisma, now, result);
      await cleanupOrphanFiles(prisma, now, result);
    } catch (err) {
      if (err instanceof LockLostError) {
        console.warn(
          "[Agendados] lock consultivo perdido no meio do tick — parando por aqui; o que já foi escrito é seguro, o resto espera o próximo tick."
        );
        return result;
      }
      throw err;
    }
    return result;
  });
}
