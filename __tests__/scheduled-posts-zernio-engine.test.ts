import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakeScheduledPostDb, type Row } from "./helpers/fake-scheduled-post-db";

/**
 * Fase 4: TikTok/YouTube Shorts via Zernio. Same fake-DB harness as
 * scheduled-posts-engine.test.ts/scheduled-posts-double-publish.test.ts,
 * replaying the real `runPublishScheduledCron` — see
 * docs/2026-09-27-agendados-comentarios.md, "Fase 4", for the design this
 * proves.
 */

const h = createFakeScheduledPostDb();

vi.mock("@/lib/db/client", () => ({ prisma: h.prisma }));
vi.mock("@/lib/scheduled-posts/advisory-lock", () => ({ withAdvisoryLock: h.withAdvisoryLock }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: h.decryptToken }));
vi.mock("@/lib/meta/client", () => h.meta);
vi.mock("@/lib/zernio/client", () => h.zernio);
vi.mock("@/lib/env", () => ({ getZernioApiKey: h.getZernioApiKey }));
vi.mock("@/lib/storage/media", () => ({
  deleteMediaFiles: h.deleteMediaFiles,
  listMediaFiles: h.listMediaFiles,
}));
vi.mock("@/lib/email/alert", () => ({
  sendPublishFailureAlert: h.sendPublishFailureAlert,
  sendPublishWarningAlert: h.sendPublishWarningAlert,
  sendZernioPublishFailureAlert: h.sendZernioPublishFailureAlert,
  sendZernioPublishWarningAlert: h.sendZernioPublishWarningAlert,
}));

const { runPublishScheduledCron } = await import("../lib/scheduled-posts/engine");

const NOW = new Date("2026-10-01T15:00:00.000Z");
async function tick(now: Date) {
  h.setNow(now);
  return runPublishScheduledCron(now);
}

function tiktokPost(overrides: Row = {}): Row {
  return {
    id: "tk_1",
    workspaceId: "ws_1",
    platform: "TIKTOK",
    mediaType: "REELS",
    mediaUrls: ["https://media.local/video.mp4"],
    storagePaths: ["abc0123456789def-xxxxxx.mp4"],
    coverPath: null,
    caption: "Legenda TikTok",
    shareToFeed: true,
    coverUrl: null,
    attempts: 0,
    zernioAccountId: "zernio_tiktok_1",
    zernioPostId: null,
    platformSettings: {
      privacyLevel: "PUBLIC_TO_EVERYONE",
      allowComment: true,
      allowDuet: true,
      allowStitch: true,
      consentGiven: true,
    },
    containerId: null,
    childContainerIds: [],
    mediaId: null,
    permalink: null,
    scheduledFor: NOW,
    status: "SCHEDULED",
    publishedAt: null,
    updatedAt: NOW,
    instagramAccount: null,
    ...overrides,
  };
}

function youtubePost(overrides: Row = {}): Row {
  return tiktokPost({
    id: "yt_1",
    platform: "YOUTUBE",
    zernioAccountId: "zernio_youtube_1",
    caption: "Legenda YouTube",
    platformSettings: {
      title: "Um Reels sobre inglês",
      visibility: "public",
      madeForKids: false,
    },
    ...overrides,
  });
}

function seed(...posts: Row[]) {
  h.rows.clear();
  for (const p of posts) h.rows.set(p.id as string, p);
}

