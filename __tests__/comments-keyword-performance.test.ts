/**
 * Campaign keyword performance aggregation — Unit Tests
 */

import { describe, it, expect } from "vitest";
import {
  aggregateKeywordPerformance,
  ANY_KEYWORD_LABEL,
} from "../lib/comments/keyword-performance";

const automations = [
  { id: "auto_1", name: "Promo de lançamento" },
  { id: "auto_2", name: "Qualquer comentário" },
];

describe("aggregateKeywordPerformance", () => {
  it("counts matched comments and DMs sent per keyword", () => {
    const result = aggregateKeywordPerformance({
      automations,
      dmLogs: [
        {
          automationId: "auto_1",
          matchedKeyword: "link",
          status: "SENT",
          commentId: "c1",
        },
        {
          automationId: "auto_1",
          matchedKeyword: "link",
          status: "FAILED",
          commentId: "c2",
        },
        {
          automationId: "auto_1",
          matchedKeyword: "preço",
          status: "SENT",
          commentId: "c3",
        },
      ],
      clicksByAutomation: new Map(),
    });

    expect(result).toHaveLength(1);
    const campaign = result[0];
    expect(campaign.automationId).toBe("auto_1");
    expect(campaign.automationName).toBe("Promo de lançamento");
    expect(campaign.totalMatchedComments).toBe(3);
    expect(campaign.totalDmsSent).toBe(2);

    const linkRow = campaign.keywords.find((k) => k.keyword === "link");
    expect(linkRow).toEqual({ keyword: "link", matchedComments: 2, dmsSent: 1 });

    const precoRow = campaign.keywords.find((k) => k.keyword === "preço");
    expect(precoRow).toEqual({ keyword: "preço", matchedComments: 1, dmsSent: 1 });
  });

  it("labels a null matchedKeyword as any-word", () => {
    const result = aggregateKeywordPerformance({
      automations,
      dmLogs: [
        {
          automationId: "auto_2",
          matchedKeyword: null,
          status: "SENT",
          commentId: "c1",
        },
      ],
      clicksByAutomation: new Map(),
    });

    expect(result[0].keywords).toEqual([
      { keyword: ANY_KEYWORD_LABEL, matchedComments: 1, dmsSent: 1 },
    ]);
  });

  it("excludes synthetic DM-trigger and reveal entries from the comment count", () => {
    const result = aggregateKeywordPerformance({
      automations,
      dmLogs: [
        {
          automationId: "auto_1",
          matchedKeyword: "link",
          status: "SENT",
          commentId: "real_comment_1",
        },
        {
          automationId: "auto_1",
          matchedKeyword: "link",
          status: "SENT",
          commentId: "dm:message_123",
        },
        {
          automationId: "auto_1",
          matchedKeyword: "link",
          status: "SENT",
          commentId: "reveal:user_456",
        },
      ],
      clicksByAutomation: new Map(),
    });

    expect(result[0].totalMatchedComments).toBe(1);
    expect(result[0].totalDmsSent).toBe(1);
  });

  it("reports clicks and the DM-to-click rate per campaign, not per keyword", () => {
    const result = aggregateKeywordPerformance({
      automations,
      dmLogs: [
        {
          automationId: "auto_1",
          matchedKeyword: "link",
          status: "SENT",
          commentId: "c1",
        },
        {
          automationId: "auto_1",
          matchedKeyword: "preço",
          status: "SENT",
          commentId: "c2",
        },
      ],
      clicksByAutomation: new Map([["auto_1", 4]]),
    });

    expect(result[0].totalClicks).toBe(4);
    expect(result[0].totalDmsSent).toBe(2);
    expect(result[0].dmToClickRate).toBe(2);
  });

  it("returns null for the DM-to-click rate when no DM has sent yet", () => {
    const result = aggregateKeywordPerformance({
      automations,
      dmLogs: [
        {
          automationId: "auto_1",
          matchedKeyword: "link",
          status: "FAILED",
          commentId: "c1",
        },
      ],
      clicksByAutomation: new Map([["auto_1", 3]]),
    });

    expect(result[0].dmToClickRate).toBeNull();
  });

  it("ignores DmLog rows for automations outside the provided list", () => {
    const result = aggregateKeywordPerformance({
      automations,
      dmLogs: [
        {
          automationId: "auto_deleted",
          matchedKeyword: "link",
          status: "SENT",
          commentId: "c1",
        },
      ],
      clicksByAutomation: new Map(),
    });

    expect(result).toHaveLength(0);
  });

  it("sorts campaigns by total matched comments, descending", () => {
    const result = aggregateKeywordPerformance({
      automations,
      dmLogs: [
        {
          automationId: "auto_2",
          matchedKeyword: null,
          status: "SENT",
          commentId: "c1",
        },
        {
          automationId: "auto_1",
          matchedKeyword: "link",
          status: "SENT",
          commentId: "c2",
        },
        {
          automationId: "auto_1",
          matchedKeyword: "link",
          status: "SENT",
          commentId: "c3",
        },
      ],
      clicksByAutomation: new Map(),
    });

    expect(result.map((c) => c.automationId)).toEqual(["auto_1", "auto_2"]);
  });
});
