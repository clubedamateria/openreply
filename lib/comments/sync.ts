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
        commentedAt: comment.commentedAt,
        parentId: comment.parentId ?? null,
      },
    });
  } catch (error) {
    console.error(
      "[Comments] Failed to record comment:",
      error instanceof Error ? error.message : String(error)
    );
  }
}