function zernioPost(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: "zp_1",
    status: "published",
    platforms: [
      {
        platform: "tiktok",
        status: "published",
        platformPostId: "tt_123",
        platformPostUrl: "https://tiktok.com/@conta/video/123",
        errorMessage: null,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.clear();
  h.getZernioApiKey.mockReturnValue("zernio-key");
  h.zernio.listZernioPosts.mockResolvedValue([]);
});

describe("runPublishScheduledCron — Zernio publish phase (TikTok/YouTube)", () => {
  it("publishes a due TikTok post straight from SCHEDULED, writing zernioPostId and permalink", async () => {
    seed(tiktokPost());
    h.zernio.createZernioPost.mockResolvedValue(zernioPost());

    const result = await tick(NOW);

    expect(h.zernio.createZernioPost).toHaveBeenCalledWith(
      "zernio-key",
      expect.objectContaining({
        content: "Legenda TikTok",
        mediaUrl: "https://media.local/video.mp4",
        platform: "tiktok",
        accountId: "zernio_tiktok_1",
        tiktokSettings: {
          privacy_level: "PUBLIC_TO_EVERYONE",
          allow_comment: true,
          allow_duet: true,
          allow_stitch: true,
          content_preview_confirmed: true,
          express_consent_given: true,
        },
      }),
      "sp-tk_1-0"
    );
    const row = h.rows.get("tk_1")!;
    expect(row.status).toBe("PUBLISHED");
    expect(row.zernioPostId).toBe("zp_1");
    expect(row.permalink).toBe("https://tiktok.com/@conta/video/123");
    expect((result as { published: number }).published).toBe(1);
  });

  it("publishes a due YouTube Shorts post with platformSpecificData built from platformSettings", async () => {
    seed(youtubePost());
    h.zernio.createZernioPost.mockResolvedValue(
      zernioPost({
        _id: "zp_2",
        platforms: [
          {
            platform: "youtube",
            status: "published",
            platformPostId: "yt_abc",
            platformPostUrl: "https://youtube.com/shorts/abc",
            errorMessage: null,
          },
        ],
      })
    );

    await tick(NOW);

    expect(h.zernio.createZernioPost).toHaveBeenCalledWith(
      "zernio-key",
      expect.objectContaining({
        platform: "youtube",
        accountId: "zernio_youtube_1",
        youtubeSpecificData: { title: "Um Reels sobre inglês", visibility: "public", madeForKids: false },
      }),
      "sp-yt_1-0"
    );
    const row = h.rows.get("yt_1")!;
    expect(row.status).toBe("PUBLISHED");
    expect(row.permalink).toBe("https://youtube.com/shorts/abc");
  });

  it("leaves the row PENDING (PUBLISHING, no permalink) when Zernio itself reports the platform still processing", async () => {
    seed(tiktokPost());
    h.zernio.createZernioPost.mockResolvedValue(
      zernioPost({ platforms: [{ platform: "tiktok", status: "processing", platformPostId: null, platformPostUrl: null, errorMessage: null }] })
    );

    await tick(NOW);

    const row = h.rows.get("tk_1")!;
    expect(row.status).toBe("PUBLISHING");
    expect(row.zernioPostId).toBe("zp_1"); // written immediately, before the outcome is known
    expect(row.permalink).toBeNull();
  });

  it("never repeats POST /posts when the response is lost (network error) — row stays PUBLISHING with no zernioPostId", async () => {
    seed(tiktokPost());
    h.zernio.createZernioPost.mockRejectedValue(new TypeError("fetch failed"));

    const result = await tick(NOW);

    const row = h.rows.get("tk_1")!;
    expect(row.status).toBe("PUBLISHING");
    expect(row.zernioPostId).toBeNull();
    expect((result as { failed: number }).failed).toBe(0);

    // A second tick must NOT call createZernioPost again for this row — the
    // claim into PUBLISHING already happened, and publishZernioReadyPosts
    // only looks at SCHEDULED rows.
    await tick(new Date(NOW.getTime() + 60_000));
    expect(h.zernio.createZernioPost).toHaveBeenCalledTimes(1);
  });

  it("fails immediately (no retry) on an explicit 4xx from Zernio's POST /posts", async () => {
    seed(tiktokPost());
    h.zernio.createZernioPost.mockRejectedValue(new h.meta.MetaApiError("rejected", 422));

    const result = await tick(NOW);

    const row = h.rows.get("tk_1")!;
    expect(row.status).toBe("FAILED");
    expect(row.zernioPostId).toBeNull();
    expect((result as { failed: number }).failed).toBe(1);
    expect(h.sendZernioPublishFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledPostId: "tk_1", platform: "TikTok" })
    );
  });

  it("fails immediately when ZERNIO_API_KEY is not configured, without ever calling createZernioPost", async () => {
    h.getZernioApiKey.mockReturnValue(null);
    seed(tiktokPost());

    const result = await tick(NOW);

    expect(h.zernio.createZernioPost).not.toHaveBeenCalled();
    expect(h.rows.get("tk_1")?.status).toBe("FAILED");
    expect((result as { failed: number }).failed).toBe(1);
  });

  it("fails immediately when platformSettings fails schema validation (e.g. TikTok consent missing), without calling Zernio", async () => {
    seed(tiktokPost({ platformSettings: { privacyLevel: "PUBLIC_TO_EVERYONE", consentGiven: false } }));

    const result = await tick(NOW);

    expect(h.zernio.createZernioPost).not.toHaveBeenCalled();
    const row = h.rows.get("tk_1")!;
    expect(row.status).toBe("FAILED");
    expect((result as { failed: number }).failed).toBe(1);
  });

  it("caps Zernio publishing at 10 posts per tick, same as the Instagram publish phase", async () => {
    // Unlike Instagram's prepare phase (a 15-minute look-ahead window), Zernio
    // publishing has no "prepare" step — only rows already due (scheduledFor
    // <= now) qualify, so every seeded post must be at or before `now`.
    const posts = Array.from({ length: 12 }, (_, i) =>
      tiktokPost({ id: `tk_${i}`, scheduledFor: new Date(NOW.getTime() - i * 1000) })
    );
    seed(...posts);
    h.zernio.createZernioPost.mockResolvedValue(zernioPost());

    await tick(NOW);

    expect(h.zernio.createZernioPost).toHaveBeenCalledTimes(10);
  });
});

