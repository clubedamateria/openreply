import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  createInstagramContext,
  getAllUserMedia,
  getRecentMediaComments,
} from "@/lib/instagram/provider";
import {
  recordInstagramComment,
  isOwnAccountComment,
  selectMediaWithComments,
  selectMissingMediaIds,
} from "@/lib/comments/sync";

/**
 * Daily backfill/correction pass for comment stats.
 *
 * For every connected account (META or ZERNIO), walks its media newest-first
 * up to 90 days back (or MEDIA_CAP posts, whichever comes first — see
 * `getAllUserMedia`'s `until`) and upserts every comment on any post that
 * might have one (`selectMediaWithComments`: `comments_count > 0`, or the
 * field simply missing, which is the normal case for the Zernio provider's
 * post listing).
 *
 * A dark-post ad never shows up in that listing at all — Instagram's
 * `/me/media` simply never includes it, no matter how far back you page —
 * so this also re-sweeps every media id already seen in our OWN
 * `InstagramComment` table for this account in the last 90 days that the
 * fresh listing did NOT surface (`selectMissingMediaIds`, capped at
 * `AD_MEDIA_CAP`). That is how an ad that only ever got 1 comment via the
 * realtime webhook picks up its full comment history on the next run.
 *
 * Real-time ingestion happens in the webhook (see
 * lib/queue/process-webhook.ts); this cron exists because webhooks are
 * best-effort and never fire for a large class of comments (see the note
 * atop lib/polling/comment-reconciler.ts).
 */

// Allow time for a deep media walk × per-media comment pagination across
// every account.
export const maxDuration = 60;

// Stay well under `maxDuration` so one slow account/post never eats the
// whole run and starves the rest of the accounts — past this budget, the
// route returns early with `partial: true` and the NEXT scheduled run picks
// up wherever this one stopped (nothing here is order-dependent: every pass
// re-derives its own worklist from the DB and the Graph API from scratch).
const TIME_BUDGET_MS = 50_000;

// Sweep scope: media from the last 90 days, capped at 500 posts either way.
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MEDIA_CAP = 500;
// Ad/dark-post backfill: at most this many extra media ids per account.
const AD_MEDIA_CAP = 100;
// Per-post ceiling so a single viral post can't make the sweep run forever or
// hammer the Graph API — this is a daily correction pass, not a live feed.
const MAX_COMMENTS_PER_POST = 300;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const startedAt = Date.now();
  const deadline = startedAt + TIME_BUDGET_MS;
  const cutoff = new Date(startedAt - MAX_AGE_MS);

  const accounts = await prisma.instagramAccount.findMany({
    where: {
      OR: [
        { provider: "META", accessToken: { not: "" } },
        { provider: "ZERNIO", zernioAccountId: { not: null } },
      ],
    },
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
  let partial = false;
  const failures: Array<{ username: string; reason: string }> = [];

  accountLoop: for (const account of accounts) {
    if (Date.now() > deadline) {
      partial = true;
      break;
    }

    try {
      const context = await createInstagramContext(account);
      const media = await getAllUserMedia({
        context,
        max: MEDIA_CAP,
        until: cutoff,
      });

      // Media ids we already have recent comments for, most recently active
      // first (so a truncation by AD_MEDIA_CAP keeps the ones still likely
      // collecting new comments).
      const knownMediaGroups = await prisma.instagramComment.groupBy({
        by: ["mediaId"],
        where: { instagramAccountId: account.id, commentedAt: { gte: cutoff } },
        _max: { commentedAt: true },
      });
      const knownMediaIds = knownMediaGroups
        .sort(
          (a, b) =>
            (b._max.commentedAt?.getTime() ?? 0) -
            (a._max.commentedAt?.getTime() ?? 0)
        )
        .map((row) => row.mediaId);

      const adMediaIds = selectMissingMediaIds({
        knownMediaIds,
        listedMediaIds: media.map((m) => m.id),
        cap: AD_MEDIA_CAP,
      });

      const postsToSweep: Array<{ id: string }> = [
        ...selectMediaWithComments(media),
        ...adMediaIds.map((id) => ({ id })),
      ];

      for (const post of postsToSweep) {
        if (Date.now() > deadline) {
          partial = true;
          break accountLoop;
        }

        postsScanned += 1;
        try {
          const comments = await getRecentMediaComments({
            context,
            mediaId: post.id,
            // No time floor beyond the media walk's own `until`: an
            // old-but-still-inside-the-window post can keep collecting
            // comments today.
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
      partial,
      failures,
    },
  });
}
