/**
 * Comment ingestion (recordInstagramComment / isOwnAccountComment) — Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockUpsert } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    instagramComment: {
      upsert: mockUpsert,
    },
  },
}));

import {
  isOwnAccountComment,
  recordInstagramComment,
  selectMediaWithComments,
  selectMissingMediaIds,
} from "../lib/comments/sync";

describe("isOwnAccountComment", () => {
  const account = { instagramId: "ig_123", username: "ourbrand" };

  it("matches by author id", () => {
    expect(
      isOwnAccountComment({ authorId: "ig_123", authorUsername: null, account })
    ).toBe(true);
  });

  it("matches by username, case-insensitively", () => {
    expect(
      isOwnAccountComment({
        authorId: "someone_else",
        authorUsername: "OurBrand",
        account,
      })
    ).toBe(true);
  });

  it("returns false for a different commenter", () => {
    expect(
      isOwnAccountComment({
        authorId: "user_789",
        authorUsername: "fan_account",
        account,
      })
    ).toBe(false);
  });

  it("returns false when neither id nor username is provided", () => {
    expect(
      isOwnAccountComment({ authorId: null, authorUsername: null, account })
    ).toBe(false);
  });
});

describe("recordInstagramComment", () => {
  beforeEach(() => {
    mockUpsert.mockReset();
  });

  it("upserts by commentId with the given fields", async () => {
    mockUpsert.mockResolvedValue({});
    const commentedAt = new Date("2026-09-27T12:00:00Z");

    await recordInstagramComment("account_1", {
      commentId: "comment_1",
      mediaId: "media_1",
      text: "quero o link",
      username: "fan1",
      commentedAt,
    });

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith({
      where: { commentId: "comment_1" },
      create: {
        commentId: "comment_1",
        instagramAccountId: "account_1",
        mediaId: "media_1",
        text: "quero o link",
        username: "fan1",
        commentedAt,
        parentId: null,
      },
      // commentedAt is NOT in the update branch: it must never be bumped by
      // a re-delivery or a later backfill pass seeing the same comment
      // again — only `create` sets it, once. Likewise `parentId` is only
      // ever set when the caller actually knows it (never nulled out).
      update: {
        text: "quero o link",
        username: "fan1",
      },
    });
  });

  it("fills in parentId on update when the caller now knows it, without nulling out anything else", async () => {
    mockUpsert.mockResolvedValue({});

    await recordInstagramComment("account_1", {
      commentId: "comment_2",
      mediaId: "media_1",
      text: "reply",
      username: "fan2",
      commentedAt: new Date("2026-09-27T12:00:00Z"),
      parentId: "comment_1",
    });

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { text: "reply", username: "fan2", parentId: "comment_1" },
      })
    );
  });

  it("never overwrites commentedAt on a repeated delivery", async () => {
    mockUpsert.mockResolvedValue({});

    await recordInstagramComment("account_1", {
      commentId: "comment_1",
      mediaId: "media_1",
      text: "quero o link (editado)",
      username: "fan1",
      commentedAt: new Date("2026-09-28T00:00:00Z"),
    });

    const call = mockUpsert.mock.calls[0][0];
    expect(call.update).not.toHaveProperty("commentedAt");
  });

  it("is idempotent: calling it twice for the same commentId still upserts (never creates a duplicate)", async () => {
    mockUpsert.mockResolvedValue({});
    const commentedAt = new Date("2026-09-27T12:00:00Z");
    const input = {
      commentId: "comment_1",
      mediaId: "media_1",
      text: "quero o link",
      commentedAt,
    };

    await recordInstagramComment("account_1", input);
    await recordInstagramComment("account_1", { ...input, text: "quero o link!" });

    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockUpsert.mock.calls[0][0].where).toEqual({ commentId: "comment_1" });
    expect(mockUpsert.mock.calls[1][0].where).toEqual({ commentId: "comment_1" });
    expect(mockUpsert.mock.calls[1][0].update.text).toBe("quero o link!");
  });

  it("swallows a write failure instead of throwing", async () => {
    mockUpsert.mockRejectedValue(new Error("connection lost"));

    await expect(
      recordInstagramComment("account_1", {
        commentId: "comment_1",
        mediaId: "media_1",
        text: "quero o link",
        commentedAt: new Date(),
      })
    ).resolves.toBeUndefined();
  });
});

describe("selectMediaWithComments", () => {
  it("keeps media with comments_count > 0", () => {
    const media = [{ id: "m1", comments_count: 3 }];
    expect(selectMediaWithComments(media)).toEqual(media);
  });

  it("drops media with comments_count === 0", () => {
    expect(selectMediaWithComments([{ id: "m1", comments_count: 0 }])).toEqual([]);
  });

  it("keeps media with comments_count missing (e.g. the Zernio listing)", () => {
    const media = [{ id: "m1" }];
    expect(selectMediaWithComments(media)).toEqual(media);
  });

  it("filters a mixed list", () => {
    const media = [
      { id: "m1", comments_count: 5 },
      { id: "m2", comments_count: 0 },
      { id: "m3" },
      { id: "m4", comments_count: 0 },
    ];
    expect(selectMediaWithComments(media).map((m) => m.id)).toEqual(["m1", "m3"]);
  });
});

describe("selectMissingMediaIds", () => {
  it("returns known media ids not present in the fresh listing (dark-post ads)", () => {
    const result = selectMissingMediaIds({
      knownMediaIds: ["ad_1", "feed_1", "ad_2"],
      listedMediaIds: ["feed_1", "feed_2"],
    });
    expect(result).toEqual(["ad_1", "ad_2"]);
  });

  it("returns nothing when every known media id is already in the listing", () => {
    const result = selectMissingMediaIds({
      knownMediaIds: ["feed_1"],
      listedMediaIds: ["feed_1", "feed_2"],
    });
    expect(result).toEqual([]);
  });

  it("caps how many extra media ids come back", () => {
    const result = selectMissingMediaIds({
      knownMediaIds: ["ad_1", "ad_2", "ad_3", "ad_4"],
      listedMediaIds: [],
      cap: 2,
    });
    expect(result).toEqual(["ad_1", "ad_2"]);
  });

  it("de-duplicates known media ids", () => {
    const result = selectMissingMediaIds({
      knownMediaIds: ["ad_1", "ad_1", "ad_2"],
      listedMediaIds: [],
    });
    expect(result).toEqual(["ad_1", "ad_2"]);
  });
});
