import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mp4 = (n: number) => `${n.toString(16).padStart(16, "0")}-aaaaaa.mp4`;

// Simulates Postgres's per-key `pg_advisory_xact_lock`: calls sharing the
// same lock-key value queue up on a module-level chain, and only release
// once the *whole* transaction callback that acquired the lock settles
// (mirroring a real xact lock, released at COMMIT/ROLLBACK, not right after
// the lock statement) — see the race test below (Rodada 3, achado 3).
const lockChains = new Map<string, Promise<void>>();

const { mockPrisma, mockActor } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findFirst: vi.fn() },
    scheduledPost: { findMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
  mockActor: vi.fn(async () => ({ source: "LOTE" as const })),
}));

mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => {
  const lockState: { release: (() => void) | null } = { release: null };
  const txExecuteRaw = vi.fn(async (_strings: unknown, ...values: unknown[]) => {
    const key = String(values[0]);
    const prev = lockChains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    lockChains.set(
      key,
      prev.then(() => gate)
    );
    await prev;
    lockState.release = release;
  });
  const tx = { ...mockPrisma, $executeRaw: txExecuteRaw };
  try {
    return await fn(tx);
  } finally {
    lockState.release?.();
  }
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/scheduled-posts/auth", () => ({ resolveScheduledPostActor: mockActor }));
vi.mock("@/lib/storage/media", () => ({
  mediaFileExists: vi.fn(async () => true),
  hashMediaFile: vi.fn(async (filename: string) => `hash-of-${filename}`),
  getMediaPublicUrl: vi.fn((filename: string) => `http://test.local/media/${filename}`),
}));
// Fase 4: the Zernio account is resolved server-side from env — fixed here
// so TIKTOK/YOUTUBE posts in the dedup-scoping test below can be created.
vi.mock("@/lib/env", () => ({
  getZernioAccountIdForPlatform: vi.fn((platform: "TIKTOK" | "YOUTUBE") =>
    platform === "TIKTOK" ? "zernio_tiktok_1" : "zernio_youtube_1"
  ),
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
  lockChains.clear();
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

  it("Fase 4: does not treat a TikTok post as a duplicate of an Instagram post with the same content (dedup scoped per platform+account)", async () => {
    // The existing candidate is an INSTAGRAM row for the exact same file —
    // the route's own `where` filters candidates by `platform`, so this
    // mock only returns it when queried as INSTAGRAM, proving the TIKTOK
    // create never even sees it as a candidate.
    mockPrisma.scheduledPost.findMany.mockImplementation(
      async ({ where }: { where: { platform?: string } }) =>
        where.platform === "INSTAGRAM"
          ? [{ id: "post_existing_ig", contentHash: [`hash-of-${mp4(1)}`] }]
          : []
    );

    const res = await POST(
      postRequest({
        mediaType: "REELS",
        storagePaths: [mp4(1)],
        caption: "Legenda",
        scheduledFor: FUTURE,
        username: "conta",
        platform: "TIKTOK",
        tiktokSettings: { privacyLevel: "PUBLIC_TO_EVERYONE", consentGiven: true },
      })
    );

    expect(res.status).toBe(201);
    expect(mockPrisma.scheduledPost.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.scheduledPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          platform: "TIKTOK",
          instagramAccountId: null,
          zernioAccountId: "zernio_tiktok_1",
        }),
      })
    );
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

  it("Rodada 3, achado 3: serializes two concurrent creates for the same content — only one wins", async () => {
    // A stateful fake table, so the second call's dedup check actually sees
    // what the first call created — this is what an in-memory single-return
    // mock (used by the other tests above) cannot exercise.
    const created: Array<{ id: string; contentHash: string[] }> = [];
    let nextId = 1;
    mockPrisma.scheduledPost.findMany.mockImplementation(async () =>
      created.map((c) => ({ ...c }))
    );
    mockPrisma.scheduledPost.create.mockImplementation(
      async ({ data }: { data: { contentHash: string[] } }) => {
        const row = { id: `post_${nextId++}`, ...data };
        created.push({ id: row.id, contentHash: row.contentHash });
        return row;
      }
    );

    const body = () =>
      postRequest({
        mediaType: "REELS",
        storagePaths: [mp4(1)],
        caption: "Legenda",
        scheduledFor: FUTURE,
        username: "conta",
      });

    // Without the pg_advisory_xact_lock fix, both requests would run their
    // findMany-then-create as two independent statements, both see
    // created=[] and both succeed — two rows for the exact same content.
    const [resA, resB] = await Promise.all([POST(body()), POST(body())]);
    const statuses = [resA.status, resB.status].sort();

    expect(created).toHaveLength(1);
    expect(statuses).toEqual([201, 409]);
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
