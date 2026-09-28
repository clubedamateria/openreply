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
// Rodada 5, achado 1: a wholesale `() => h.zernio` mock (the old code here)
// replaces EVERY export of this module for the whole test file — including
// `ZernioApiError`/`ZernioDeliveryUnconfirmedError`, which the engine's own
// `isExplicit4xxMetaError` check narrows on via `instanceof`. That made it
// structurally impossible for this suite to ever exercise the real classes.
// `importOriginal` keeps every real export (the two error classes, the
// `ZERNIO_CREATE_POST_TIMEOUT_MS` constant, etc.) and only swaps the three
// network-calling functions for the fakes.
vi.mock("@/lib/zernio/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/zernio/client")>();
  return {
    ...actual,
    createZernioPost: h.zernio.createZernioPost,
    getZernioPost: h.zernio.getZernioPost,
    listZernioPosts: h.zernio.listZernioPosts,
  };
});
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

const { runPublishScheduledCron, reconcileZernioByList, emptyResult } = await import("../lib/scheduled-posts/engine");
// Rodada 5, achado 1: the REAL ZernioApiError (not a fake `MetaApiError`) —
// kept alive by the partial `vi.mock` above (`importOriginal`), so this test
// exercises the actual `httpStatus` bug/fix instead of a class that could
// never have shown it either way. Imported dynamically, after `h` exists,
// for the same reason `runPublishScheduledCron` above is: a static
// top-level import would be hoisted above `const h = ...` and the
// `vi.mock("@/lib/zernio/client", ...)` factory (which references `h`)
// would run before `h` is initialized.
const { ZernioApiError } = await import("@/lib/zernio/client");

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
    // Rodada 5, achado 2/3: written at claim time alongside `zernioPostId` —
    // `null` here is the pre-claim state a SCHEDULED row starts in.
    zernioIdempotencyKey: null,
    claimedAt: null,
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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    // Rodada 5, achado 2/3: the idempotency key is a fresh randomUUID(), not
    // the old `sp-${id}-${attempts}` — captured here instead of hardcoded so
    // it can also be cross-checked against `metadata.claimKey` and the row's
    // own `zernioIdempotencyKey` below.
    expect(h.zernio.createZernioPost).toHaveBeenCalledTimes(1);
    const [, params, idempotencyKey] = h.zernio.createZernioPost.mock.calls[0];
    expect(idempotencyKey).toMatch(UUID_REGEX);
    expect(params).toMatchObject({
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
      // Rodada 5, achado 3: confirmed metadata field name (docs.zernio.com's
      // create-post reference) — lets reconciliation match this exact row by
      // id instead of only by content+media+time-window.
      metadata: { scheduledPostId: "tk_1", claimKey: idempotencyKey },
    });

    const row = h.rows.get("tk_1")!;
    expect(row.status).toBe("PUBLISHED");
    expect(row.zernioPostId).toBe("zp_1");
    expect(row.permalink).toBe("https://tiktok.com/@conta/video/123");
    // Rodada 5, achado 2/3: written in the SAME claim write as the status
    // transition, not left null.
    expect(row.zernioIdempotencyKey).toBe(idempotencyKey);
    expect(row.claimedAt).toEqual(NOW);
    expect((result as { published: number }).published).toBe(1);
  });

  it("generates a DIFFERENT idempotency key for each of two separately-claimed posts (rodada 5, achado 2)", async () => {
    seed(tiktokPost({ id: "tk_1" }), tiktokPost({ id: "tk_2" }));
    h.zernio.createZernioPost.mockResolvedValue(zernioPost());

    await tick(NOW);

    expect(h.zernio.createZernioPost).toHaveBeenCalledTimes(2);
    const key1 = h.zernio.createZernioPost.mock.calls[0][2];
    const key2 = h.zernio.createZernioPost.mock.calls[1][2];
    expect(key1).toMatch(UUID_REGEX);
    expect(key2).toMatch(UUID_REGEX);
    expect(key1).not.toBe(key2);
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

    const [, params, idempotencyKey] = h.zernio.createZernioPost.mock.calls[0];
    expect(idempotencyKey).toMatch(UUID_REGEX);
    expect(params).toMatchObject({
      platform: "youtube",
      accountId: "zernio_youtube_1",
      youtubeSpecificData: { title: "Um Reels sobre inglês", visibility: "public", madeForKids: false },
      metadata: { scheduledPostId: "yt_1", claimKey: idempotencyKey },
    });
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
    // Rodada 5, achado 1: the REAL ZernioApiError, not a fake `MetaApiError`
    // that could set `httpStatus` correctly regardless of whether the real
    // constructor did. This is the actual regression test for the bug (the
    // constructor used to leave `httpStatus` at 0, so this exact scenario
    // was never recognized as an explicit 4xx and the row got stuck in
    // PUBLISHING instead of failing here).
    seed(tiktokPost());
    h.zernio.createZernioPost.mockRejectedValue(new ZernioApiError(422));

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

  it("caps Zernio publishing at 3 posts per tick (achado 4) — a slow/240s createZernioPost call must never balloon a tick", async () => {
    // Unlike Instagram's prepare phase (a 15-minute look-ahead window), Zernio
    // publishing has no "prepare" step — only rows already due (scheduledFor
    // <= now) qualify, so every seeded post must be at or before `now`.
    const posts = Array.from({ length: 5 }, (_, i) =>
      tiktokPost({ id: `tk_${i}`, scheduledFor: new Date(NOW.getTime() - i * 1000) })
    );
    seed(...posts);
    h.zernio.createZernioPost.mockResolvedValue(zernioPost());

    await tick(NOW);

    expect(h.zernio.createZernioPost).toHaveBeenCalledTimes(3);
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

  it("matches FIRST by metadata.scheduledPostId, even when content/media would NOT match the fallback heuristic (achado 3)", async () => {
    seed(tiktokPost({ status: "PUBLISHING", zernioPostId: null, claimedAt: NOW, updatedAt: NOW }));
    h.zernio.listZernioPosts.mockResolvedValue([
      {
        _id: "zp_meta",
        status: "published",
        content: "uma legenda totalmente diferente", // would NOT match the content+media heuristic
        mediaItems: [{ type: "video", url: "https://outro-dominio.example/video.mp4" }],
        createdAt: NOW.toISOString(),
        metadata: { scheduledPostId: "tk_1", claimKey: "whatever" },
        platforms: [
          { platform: "tiktok", status: "published", platformPostId: "tt_meta", platformPostUrl: "https://tiktok.com/@conta/video/meta", errorMessage: null },
        ],
      },
    ]);

    const result = await tick(new Date(NOW.getTime() + 30_000));

    const row = h.rows.get("tk_1")!;
    expect(row.status).toBe("PUBLISHED");
    expect(row.zernioPostId).toBe("zp_meta");
    expect(row.permalink).toBe("https://tiktok.com/@conta/video/meta");
    expect((result as { reconciled: number }).reconciled).toBe(1);
  });

  it("uses claimedAt, not updatedAt, for the window and the list's fromDate (achado 3) — matters on a FAILED row, whose updatedAt is the failure moment, not the claim moment", async () => {
    const claimedAt = NOW;
    const failureMoment = new Date(NOW.getTime() + 40 * 60_000); // 40 min later
    const post = tiktokPost({ status: "FAILED", zernioPostId: null, claimedAt, updatedAt: failureMoment });
    seed(post);

    h.zernio.listZernioPosts.mockResolvedValue([
      {
        _id: "zp_found",
        status: "published",
        content: "Legenda TikTok",
        mediaItems: [{ type: "video", url: "https://media.local/video.mp4" }],
        // Created right after the CLAIM, well before the failure moment — an
        // `updatedAt`-based window (updatedAt - 2min, i.e. ~38 minutes after
        // this) would have wrongly excluded this exact candidate.
        createdAt: new Date(claimedAt.getTime() + 60_000).toISOString(),
        platforms: [
          { platform: "tiktok", status: "published", platformPostId: "tt_x", platformPostUrl: "https://tiktok.com/@conta/video/x", errorMessage: null },
        ],
      },
    ]);

    const outcome = await reconcileZernioByList(
      h.prisma as unknown as Parameters<typeof reconcileZernioByList>[0],
      post as unknown as Parameters<typeof reconcileZernioByList>[1],
      "zernio-key",
      new Date(failureMoment.getTime() + 60_000),
      emptyResult(),
      "FAILED"
    );

    expect(outcome).toBe("published");
    expect(h.zernio.listZernioPosts).toHaveBeenCalledWith(
      "zernio-key",
      expect.objectContaining({
        accountId: "zernio_tiktok_1",
        fromDate: new Date(claimedAt.getTime() - 5 * 60_000),
      })
    );
    expect(h.rows.get("tk_1")?.zernioPostId).toBe("zp_found");
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

describe("runPublishScheduledCron — Zernio reconciliation without ZERNIO_API_KEY (achado 8)", () => {
  it("still escalates a PUBLISHING row to FAILED+outcomeUncertain after 30+ minutes, even with no API key at all", async () => {
    // Rodada 5, achado 8: an early `return` at the top of
    // reconcileZernioPublishing used to skip the WHOLE loop whenever
    // ZERNIO_API_KEY was missing — this row would have stayed PUBLISHING
    // forever before the fix, despite the old code's own comment claiming
    // STUCK_POLLING_THRESHOLD_MS "still eventually escalates" it.
    h.getZernioApiKey.mockReturnValue(null);
    seed(tiktokPost({ status: "PUBLISHING", zernioPostId: "zp_1", updatedAt: NOW }));

    const result = await tick(new Date(NOW.getTime() + 31 * 60_000));

    const row = h.rows.get("tk_1")!;
    expect(row.status).toBe("FAILED");
    expect(row.outcomeUncertain).toBe(true);
    expect((result as { failed: number }).failed).toBe(1);
    expect(h.sendZernioPublishFailureAlert).toHaveBeenCalledTimes(1);
    expect(h.zernio.getZernioPost).not.toHaveBeenCalled();
  });

  it("does NOT escalate a PUBLISHING row before the 30-minute threshold, even with no API key", async () => {
    h.getZernioApiKey.mockReturnValue(null);
    seed(tiktokPost({ status: "PUBLISHING", zernioPostId: "zp_1", updatedAt: NOW }));

    await tick(new Date(NOW.getTime() + 5 * 60_000));

    expect(h.rows.get("tk_1")?.status).toBe("PUBLISHING");
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

describe("runPublishScheduledCron — backfillMissingZernioPermalinks (achado 7)", () => {
  it("fills in a TikTok/YouTube permalink still missing after publish, via GET /posts/{id}", async () => {
    seed(
      tiktokPost({
        id: "tk_published",
        status: "PUBLISHED",
        zernioPostId: "zp_done",
        permalink: null,
        publishedAt: new Date(NOW.getTime() - 60 * 60_000), // 1h ago, within the 24h window
        updatedAt: new Date(NOW.getTime() - 60 * 60_000),
      })
    );
    h.zernio.getZernioPost.mockResolvedValue(
      zernioPost({
        platforms: [
          { platform: "tiktok", status: "published", platformPostId: "tt_1", platformPostUrl: "https://tiktok.com/@conta/video/1", errorMessage: null },
        ],
      })
    );

    await tick(NOW);

    expect(h.zernio.getZernioPost).toHaveBeenCalledWith("zernio-key", "zp_done");
    expect(h.rows.get("tk_published")?.permalink).toBe("https://tiktok.com/@conta/video/1");
  });

  it("does not touch a row whose publishedAt is older than 24h", async () => {
    seed(
      tiktokPost({
        id: "tk_old",
        status: "PUBLISHED",
        zernioPostId: "zp_old",
        permalink: null,
        publishedAt: new Date(NOW.getTime() - 25 * 60 * 60_000),
        updatedAt: new Date(NOW.getTime() - 25 * 60 * 60_000),
      })
    );

    await tick(NOW);

    expect(h.zernio.getZernioPost).not.toHaveBeenCalled();
    expect(h.rows.get("tk_old")?.permalink).toBeNull();
  });

  it("does nothing when ZERNIO_API_KEY is missing, without throwing", async () => {
    h.getZernioApiKey.mockReturnValue(null);
    seed(
      tiktokPost({
        id: "tk_published",
        status: "PUBLISHED",
        zernioPostId: "zp_done",
        permalink: null,
        publishedAt: new Date(NOW.getTime() - 60 * 60_000),
        updatedAt: new Date(NOW.getTime() - 60 * 60_000),
      })
    );

    await expect(tick(NOW)).resolves.toBeTruthy();
    expect(h.zernio.getZernioPost).not.toHaveBeenCalled();
  });
});
