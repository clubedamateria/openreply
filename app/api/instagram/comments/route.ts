import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import {
  createInstagramContext,
  getMediaById,
  type InstagramMedia,
} from "@/lib/instagram/provider";
import type { InstagramContext } from "@/lib/instagram/context";
import {
  analyzeCommentTexts,
  normalizeWord,
  tokenizeWords,
  type CommentTextStats,
} from "@/lib/comments/word-stats";
import { isQuestion } from "@/lib/comments/questions";
import { isKeywordOnlyComment, matchKeywordOnly } from "@/lib/comments/keyword-only";
import {
  aggregateKeywordPerformance,
  type CampaignKeywordPerformance,
} from "@/lib/comments/keyword-performance";

// How many recent comments to show in the feed.
const RECENT_COMMENTS_LIMIT = 200;
// Word-stats/keyword-performance/questions are aggregate views, not a full
// export — capping the row count read for them is what keeps a viral
// account's comment volume from ballooning this request's memory.
// `summary.totalComments` still comes from a separate `count()`, so the
// number shown is always exact even past this cap.
const AGGREGATION_ROWS_LIMIT = 20_000;
// A word/expression said only once, with a handful of comments total, is
// noise ("Oiii", "de saber"), not a pattern.
const WORD_STATS_MIN_COUNT = 2;
const VALID_DAYS = [7, 30, 90] as const;
type Days = (typeof VALID_DAYS)[number];

export type PostKind = "AD" | "REELS" | "FEED" | "STORY" | null;

export interface CommentsResponse {
  accounts: Array<{ id: string; username: string }>;
  selectedAccountId: string;
  days: Days;
  summary: {
    totalComments: number;
    /** Distinct commenter usernames in the period. */
    uniquePeople: number;
    /** Comments read as a question — see lib/comments/questions.ts. */
    questions: number;
    /** Distinct posts (mediaId) with at least one comment in the period. */
    postsWithComments: number;
    /**
     * Comments that are ONLY a campaign keyword (or that keyword repeated) —
     * see lib/comments/keyword-only.ts. Approximate past
     * AGGREGATION_ROWS_LIMIT, same caveat as `questions`.
     */
    keywordOnly: number;
  };
  wordStats: CommentTextStats;
  campaigns: CampaignKeywordPerformance[];
  /**
   * One row per (automation, keyword) that had at least one keyword-only
   * comment in the period — e.g. "25 pessoas comentaram 'Clube' para
   * receber a DM (campanha X)". Counted over the whole period (the
   * aggregation read), not just the 200 comments below.
   */
  keywordGroups: Array<{
    /** Most common surface form the audience typed. */
    keyword: string;
    count: number;
    automationName: string;
    lastCommentAt: string;
  }>;
  comments: Array<{
    id: string;
    text: string;
    username: string | null;
    commentedAt: string;
    mediaId: string;
    accountUsername: string;
    isQuestion: boolean;
    isKeywordOnly: boolean;
  }>;
  posts: Array<{
    mediaId: string;
    count: number;
    lastCommentAt: string;
    permalink: string | null;
    /** Up to 100 chars. */
    caption: string | null;
    kind: PostKind;
    thumbnailUrl: string | null;
  }>;
}

function parseDays(value: string | null): Days {
  const parsed = Number.parseInt(value ?? "30", 10);
  return (VALID_DAYS as readonly number[]).includes(parsed)
    ? (parsed as Days)
    : 30;
}

function classifyMediaKind(media: InstagramMedia): PostKind {
  switch (media.media_product_type) {
    case "AD":
    case "REELS":
    case "STORY":
    case "FEED":
      return media.media_product_type;
    default:
      // Older media predates `media_product_type` being populated — fall
      // back to "a feed post", which is what an image/carousel/video with no
      // product type actually is.
      return media.media_type ? "FEED" : null;
  }
}

const CAPTION_PREVIEW_LENGTH = 100;

function previewCaption(caption: string | undefined): string | null {
  if (!caption) return null;
  return caption.length > CAPTION_PREVIEW_LENGTH
    ? `${caption.slice(0, CAPTION_PREVIEW_LENGTH)}…`
    : caption;
}

interface MediaDetail {
  permalink: string | null;
  caption: string | null;
  kind: PostKind;
  thumbnailUrl: string | null;
}

