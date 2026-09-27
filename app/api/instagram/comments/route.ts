import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { createInstagramContext, getUserMedia } from "@/lib/instagram/provider";
import { analyzeCommentTexts, type CommentTextStats } from "@/lib/comments/word-stats";
import {
  aggregateKeywordPerformance,
  type CampaignKeywordPerformance,
} from "@/lib/comments/keyword-performance";

// How many recent comments to show in the feed.
const RECENT_COMMENTS_LIMIT = 30;
// Word-stats/keyword-performance are aggregate views, not a full export —
// capping the row count read for them is what keeps a viral account's
// comment volume from ballooning this request's memory. totalComments still
// comes from a separate `count()`, so the number shown is always exact even
// past this cap.
const AGGREGATION_ROWS_LIMIT = 20_000;
const VALID_DAYS = [7, 30, 90] as const;
type Days = (typeof VALID_DAYS)[number];

export interface CommentsResponse {
  accounts: Array<{ id: string; username: string }>;
  selectedAccountId: string;
  days: Days;
  totalComments: number;
  wordStats: CommentTextStats;
  campaigns: CampaignKeywordPerformance[];
  recentComments: Array<{
    id: string;
    text: string;
    username: string | null;
    commentedAt: string;
    mediaId: string;
    accountUsername: string;
    permalink: string | null;
  }>;
}

function parseDays(value: string | null): Days {
  const parsed = Number.parseInt(value ?? "30", 10);
  return (VALID_DAYS as readonly number[]).includes(parsed)
    ? (parsed as Days)
    : 30;
}

// Permalinks require a live Graph API call (Instagram permalinks are keyed by
// shortcode, not media id — there is no way to derive one from data already in
// our database). Cached briefly per account so switching the period selector,
// or a second visitor, doesn't re-fetch on every request.
const PERMALINK_CACHE_TTL_MS = 5 * 60 * 1000;
const permalinkCache = new Map<
  string,
  { expiresAt: number; map: Map<string, string> }
>();

async function getPermalinkMap(account: {
  id: string;
  provider: "META" | "ZERNIO";
  workspaceId: string;
  zernioAccountId: string | null;
  instagramId: string;
  accessToken: string;
}): Promise<Map<string, string>> {
  const cached = permalinkCache.get(account.id);
  if (cached && cached.expiresAt > Date.now()) return cached.map;

  try {
    const context = await createInstagramContext(account);
    const media = await getUserMedia({ context, limit: 30 });
    const map = new Map(
      media
        .filter((m): m is typeof m & { permalink: string } => Boolean(m.permalink))
        .map((m) => [m.id, m.permalink])
    );
    permalinkCache.set(account.id, {
      expiresAt: Date.now() + PERMALINK_CACHE_TTL_MS,
      map,
    });
    return map;
  } catch (error) {
    console.warn(
      "[Instagram Comments] Permalink lookup failed:",
      error instanceof Error ? error.message : error
    );
    return new Map();
  }
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

    // Three separate, narrow queries instead of one unbounded one embedding
    // full account rows (including accessToken) per comment: totalComments
    // is an exact count (never truncated by the aggregation cap below), the
    // aggregation read only pulls `text` (all it needs) capped at
    // AGGREGATION_ROWS_LIMIT, and the recent-comments feed is its own
    // take:30 query with no credentials in it at all.
    const [totalComments, aggregationRows, recentRows] = await Promise.all([
      prisma.instagramComment.count({ where: commentWhere }),
      prisma.instagramComment.findMany({
        where: commentWhere,
        select: { text: true },
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
    ]);

    const wordStats = analyzeCommentTexts(aggregationRows.map((c) => c.text));

    const automations = await prisma.automation.findMany({
      where: {
        workspaceId,
        ...(selectedAccountId !== "all"
          ? { instagramAccountId: selectedAccountId }
          : {}),
      },
      select: { id: true, name: true },
    });
    const automationIds = automations.map((a) => a.id);

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

    // Credentials (accessToken included) are fetched in exactly one query,
    // for exactly the handful of distinct accounts behind these 30 recent
    // comments — never embedded in the per-comment rows above.
    const distinctAccountIds = [...new Set(recentRows.map((c) => c.instagramAccountId))];
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

    const permalinkMaps = new Map(
      await Promise.all(
        credentialAccounts.map(
          async (account) => [account.id, await getPermalinkMap(account)] as const
        )
      )
    );

    const recentComments = recentRows.map((c) => ({
      id: c.id,
      text: c.text,
      username: c.username,
      commentedAt: c.commentedAt.toISOString(),
      mediaId: c.mediaId,
      accountUsername: c.instagramAccount.username,
      permalink: permalinkMaps.get(c.instagramAccountId)?.get(c.mediaId) ?? null,
    }));

    const data: CommentsResponse = {
      accounts,
      selectedAccountId,
      days,
      totalComments,
      wordStats,
      campaigns,
      recentComments,
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