describe("runPublishScheduledCron — Zernio reconciliation (TikTok/YouTube)", () => {
  it("polls GET /posts/{id} every tick and resolves to PUBLISHED once Zernio reports it", async () => {
    seed(tiktokPost({ status: "PUBLISHING", zernioPostId: "zp_1", updatedAt: NOW }));
    h.zernio.getZernioPost.mockResolvedValue(
      zernioPost({ platforms: [{ platform: "tiktok", status: "processing", platformPostId: null, platformPostUrl: null, errorMessage: null }] })
    );

    await tick(NOW);
    expect(h.rows.get("tk_1")?.status).toBe("PUBLISHING");

    h.zernio.getZernioPost.mockResolvedValue(zernioPost());
    const result = await tick(new Date(NOW.getTime() + 30_000));

    const row = h.rows.get("tk_1")!;
    expect(row.status).toBe("PUBLISHED");
    expect(row.permalink).toBe("https://tiktok.com/@conta/video/123");
    expect((result as { reconciled: number }).reconciled).toBe(1);
    // Never a second POST — polling only ever calls GET /posts/{id}.
    expect(h.zernio.createZernioPost).not.toHaveBeenCalled();
  });

  it("resolves to FAILED when Zernio's own platform status comes back failed", async () => {
    seed(tiktokPost({ status: "PUBLISHING", zernioPostId: "zp_1", updatedAt: NOW }));
    h.zernio.getZernioPost.mockResolvedValue(
      zernioPost({
        platforms: [
          { platform: "tiktok", status: "failed", platformPostId: null, platformPostUrl: null, errorMessage: "Vídeo rejeitado pelo TikTok" },
        ],
      })
    );

    const result = await tick(NOW);

    const row = h.rows.get("tk_1")!;
    expect(row.status).toBe("FAILED");
    expect(row.errorMessage).toBe("Vídeo rejeitado pelo TikTok");
    expect((result as { failed: number }).failed).toBe(1);
  });

  it("recovers a lost POST response via GET /posts (list), matched by content + media URL + time window", async () => {
    seed(tiktokPost({ status: "PUBLISHING", zernioPostId: null, updatedAt: NOW }));
    h.zernio.listZernioPosts.mockResolvedValue([
      {
        _id: "zp_found",
        status: "published",
        content: "Legenda TikTok",
        mediaItems: [{ type: "video", url: "https://media.local/video.mp4" }],
        createdAt: NOW.toISOString(),
        platforms: [
          { platform: "tiktok", status: "published", platformPostId: "tt_999", platformPostUrl: "https://tiktok.com/@conta/video/999", errorMessage: null },
        ],
      },
    ]);

    const result = await tick(new Date(NOW.getTime() + 30_000));

    const row = h.rows.get("tk_1")!;
    expect(row.status).toBe("PUBLISHED");
    expect(row.zernioPostId).toBe("zp_found");
    expect(row.permalink).toBe("https://tiktok.com/@conta/video/999");
    expect((result as { reconciled: number }).reconciled).toBe(1);
    expect(h.sendZernioPublishWarningAlert).toHaveBeenCalledTimes(1);
    expect(h.zernio.createZernioPost).not.toHaveBeenCalled();
  });

  it("does not adopt a list candidate outside the claim-moment time window", async () => {
    seed(tiktokPost({ status: "PUBLISHING", zernioPostId: null, updatedAt: NOW }));
    h.zernio.listZernioPosts.mockResolvedValue([
      {
        _id: "zp_old",
        status: "published",
        content: "Legenda TikTok",
        mediaItems: [{ type: "video", url: "https://media.local/video.mp4" }],
        createdAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(), // 1h before the claim
        platforms: [{ platform: "tiktok", status: "published", platformPostId: "tt_old", platformPostUrl: "https://x", errorMessage: null }],
      },
    ]);

    await tick(new Date(NOW.getTime() + 30_000));

    expect(h.rows.get("tk_1")?.status).toBe("PUBLISHING");
    expect(h.rows.get("tk_1")?.zernioPostId).toBeNull();
  });

  it("escalates to FAILED+outcomeUncertain once a zernioPostId-less row has been stuck 30+ minutes with no list match", async () => {
    seed(tiktokPost({ status: "PUBLISHING", zernioPostId: null, updatedAt: NOW }));
    h.zernio.listZernioPosts.mockResolvedValue([]);

    const result = await tick(new Date(NOW.getTime() + 31 * 60_000));

    const row = h.rows.get("tk_1")!;
    expect(row.status).toBe("FAILED");
    expect(row.outcomeUncertain).toBe(true);
    expect((result as { failed: number }).failed).toBe(1);
  });

  it("escalates to FAILED+outcomeUncertain once a known zernioPostId keeps failing to poll for 30+ minutes", async () => {
    seed(tiktokPost({ status: "PUBLISHING", zernioPostId: "zp_1", updatedAt: NOW }));
    h.zernio.getZernioPost.mockRejectedValue(new Error("Zernio fora do ar"));

    const result = await tick(new Date(NOW.getTime() + 31 * 60_000));

    const row = h.rows.get("tk_1")!;
    expect(row.status).toBe("FAILED");
    expect(row.outcomeUncertain).toBe(true);
    expect((result as { failed: number }).failed).toBe(1);
  });
});