// Per-mediaId cache (media ids are globally unique on Instagram, so no
// account-scoping needed): switching the period selector, or a second
// visitor, doesn't re-fetch the same post's Graph details within the hour.
const MEDIA_DETAIL_CACHE_TTL_MS = 60 * 60 * 1000;
const mediaDetailCache = new Map<
  string,
  { expiresAt: number; detail: MediaDetail | null }
>();
// A single request never looks up more than this many distinct mediaIds via
// the Graph API — bounds worst-case request latency/cost regardless of how
// many distinct posts the period's comments touch.
const MEDIA_DETAIL_FETCH_CAP = 30;

async function getMediaDetail(
  mediaId: string,
  context: InstagramContext
): Promise<MediaDetail | null> {
  const cached = mediaDetailCache.get(mediaId);
  if (cached && cached.expiresAt > Date.now()) return cached.detail;

  let detail: MediaDetail | null;
  try {
    const media = await getMediaById({ context, mediaId });
    detail = media
      ? {
          permalink: media.permalink ?? null,
          caption: previewCaption(media.caption),
          kind: classifyMediaKind(media),
          thumbnailUrl: media.thumbnail_url ?? media.media_url ?? null,
        }
      : null;
  } catch (error) {
    console.warn(
      "[Instagram Comments] Media detail lookup failed:",
      mediaId,
      error instanceof Error ? error.message : error
    );
    detail = null;
  }

  mediaDetailCache.set(mediaId, {
    expiresAt: Date.now() + MEDIA_DETAIL_CACHE_TTL_MS,
    detail,
  });
  return detail;
}

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const days = parseDays(request.nextUrl.searchParams.get("days"));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const requestedAccountId =
    request.nextUrl.searchParams.get("instagramAccountId") ?? "all";

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: { id: true, username: true },
  });

  const selectedAccountId =
    requestedAccountId !== "all" &&
    accounts.some((a) => a.id === requestedAccountId)
      ? requestedAccountId
      : "all";
  const accountScope =
    selectedAccountId !== "all" ? { id: selectedAccountId } : {};

  try {
    const commentWhere = {
      commentedAt: { gte: since },
      instagramAccount: { workspaceId, ...accountScope },
    };

    // Five narrow, purpose-built queries instead of one unbounded one
    // embedding full account rows (including accessToken) per comment:
    // totalComments/uniquePeople/postsWithComments are exact (never
    // truncated by the aggregation cap below); the text-only read for
    // wordStats/questions is capped at AGGREGATION_ROWS_LIMIT; the recent
    // comments feed and the per-post ranking are their own bounded queries
    // with no credentials in them at all.
    const [
      totalComments,
      uniqueUsernameRows,
      aggregationRows,
      recentRows,
      postGroups,
    ] = await Promise.all([
      prisma.instagramComment.count({ where: commentWhere }),
      prisma.instagramComment.findMany({
        where: { ...commentWhere, username: { not: null } },
        distinct: ["username"],
        select: { username: true },
        take: AGGREGATION_ROWS_LIMIT,
      }),
      prisma.instagramComment.findMany({
        where: commentWhere,
        select: { text: true, commentedAt: true },
        take: AGGREGATION_ROWS_LIMIT,
      }),
      prisma.instagramComment.findMany({
        where: commentWhere,
        orderBy: { commentedAt: "desc" },
        take: RECENT_COMMENTS_LIMIT,
        select: {
          id: true,
          text: true,
          username: true,
          commentedAt: true,
          mediaId: true,
          instagramAccountId: true,
          instagramAccount: { select: { username: true } },
        },
      }),
      prisma.instagramComment.groupBy({
        by: ["mediaId", "instagramAccountId"],
        where: commentWhere,
        _count: { _all: true },
        _max: { commentedAt: true },
        // `orderBy` is required by Prisma whenever `take` is set on a
        // groupBy; the real "top 20 by count" ordering is done in JS below
        // (`_count._all` across BOTH group-by fields isn't directly
        // orderable), so this just needs to be deterministic, not
        // meaningful.
        orderBy: { _count: { id: "desc" } },
        take: AGGREGATION_ROWS_LIMIT,
      }),
    ]);

    const automations = await prisma.automation.findMany({
      where: {
        workspaceId,
        ...(selectedAccountId !== "all"
          ? { instagramAccountId: selectedAccountId }
          : {}),
      },
      select: { id: true, name: true, keywords: true },
    });
    const automationIds = automations.map((a) => a.id);

    // Every campaign keyword in scope, merged into one pool — a keyword
    // blast ("Clube" ×25) is a DM trigger, not something the audience is
    // saying about the product, so it gets pulled out of wordStats and out
    // of the main comment feed (see keywordGroups below for where it goes
    // instead).
    const allKeywords = [
      ...new Set(
        automations.flatMap((a) => a.keywords).map((k) => k.trim()).filter(Boolean)
      ),
    ];
    // Individual word tokens of every keyword, in the same normalized key
    // space as wordStats' own word/bigram maps — this is what lets a
    // non-keyword-only comment ("quero clube muito") still have "clube"
    // scrubbed out of the word list and out of any bigram it would join.
    const keywordWordKeys = new Set(
      allKeywords.flatMap((k) => tokenizeWords(k).map(normalizeWord))
    );

    const keywordOnlyFlags = aggregationRows.map((c) =>
      isKeywordOnlyComment(c.text, allKeywords)
    );
    const keywordOnlyCount = keywordOnlyFlags.filter(Boolean).length;

    const wordStats = analyzeCommentTexts(
      aggregationRows.filter((_, i) => !keywordOnlyFlags[i]).map((c) => c.text),
      25,
      WORD_STATS_MIN_COUNT,
      keywordWordKeys
    );
    // Same cap/precedent as wordStats: an exact count would need reading
    // every comment in the period, not just the aggregation sample.
    const questionsCount = aggregationRows.filter((c) => isQuestion(c.text)).length;

    // One row per (automation, keyword) with at least one keyword-only
    // comment, counted over the whole aggregation read (not just the 200
    // most recent). Only the rows already flagged keyword-only above are
    // checked against each automation's own keyword list — that is the only
    // way to know WHICH automation/keyword a keyword-only comment belongs to
    // (the merged pool above answers "is it keyword-only?", not "whose?").
    const keywordGroupsByKey = new Map<
      string,
      {
        automationName: string;
        count: number;
        lastCommentAt: Date;
        surfaceForms: Map<string, number>;
      }
    >();
    aggregationRows.forEach((row, i) => {
      if (!keywordOnlyFlags[i]) return;
      for (const automation of automations) {
        if (automation.keywords.length === 0) continue;
        const match = matchKeywordOnly(row.text, automation.keywords);
        if (!match) continue;

        const mapKey = `${automation.id}::${match.keyword}`;
        let group = keywordGroupsByKey.get(mapKey);
        if (!group) {
          group = {
            automationName: automation.name,
            count: 0,
            lastCommentAt: row.commentedAt,
            surfaceForms: new Map(),
          };
          keywordGroupsByKey.set(mapKey, group);
        }
        group.count += 1;
        if (row.commentedAt > group.lastCommentAt) group.lastCommentAt = row.commentedAt;
        group.surfaceForms.set(
          match.surface,
          (group.surfaceForms.get(match.surface) ?? 0) + 1
        );
        break;
      }
    });

    const keywordGroups: CommentsResponse["keywordGroups"] = [...keywordGroupsByKey.values()]
      .map((group) => {
        let bestSurface = "";
        let bestCount = -1;
        for (const [surface, count] of group.surfaceForms) {
          if (count > bestCount) {
            bestCount = count;
            bestSurface = surface;
          }
        }
        return {
          keyword: bestSurface,
          count: group.count,
          automationName: group.automationName,
          lastCommentAt: group.lastCommentAt.toISOString(),
        };
      })
      .sort((a, b) => b.count - a.count);

    const dmLogs = automationIds.length
      ? await prisma.dmLog.findMany({
          where: {
            workspaceId,
            automationId: { in: automationIds },
            createdAt: { gte: since },
          },
          select: {
            automationId: true,
            matchedKeyword: true,
            status: true,
            commentId: true,
          },
          take: AGGREGATION_ROWS_LIMIT,
        })
      : [];

    const linkClickGroups = automationIds.length
      ? await prisma.linkClick.groupBy({
          by: ["automationId"],
          where: {
            workspaceId,
            automationId: { in: automationIds },
            createdAt: { gte: since },
          },
          _count: { _all: true },
        })
      : [];
    const clicksByAutomation = new Map(
      linkClickGroups.map((g) => [g.automationId, g._count._all])
    );

    const campaigns = aggregateKeywordPerformance({
      automations,
      dmLogs,
      clicksByAutomation,
    });

    // Rank every distinct post that had a comment in the period, keep the
    // top 20 for the response, but remember all of them for the exact
    // `postsWithComments` count.
    const rankedPostGroups = [...postGroups].sort(
      (a, b) => b._count._all - a._count._all
    );
    const topPostGroups = rankedPostGroups.slice(0, 20);

    // Credentials (accessToken included) are fetched in exactly one query,
    // for exactly the handful of distinct accounts behind the top posts and
    // the recent-comments feed — never embedded in the per-comment rows
    // fetched above.
    const distinctAccountIds = [
      ...new Set([
        ...topPostGroups.map((g) => g.instagramAccountId),
        ...recentRows.map((c) => c.instagramAccountId),
      ]),
    ];
    const credentialAccounts = distinctAccountIds.length
      ? await prisma.instagramAccount.findMany({
          where: { id: { in: distinctAccountIds } },
          select: {
            id: true,
            provider: true,
            workspaceId: true,
            zernioAccountId: true,
            instagramId: true,
            accessToken: true,
          },
        })
      : [];
    const accountsById = new Map(credentialAccounts.map((a) => [a.id, a]));

    // One Instagram/Zernio context per account, reused across every media
    // detail lookup for that account instead of re-decrypting the token (or,
    // for Zernio, re-reading the workspace connection) per mediaId.
    const contextCache = new Map<string, Promise<InstagramContext> | null>();
    function contextFor(accountId: string): Promise<InstagramContext> | null {
      if (contextCache.has(accountId)) return contextCache.get(accountId)!;
      const account = accountsById.get(accountId);
      const promise = account ? createInstagramContext(account) : null;
      contextCache.set(accountId, promise);
      return promise;
    }

    // Fetch details for at most MEDIA_DETAIL_FETCH_CAP distinct mediaIds,
    // prioritizing the top posts (what `posts` needs) and filling any
    // remaining slots with mediaIds from the recent-comments feed (so a
    // brand-new, not-yet-top-20 post referenced by a recent comment can
    // still resolve its context in the common case where the account has
    // few enough distinct posts in the period to fit under the cap).
    const mediaIdsToFetch: Array<{ mediaId: string; instagramAccountId: string }> = [];
    const seenMediaIds = new Set<string>();
    function queueMediaId(mediaId: string, instagramAccountId: string) {
      if (seenMediaIds.has(mediaId)) return;
      if (mediaIdsToFetch.length >= MEDIA_DETAIL_FETCH_CAP) return;
      seenMediaIds.add(mediaId);
      mediaIdsToFetch.push({ mediaId, instagramAccountId });
    }
    for (const group of topPostGroups) {
      queueMediaId(group.mediaId, group.instagramAccountId);
    }
    for (const row of recentRows) {
      queueMediaId(row.mediaId, row.instagramAccountId);
    }

    const mediaDetails = new Map<string, MediaDetail | null>();
    await Promise.all(
      mediaIdsToFetch.map(async ({ mediaId, instagramAccountId }) => {
        const contextPromise = contextFor(instagramAccountId);
        if (!contextPromise) {
          mediaDetails.set(mediaId, null);
          return;
        }
        try {
          const context = await contextPromise;
          mediaDetails.set(mediaId, await getMediaDetail(mediaId, context));
        } catch {
          mediaDetails.set(mediaId, null);
        }
      })
    );

    const posts: CommentsResponse["posts"] = topPostGroups.map((group) => {
      const detail = mediaDetails.get(group.mediaId) ?? null;
      return {
        mediaId: group.mediaId,
        count: group._count._all,
        lastCommentAt: (group._max.commentedAt ?? new Date(0)).toISOString(),
        permalink: detail?.permalink ?? null,
        caption: detail?.caption ?? null,
        kind: detail?.kind ?? null,
        thumbnailUrl: detail?.thumbnailUrl ?? null,
      };
    });

    const comments: CommentsResponse["comments"] = recentRows.map((c) => ({
      id: c.id,
      text: c.text,
      username: c.username,
      commentedAt: c.commentedAt.toISOString(),
      mediaId: c.mediaId,
      accountUsername: c.instagramAccount.username,
      isQuestion: isQuestion(c.text),
      isKeywordOnly: isKeywordOnlyComment(c.text, allKeywords),
    }));

    const data: CommentsResponse = {
      accounts,
      selectedAccountId,
      days,
      summary: {
        totalComments,
        uniquePeople: uniqueUsernameRows.length,
        questions: questionsCount,
        postsWithComments: rankedPostGroups.length,
        keywordOnly: keywordOnlyCount,
      },
      wordStats,
      campaigns,
      keywordGroups,
      comments,
      posts,
    };

    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error("[Instagram Comments] Error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to load comments" },
      { status: 500 }
    );
  }
}
