/**
 * Campaign keyword performance for the Comentários page: per campaign and
 * keyword, how many comments matched, how many DMs actually sent, and how
 * that translated into link clicks.
 *
 * `DmLog.matchedKeyword` is the source of truth for "comments that matched" —
 * `@@unique([automationId, commentId])` means one row per real comment per
 * campaign. Two synthetic `commentId` shapes exist in the same table and are
 * excluded here because they are not comments: `dm:<messageId>` (inbound DM
 * keyword trigger) and `reveal:<userId>` (button-tap / read-fallback reveal).
 *
 * `LinkClick` has no `matchedKeyword` — Meta never tells us which comment led
 * to which click — so clicks and the DM→click rate are reported per campaign,
 * not split per keyword; only "comments that matched" and "DMs sent" break
 * down by keyword.
 */

export const ANY_KEYWORD_LABEL = "(qualquer palavra)";

export interface DmLogForKeywordStats {
  automationId: string;
  matchedKeyword: string | null;
  status: string;
  commentId: string;
}

export interface KeywordRow {
  keyword: string;
  matchedComments: number;
  dmsSent: number;
}

export interface CampaignKeywordPerformance {
  automationId: string;
  automationName: string;
  keywords: KeywordRow[];
  totalMatchedComments: number;
  totalDmsSent: number;
  totalClicks: number;
  /** LinkClicks per DM sent, campaign-wide. Null when no DM has sent yet. */
  dmToClickRate: number | null;
}

function isSyntheticCommentId(commentId: string): boolean {
  return commentId.startsWith("dm:") || commentId.startsWith("reveal:");
}

export function aggregateKeywordPerformance({
  automations,
  dmLogs,
  clicksByAutomation,
}: {
  automations: Array<{ id: string; name: string }>;
  dmLogs: DmLogForKeywordStats[];
  clicksByAutomation: Map<string, number>;
}): CampaignKeywordPerformance[] {
  const automationNames = new Map(automations.map((a) => [a.id, a.name]));
  const byAutomation = new Map<string, Map<string, KeywordRow>>();

  for (const log of dmLogs) {
    if (isSyntheticCommentId(log.commentId)) continue;
    if (!automationNames.has(log.automationId)) continue;

    let keywords = byAutomation.get(log.automationId);
    if (!keywords) {
      keywords = new Map();
      byAutomation.set(log.automationId, keywords);
    }

    const keyword = log.matchedKeyword ?? ANY_KEYWORD_LABEL;
    let row = keywords.get(keyword);
    if (!row) {
      row = { keyword, matchedComments: 0, dmsSent: 0 };
      keywords.set(keyword, row);
    }
    row.matchedComments += 1;
    if (log.status === "SENT") row.dmsSent += 1;
  }

  const result: CampaignKeywordPerformance[] = [];
  for (const [automationId, keywords] of byAutomation) {
    const rows = [...keywords.values()].sort(
      (a, b) => b.matchedComments - a.matchedComments
    );
    const totalMatchedComments = rows.reduce(
      (sum, row) => sum + row.matchedComments,
      0
    );
    const totalDmsSent = rows.reduce((sum, row) => sum + row.dmsSent, 0);
    const totalClicks = clicksByAutomation.get(automationId) ?? 0;

    result.push({
      automationId,
      automationName: automationNames.get(automationId) ?? "Campanha removida",
      keywords: rows,
      totalMatchedComments,
      totalDmsSent,
      totalClicks,
      dmToClickRate: totalDmsSent > 0 ? totalClicks / totalDmsSent : null,
    });
  }

  return result.sort((a, b) => b.totalMatchedComments - a.totalMatchedComments);
}
