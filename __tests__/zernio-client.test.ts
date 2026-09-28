import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ZernioApiError,
  ZERNIO_CREATE_POST_TIMEOUT_MS,
  createZernioPost,
  listZernioPosts,
  getTikTokCreatorInfo,
} from "@/lib/zernio/client";

/**
 * Rodada 5 (revisão adversarial da Fase 4). Unit-level coverage for
 * lib/zernio/client.ts itself, independent of the engine — see
 * __tests__/scheduled-posts-zernio-engine.test.ts for the end-to-end version
 * of achado 1 (an explicit 4xx from createZernioPost failing the row
 * immediately, not staying "ambiguous").
 */

describe("ZernioApiError — achado 1 (httpStatus was always 0)", () => {
  it("sets httpStatus to the real HTTP status, not the MetaApiError default of 0", () => {
    const err = new ZernioApiError(422);
    expect(err.httpStatus).toBe(422);
  });

  it("keeps .code equal to the status too — lib/queue/dm-worker.ts and lib/instagram/send-messages.ts's pre-existing Zernio-inbox flow branches on .code, unrelated to this fix", () => {
    const err = new ZernioApiError(503);
    expect(err.code).toBe(503);
    expect(err.httpStatus).toBe(503);
  });

  it("a 4xx status falls in the httpStatus 400-499 range isExplicit4xxMetaError checks", () => {
    const err = new ZernioApiError(404);
    expect(err.httpStatus).toBeGreaterThanOrEqual(400);
    expect(err.httpStatus).toBeLessThan(500);
  });

  it("a 5xx status does NOT fall in that range — still ambiguous, same as before", () => {
    const err = new ZernioApiError(502);
    expect(err.httpStatus).toBeGreaterThanOrEqual(500);
  });
});

describe("createZernioPost", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ post: { _id: "zp_1", status: "published", platforms: [] } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends metadata in the request body — confirmed field name (docs.zernio.com create-post reference)", async () => {
    await createZernioPost(
      "key",
      {
        content: "legenda",
        mediaUrl: "https://media.local/v.mp4",
        platform: "tiktok",
        accountId: "acc_1",
        metadata: { scheduledPostId: "sp_1", claimKey: "11111111-1111-1111-1111-111111111111" },
      },
      "idem-1"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.metadata).toEqual({ scheduledPostId: "sp_1", claimKey: "11111111-1111-1111-1111-111111111111" });
  });

  it("omits metadata entirely when the caller doesn't pass it", async () => {
    await createZernioPost(
      "key",
      { content: "legenda", mediaUrl: "https://media.local/v.mp4", platform: "tiktok", accountId: "acc_1" },
      "idem-1"
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.metadata).toBeUndefined();
  });

  it("uses the dedicated 240s timeout, not the 30s default every other Zernio call uses (achado 4)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    await createZernioPost(
      "key",
      { content: "legenda", mediaUrl: "https://media.local/v.mp4", platform: "tiktok", accountId: "acc_1" },
      "idem-1"
    );
    expect(timeoutSpy).toHaveBeenCalledWith(ZERNIO_CREATE_POST_TIMEOUT_MS);
    expect(ZERNIO_CREATE_POST_TIMEOUT_MS).toBe(240_000);
    timeoutSpy.mockRestore();
  });
});

describe("listZernioPosts — achado 3/10 (fromDate)", () => {
  it("sends fromDate as an ISO 8601 query param when provided", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ posts: [] }) }));
    vi.stubGlobal("fetch", fetchMock);

    const fromDate = new Date("2026-10-01T14:55:00.000Z");
    await listZernioPosts("key", { accountId: "acc_1", fromDate });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain(`fromDate=${encodeURIComponent(fromDate.toISOString())}`);
    vi.unstubAllGlobals();
  });

  it("omits fromDate when not provided (unchanged behavior)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ posts: [] }) }));
    vi.stubGlobal("fetch", fetchMock);

    await listZernioPosts("key", { accountId: "acc_1" });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).not.toContain("fromDate");
    vi.unstubAllGlobals();
  });
});

describe("getTikTokCreatorInfo — achado 5", () => {
  it("calls GET /accounts/{accountId}/tiktok/creator-info", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        creator: { nickname: "conta", isVerified: false, canPostMore: true },
        privacyLevels: [],
        postingLimits: { maxVideoDurationSec: 600, interactionSettings: {} },
        commercialContentTypes: [],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const info = await getTikTokCreatorInfo("key", "acc_123");

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://zernio.com/api/v1/accounts/acc_123/tiktok/creator-info");
    expect(info.creator.nickname).toBe("conta");
    vi.unstubAllGlobals();
  });
});
