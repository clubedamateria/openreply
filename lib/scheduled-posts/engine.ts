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
  publishMediaContainer,
} from "@/lib/meta/client";
import { deleteStorageObjects } from "@/lib/storage/supabase";
import { sendPublishFailureAlert } from "@/lib/email/alert";
import type {
  InstagramProvider,
  ScheduledPostMediaType,
} from "@/app/generated/prisma/client";

/**
 * Two-phase publisher for `ScheduledPost`, driven once a minute by
 * `/api/cron/publish-scheduled`. See docs/2026-09-27-agendados-comentarios.md
 * for the full spec.
 *
 * Every state transition goes through a conditional `updateMany({ where: {
 * id, status: <expected> } })`. That is what makes it safe for two overlapping
 * cron ticks (a slow request plus the next minute's) to both look at the same
 * row: only one of them will match the guarded `where` and actually act.
 */

// A post is prepared (container created) once it is within 15 minutes of its
// scheduled time — Reels processing alone can take past a minute, so waiting
// until the exact minute would routinely miss the slot.
const PREPARE_WINDOW_MS = 15 * 60 * 1000;
// ERROR/EXPIRED containers are recreated up to this many times before the
// post is given up on.
const MAX_ATTEMPTS = 3;
// PUBLISHED posts keep their bucket files for a day (permalink screenshots,
// manual re-checks), then the cron deletes them to stay inside Supabase's
// free storage tier.
const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000;

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|m4v)(\?|#|$)/i.test(url);
}

export interface PublishScheduledResult {
  prepared: number;
  published: number;
  failed: number;
  deferredQuota: number;
  cleaned: number;
}

