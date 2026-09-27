import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mp4 = (n: number) => `${n.toString(16).padStart(16, "0")}-aaaaaa.mp4`;

const { mockPrisma, mockActor } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findFirst: vi.fn() },
    scheduledPost: { findMany: vi.fn(), create: vi.fn() },
  },
  mockActor: vi.fn(async () => ({ source: "LOTE" as const })),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/scheduled-posts/auth", () => ({ resolveScheduledPostActor: mockActor }));
vi.mock("@/lib/storage/media", () => ({
  mediaFileExists: vi.fn(async () => true),
  hashMediaFile: vi.fn(async (filename: string) => `hash-of-${filename}`),
  getMediaPublicUrl: vi.fn((filename: string) => `http://test.local/media/${filename}`),
}));

const { POST } = await import("../app/api/scheduled-posts/route");

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/scheduled-posts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const FUTURE = "2026-10-01T15:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  mockActor.mockResolvedValue({ source: "LOTE" });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({
    id: "acc_1",
    workspaceId: "ws_1",
  });
  mockPrisma.scheduledPost.create.mockImplementation(async ({ data }: { data: unknown }) => ({
    id: "post_new",
    ...(data as object),
  }));
});

describe("POST /api/scheduled-posts — permanent dedup (bloqueador 3)", () => {
  it("creates normally when no matching content hash exists", async () => {
    mockPrisma.scheduledPost.findMany.mockResolvedValue([]);

    const res = await POST(
      postRequest({
        mediaType: "REELS",
        storagePaths: [mp4(1)],
        caption: "Legenda",
        scheduledFor: FUTURE,
        username: "conta",
      })
    );

    expect(res.status).toBe(201);
    expect(mockPrisma.scheduledPost.create).toHaveBeenCalledTimes(1);
  });

  it("rejects with 409 when another non-CANCELED post has the exact same hash set", async () => {
    mockPrisma.scheduledPost.findMany.mockResolvedValue([
      { id: "post_existing", contentHash: [`hash-of-${mp4(1)}`] },
    ]);

    const res = await POST(
      postRequest({
        mediaType: "REELS",
        storagePaths: [mp4(1)],
        caption: "Legenda",
        scheduledFor: FUTURE,
        username: "conta",
      })
    );

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.duplicateId).toBe("post_existing");
    expect(mockPrisma.scheduledPost.create).not.toHaveBeenCalled();
  });

  it("does not flag a partial hash overlap as a duplicate (different set)", async () => {
    // Same GIN pre-filter (`hasSome`) would return this candidate, but its
    // set isn't equal — a carousel sharing one slide with another post is
    // not the same post.
    mockPrisma.scheduledPost.findMany.mockResolvedValue([
      { id: "post_existing", contentHash: [`hash-of-${mp4(1)}`, `hash-of-${mp4(2)}`] },
    ]);

    const res = await POST(
      postRequest({
        mediaType: "REELS",
        storagePaths: [mp4(1)],
        caption: "Legenda",
        scheduledFor: FUTURE,
        username: "conta",
      })
    );

    expect(res.status).toBe(201);
  });

  it("bypasses the dedup check when force: true is sent", async () => {
    mockPrisma.scheduledPost.findMany.mockResolvedValue([
      { id: "post_existing", contentHash: [`hash-of-${mp4(1)}`] },
    ]);

    const res = await POST(
      postRequest({
        mediaType: "REELS",
        storagePaths: [mp4(1)],
        caption: "Legenda",
        scheduledFor: FUTURE,
        username: "conta",
        force: true,
      })
    );

    expect(res.status).toBe(201);
    // force: true skips the dedup lookup entirely.
    expect(mockPrisma.scheduledPost.findMany).not.toHaveBeenCalled();
  });

  it("rejects when a storage path doesn't exist on disk, before ever hashing or querying dedup", async () => {
    const { mediaFileExists } = await import("@/lib/storage/media");
    vi.mocked(mediaFileExists).mockResolvedValueOnce(false);

    const res = await POST(
      postRequest({
        mediaType: "REELS",
        storagePaths: [mp4(1)],
        caption: "Legenda",
        scheduledFor: FUTURE,
        username: "conta",
      })
    );

    expect(res.status).toBe(400);
    expect(mockPrisma.scheduledPost.create).not.toHaveBeenCalled();
  });

  it("rejects a storagePaths entry that isn't a valid content-addressed filename", async () => {
    const res = await POST(
      postRequest({
        mediaType: "REELS",
        storagePaths: ["../../etc/passwd"],
        caption: "Legenda",
        scheduledFor: FUTURE,
        username: "conta",
      })
    );

    expect(res.status).toBe(400);
  });

  it("rejects a scheduledFor more than 5 minutes in the past", async () => {
    const res = await POST(
      postRequest({
        mediaType: "REELS",
        storagePaths: [mp4(1)],
        caption: "Legenda",
        scheduledFor: new Date(Date.now() - 60 * 60_000).toISOString(),
        username: "conta",
      })
    );

    expect(res.status).toBe(400);
  });
});
