import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * PATCH /api/scheduled-posts/[id] — row actions from the panel. Covers
 * Rodada 3, achado 1 (a FAILED post whose previous attempt is uncertain
 * refuses to blindly recreate its container) and achado 4/7 (files must
 * still exist to retry; FAILED is cancelable again).
 */

const { mockPrisma, mockGetWorkspaceId, mockDecryptToken, mockGetContainerStatus, mockReconcile, mockMediaFileExists } =
  vi.hoisted(() => ({
    mockPrisma: {
      scheduledPost: { findFirst: vi.fn(), updateMany: vi.fn() },
    },
    mockGetWorkspaceId: vi.fn(async () => "ws_1" as string | null),
    mockDecryptToken: vi.fn((token: string) => token),
    mockGetContainerStatus: vi.fn(),
    mockReconcile: vi.fn(async () => undefined),
    mockMediaFileExists: vi.fn(async () => true),
  }));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ getCurrentWorkspaceId: mockGetWorkspaceId }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));
vi.mock("@/lib/meta/client", () => ({ getContainerStatus: mockGetContainerStatus }));
vi.mock("@/lib/scheduled-posts/engine", () => ({
  reconcilePublishedContainer: mockReconcile,
  emptyResult: () => ({
    prepared: 0,
    published: 0,
    failed: 0,
    deferredQuota: 0,
    reconciled: 0,
    cleaned: 0,
    orphansDeleted: 0,
  }),
}));
vi.mock("@/lib/storage/media", () => ({ mediaFileExists: mockMediaFileExists }));

const { PATCH } = await import("../app/api/scheduled-posts/[id]/route");

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/scheduled-posts/p1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function basePost(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    workspaceId: "ws_1",
    status: "FAILED",
    containerId: "C1",
    outcomeUncertain: false,
    storagePaths: ["aaaaaaaaaaaaaaaa-aaaaaa.mp4"],
    coverPath: null,
    instagramAccount: {
      provider: "META",
      accessToken: "token",
      instagramId: "ig1",
      username: "conta",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWorkspaceId.mockResolvedValue("ws_1");
  mockDecryptToken.mockImplementation((token: string) => token);
  mockMediaFileExists.mockResolvedValue(true);
  mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
});

describe("PATCH /api/scheduled-posts/[id] — cancel (Rodada 3, achado 7)", () => {
  it("accepts canceling a FAILED post again", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(basePost({ status: "FAILED" }));
    const res = await PATCH(patchRequest({ action: "cancel" }), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(200);
    expect(mockPrisma.scheduledPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p1", status: { in: ["SCHEDULED", "PREPARING", "FAILED"] } } })
    );
  });
});

describe("PATCH /api/scheduled-posts/[id] — retry safety (Rodada 3, achado 1)", () => {
  it("retries normally when the post has no containerId (nothing to verify)", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(
      basePost({ containerId: null, outcomeUncertain: false })
    );
    const res = await PATCH(patchRequest({ action: "retry" }), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(200);
    expect(mockGetContainerStatus).not.toHaveBeenCalled();
  });

  it("retries normally when outcomeUncertain is false, without ever checking Meta", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(basePost({ outcomeUncertain: false }));
    const res = await PATCH(patchRequest({ action: "retry" }), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(200);
    expect(mockGetContainerStatus).not.toHaveBeenCalled();
  });

  it("refuses to retry an uncertain outcome when Meta can't be reached to confirm", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(basePost({ outcomeUncertain: true }));
    mockGetContainerStatus.mockRejectedValue(new Error("Meta fora do ar"));

    const res = await PATCH(patchRequest({ action: "retry" }), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.outcomeUncertain).toBe(true);
    // Never zeroed containerId/mediaId — the row is untouched, safe to check
    // again later.
    expect(mockPrisma.scheduledPost.updateMany).not.toHaveBeenCalled();
  });

  it("reconciles as PUBLISHED (never retries) when the old container turns out to have published", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(basePost({ outcomeUncertain: true }));
    mockGetContainerStatus.mockResolvedValue({ status_code: "PUBLISHED" });

    const res = await PATCH(patchRequest({ action: "retry" }), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(409);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile.mock.calls[0]?.[5]).toBe("FAILED"); // fromStatus
    // The blind zero-and-retry updateMany never runs.
    expect(mockPrisma.scheduledPost.updateMany).not.toHaveBeenCalled();
  });

  it("allows a normal retry once the old container is confirmed NOT published", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(basePost({ outcomeUncertain: true }));
    mockGetContainerStatus.mockResolvedValue({ status_code: "ERROR" });

    const res = await PATCH(patchRequest({ action: "retry" }), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(200);
    expect(mockPrisma.scheduledPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SCHEDULED", containerId: null, outcomeUncertain: false }),
      })
    );
  });

  it('force: true skips the check entirely — the "já conferi" override', async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(basePost({ outcomeUncertain: true }));

    const res = await PATCH(
      patchRequest({ action: "retry", force: true }),
      { params: Promise.resolve({ id: "p1" }) }
    );
    expect(res.status).toBe(200);
    expect(mockGetContainerStatus).not.toHaveBeenCalled();
  });

  it("Rodada 3, achado 4: refuses to retry when a storage file has expired off disk", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(basePost({ outcomeUncertain: false }));
    mockMediaFileExists.mockResolvedValue(false);

    const res = await PATCH(patchRequest({ action: "retry" }), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/expirou/);
    expect(mockPrisma.scheduledPost.updateMany).not.toHaveBeenCalled();
  });

  it("does not check Meta at all for a Zernio-connected account (nothing to publish to)", async () => {
    mockPrisma.scheduledPost.findFirst.mockResolvedValue(
      basePost({ outcomeUncertain: true, instagramAccount: { provider: "ZERNIO", accessToken: "t", instagramId: "i", username: "c" } })
    );
    const res = await PATCH(patchRequest({ action: "retry" }), { params: Promise.resolve({ id: "p1" }) });
    expect(res.status).toBe(200);
    expect(mockGetContainerStatus).not.toHaveBeenCalled();
  });
});