function emptyResult(): PublishScheduledResult {
  return { prepared: 0, published: 0, failed: 0, deferredQuota: 0, cleaned: 0 };
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
  post: PostForPublish,
  message: string,
  attempts: number,
  result: PublishScheduledResult
): Promise<void> {
  const updated = await prisma.scheduledPost.updateMany({
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
 * A container came back ERROR/EXPIRED, or a Meta call around it threw.
 * Recreates the container (fresh containerId, reset child ids) and keeps the
 * post in PREPARING for the next tick to poll — unless attempts are
 * exhausted, in which case it goes straight to FAILED.
 */
async function handleContainerFailure(
  post: PostForPublish,
  err: unknown,
  result: PublishScheduledResult
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const attempts = post.attempts + 1;

  if (attempts >= MAX_ATTEMPTS) {
    await markFailed(post, message, attempts, result);
    return;
  }

  try {
    const accessToken = decryptToken(post.instagramAccount.accessToken);
    const created = await createContainerForPost(
      accessToken,
      post.instagramAccount.instagramId,
      post
    );
    await prisma.scheduledPost.updateMany({
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
    await prisma.scheduledPost.updateMany({
      where: { id: post.id, status: { in: ["PREPARING", "PUBLISHING"] } },
      data: {
        status: "PREPARING",
        attempts,
        errorMessage: `${message}; recriação do container falhou: ${recreateMessage}`,
      },
    });
  }
}

// --- Phase 1: prepare -------------------------------------------------------

async function prepareDuePosts(now: Date, result: PublishScheduledResult): Promise<void> {
  const cutoff = new Date(now.getTime() + PREPARE_WINDOW_MS);

  const due = await prisma.scheduledPost.findMany({
    where: { status: "SCHEDULED", scheduledFor: { lte: cutoff } },
    include: { instagramAccount: true },
  });

  for (const post of due) {
    // Conditional claim: only one overlapping cron tick moves a given post
    // out of SCHEDULED.
    const claimed = await prisma.scheduledPost.updateMany({
      where: { id: post.id, status: "SCHEDULED" },
      data: { status: "PREPARING" },
    });
    if (claimed.count === 0) continue;

    if (post.instagramAccount.provider !== "META") {
      await markFailed(
        post,
        "Conta usa o provedor Zernio, que não publica agendados nesta versão — reconecte a conta pela Meta em Configurações.",
        post.attempts,
        result
      );
      continue;
    }

    try {
      const accessToken = decryptToken(post.instagramAccount.accessToken);
      const created = await createContainerForPost(
        accessToken,
        post.instagramAccount.instagramId,
        post
      );
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: {
          containerId: created.containerId,
          childContainerIds: created.childContainerIds,
        },
      });
      result.prepared += 1;
    } catch (err) {
      await handleContainerFailure(post, err, result);
    }
  }
}

// --- Phase 2: publish --------------------------------------------------------

async function publishReadyPosts(now: Date, result: PublishScheduledResult): Promise<void> {
  const preparing = await prisma.scheduledPost.findMany({
    where: { status: "PREPARING", scheduledFor: { lte: now }, mediaId: null },
    include: { instagramAccount: true },
  });

  for (const post of preparing) {
    if (post.instagramAccount.provider !== "META") {
      await markFailed(
        post,
        "Conta usa o provedor Zernio, que não publica agendados nesta versão — reconecte a conta pela Meta em Configurações.",
        post.attempts,
        result
      );
      continue;
    }

    if (!post.containerId) {
      await handleContainerFailure(post, new Error("Post sem container preparado"), result);
      continue;
    }

    const accessToken = decryptToken(post.instagramAccount.accessToken);

    let statusCode: string;
    try {
      const status = await getContainerStatus(accessToken, post.containerId);
      statusCode = status.status_code;
    } catch (err) {
      await handleContainerFailure(post, err, result);
      continue;
    }

    if (statusCode === "IN_PROGRESS") continue; // still processing, try again next minute
    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      await handleContainerFailure(post, new Error(`Container do Instagram voltou ${statusCode}`), result);
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

    // Conditional claim again, right before the one-way call: mediaId only
    // gets set after this succeeds, so a crash here just leaves the post in
    // PUBLISHING for the next tick to pick back up — it never calls
    // media_publish twice with a mediaId already recorded.
    const claimed = await prisma.scheduledPost.updateMany({
      where: { id: post.id, status: "PREPARING", mediaId: null },
      data: { status: "PUBLISHING" },
    });
    if (claimed.count === 0) continue;

    try {
      const published = await publishMediaContainer(
        accessToken,
        post.instagramAccount.instagramId,
        post.containerId
      );
      const permalink = await getMediaPermalink(accessToken, published.id).catch(
        () => ({ permalink: undefined })
      );

      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: {
          status: "PUBLISHED",
          mediaId: published.id,
          permalink: permalink.permalink ?? null,
          publishedAt: new Date(),
          errorMessage: null,
        },
      });
      result.published += 1;
    } catch (err) {
      // media_publish itself failed. mediaId is still null, so it is safe to
      // go back to PREPARING and let the next tick re-check the (unchanged)
      // container and try media_publish again — no new container needed.
      const message = err instanceof Error ? err.message : String(err);
      await prisma.scheduledPost.updateMany({
        where: { id: post.id, status: "PUBLISHING" },
        data: { status: "PREPARING", errorMessage: message },
      });
    }
  }
}

// --- Phase 3: bucket cleanup -------------------------------------------------

async function cleanupOldPublished(now: Date, result: PublishScheduledResult): Promise<void> {
  const cutoff = new Date(now.getTime() - CLEANUP_AFTER_MS);

  const toClean = await prisma.scheduledPost.findMany({
    where: {
      status: "PUBLISHED",
      publishedAt: { lte: cutoff },
      storagePaths: { isEmpty: false },
    },
    select: { id: true, storagePaths: true },
  });

  for (const post of toClean) {
    try {
      await deleteStorageObjects(post.storagePaths);
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { storagePaths: [] },
      });
      result.cleaned += 1;
    } catch (err) {
      // Best-effort: leftover files cost storage quota, not correctness.
      console.error(`[Agendados] limpeza do bucket falhou para ${post.id}:`, err);
    }
  }
}

export async function runPublishScheduledCron(
  now: Date = new Date()
): Promise<PublishScheduledResult> {
  const result = emptyResult();
  await prepareDuePosts(now, result);
  await publishReadyPosts(now, result);
  await cleanupOldPublished(now, result);
  return result;
}