describe("runPublishScheduledCron — shared-file cleanup across platforms (Fase 4)", () => {
  it("keeps a file on disk for a TikTok post scheduled tomorrow, even though an Instagram post of the same file published 2 days ago is past its own retention", async () => {
    seed(
      {
        id: "ig_old",
        workspaceId: "ws_1",
        platform: "INSTAGRAM",
        mediaType: "REELS",
        mediaUrls: ["https://media.local/shared.mp4"],
        storagePaths: ["shared0123456789ab-xxxxxx.mp4"],
        coverPath: null,
        caption: "Legenda IG",
        shareToFeed: true,
        coverUrl: null,
        attempts: 0,
        containerId: null,
        childContainerIds: [],
        mediaId: "M1",
        permalink: "https://instagram.com/p/x",
        scheduledFor: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
        status: "PUBLISHED",
        publishedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
        instagramAccount: { provider: "META", accessToken: "t", instagramId: "ig", username: "conta" },
      },
      tiktokPost({
        id: "tk_tomorrow",
        storagePaths: ["shared0123456789ab-xxxxxx.mp4"],
        status: "SCHEDULED",
        scheduledFor: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
        updatedAt: NOW,
      })
    );

    await tick(NOW);

    // The Instagram row is past its 24h retention and eligible for cleanup,
    // but the file is still named by the TikTok row (scheduled, not
    // touched by cleanup at all) — it must survive.
    expect(h.deleteMediaFiles).not.toHaveBeenCalled();
    const igRow = h.rows.get("ig_old")!;
    // The IG row's OWN pointer is still cleared (Fase-4 cleanup semantics
    // unchanged for the post being cleaned itself) even though the file on
    // disk survives via the other post's reference.
    expect(igRow.storagePaths).toEqual([]);
    const tkRow = h.rows.get("tk_tomorrow")!;
    expect(tkRow.storagePaths).toEqual(["shared0123456789ab-xxxxxx.mp4"]);
  });
});
