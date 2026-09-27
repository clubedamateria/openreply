import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { createInstagramContext } from "@/lib/instagram/provider";
import { getUserMedia, getRecentMediaComments } from "@/lib/instagram/provider";
import { recordInstagramComment, isOwnAccountComment } from "@/lib/comments/sync";

/**
 * Daily backfill/correction pass for comment stats: for each connected META
 * account, walk its last 30 posts and upsert every comment found. Real-time
 * ingestion happens in the webhook (see lib/queue/process-webhook.ts); this
 * cron exists because webhooks are best-effort and never fire for a large
 * class of comments (see the note atop lib/polling/comment-reconciler.ts).
 *
 * ZERNIO accounts are out of scope for now — Zernio's comment inbox API has
 * no per-media pagination equivalent, so a 30-post sweep is not available.
 */

// Allow time for 30 posts × per-media comment pagination across every account.
export const maxDuration = 60;

// Post-count scope, per the plan ("últimos 30 posts").
const POST_LIMIT = 30;
// Per-post ceiling so a single viral post can't make the sweep run forever or
// hammer the Graph API — this is a daily correction pass, not a live feed.
const MAX_COMMENTS_PER_POST = 300;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const accounts = await prisma.instagramAccount.findMany({
    where: { provider: "META", accessToken: { not: "" } },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      instagramId: true,
      accessToken: true,
      provider: true,
      zernioAccountId: true,
    },
  });

  let postsScanned = 0;
  let commentsUpserted = 0;
  const failures: Array<{ username: string; reason: string }> = [];

  for (const account of accounts) {
    try {
      const context = await createInstagramContext(account);
      const media = await getUserMedia({ context, limit: POST_LIMIT });

      for (const post of media) {
        postsScanned += 1;
        try {
          const comments = await getRecentMediaComments({
            context,
            mediaId: post.id,
            // No time floor: scope is the last 30 POSTS, not a time window —
            // an old post can still be collecting comments today.
            sinceMs: 0,
            max: MAX_COMMENTS_PER_POST,
          });

          for (const comment of comments) {
            if (!comment.id || !comment.timestamp) continue;
            if (
              isOwnAccountComment({
                authorId: comment.from?.id,
                authorUsername: comment.from?.username,
                account,
              })
            ) {
              continue;
            }

            await recordInstagramComment(account.id, {
              commentId: comment.id,
              mediaId: post.id,
              text: comment.text ?? "",
              username: comment.from?.username ?? null,
              commentedAt: new Date(comment.timestamp),
            });
            commentsUpserted += 1;
          }
        } catch (error) {
          failures.push({
            username: account.username,
            reason: `Post ${post.id}: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          });
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      failures.push({ username: account.username, reason });
      await prisma.operationalEvent
        .create({
          data: {
            source: "SYSTEM",
            level: "WARNING",
            workspaceId: account.workspaceId,
            message: "Comment sync failed",
            payload: { username: account.username, reason },
          },
        })
        .catch(() => {});
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      accounts: accounts.length,
      postsScanned,
      commentsUpserted,
      failures,
    },
  });
}
