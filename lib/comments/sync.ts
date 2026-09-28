/**
 * Comment ingestion for stats (word cloud, campaign keyword performance,
 * recent-comments feed) — independent of the DM/campaign pipeline.
 *
 * Fed from two places, matching docs/2026-09-27-agendados-comentarios.md:
 *  (a) the real-time comment webhook, in `lib/queue/process-webhook.ts`
 *      (`parseCommentEvents` there already drops the account's own comments,
 *      so every event reaching this module is audience-authored);
 *  (b) the daily `/api/cron/sync-comments` backfill, which reads straight
 *      from the Graph API and has to filter the account's own comments
 *      itself via `isOwnAccountComment`.
 *
 * A write failure here is logged and swallowed — it must never take down
 * webhook processing, comment matching, or DM delivery.
 */

import { prisma } from "@/lib/db/client";

export interface InstagramCommentInput {
  commentId: string;
  mediaId: string;
  text: string;
  username?: string | null;
  commentedAt: Date;
  parentId?: string | null;
}

/** True when a comment's author is the connected account itself (id or username match). */
export function isOwnAccountComment({
  authorId,
  authorUsername,
  account,
}: {
  authorId?: string | null;
  authorUsername?: string | null;
  account: { instagramId: string; username: string };
}): boolean {
  if (authorId && authorId === account.instagramId) return true;
  if (
    authorUsername &&
    authorUsername.toLowerCase() === account.username.toLowerCase()
  ) {
    return true;
  }
  return false;
}

/**
 * Upsert one comment by `commentId`. Idempotent: re-delivery (webhook retry,
 * a later backfill pass seeing the same comment again) updates the same row
 * instead of creating a duplicate.
 */
export async function recordInstagramComment(
  instagramAccountId: string,
  comment: InstagramCommentInput
): Promise<void> {
  try {
    await prisma.instagramComment.upsert({
      where: { commentId: comment.commentId },
      create: {
        commentId: comment.commentId,
        instagramAccountId,
        mediaId: comment.mediaId,
        text: comment.text,
        username: comment.username ?? null,
        commentedAt: comment.commentedAt,
        parentId: comment.parentId ?? null,
      },
      update: {
        text: comment.text,
        username: comment.username ?? null,
        // commentedAt is deliberately NOT updated here: it is the comment's
        // original timestamp, set once on first sight (webhook or backfill,
        // whichever sees it first) — re-delivery must never bump it to "now"
        // or to a later backfill pass's read of it.
        //
        // parentId: only ever set, never cleared. The daily backfill
        // (app/api/cron/sync-comments/route.ts) doesn't currently read
        // parent_id at all, so if it re-upserts a reply the webhook already
        // recorded with a parentId, `undefined` here (Prisma skips
        // `undefined` fields on update) leaves the existing value alone
        // instead of nulling it out.
        ...(comment.parentId ? { parentId: comment.parentId } : {}),
      },
    });
  } catch (error) {
    console.error(
      "[Comments] Failed to record comment:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export interface SweepableMedia {
  id: string;
  comments_count?: number;
}

/**
 * Which media from a listing page are worth fetching comments for. A missing
 * `comments_count` (the field the Meta Graph API omits from nothing, but the
 * Zernio provider's post listing never returns at all) is treated as "might
 * have comments" rather than excluded — we have no way to know without
 * asking, and skipping it would silently drop every Zernio-connected account
 * from the sweep.
 */
export function selectMediaWithComments<T extends SweepableMedia>(media: T[]): T[] {
  return media.filter((m) => m.comments_count === undefined || m.comments_count > 0);
}

/**
 * Media ids already recorded in `InstagramComment` for an account (typically
 * ads/dark posts, which a webhook can deliver a comment for but which never
 * show up in `/me/media`) that a fresh media listing did NOT surface. These
 * need their own comment sweep, or an ad's history never grows past whatever
 * arrived by webhook.
 *
 * `cap` bounds how many of these extra sweeps a single cron run takes on —
 * `knownMediaIds` is assumed already ordered by recency (most recent
 * `commentedAt` first), so the cap keeps the most relevant ones.
 */
export function selectMissingMediaIds({
  knownMediaIds,
  listedMediaIds,
  cap = 100,
}: {
  knownMediaIds: string[];
  listedMediaIds: Iterable<string>;
  cap?: number;
}): string[] {
  const listed = new Set(listedMediaIds);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const id of knownMediaIds) {
    if (listed.has(id) || seen.has(id)) continue;
    seen.add(id);
    missing.push(id);
    if (missing.length >= cap) break;
  }
  return missing;
}
