import { it, expect, beforeEach, vi } from "vitest";
import { createFakeScheduledPostDb, type Row } from "./helpers/fake-scheduled-post-db";

/**
 * The 4 double-publication scenarios from the adversarial review, replayed
 * against the real `runPublishScheduledCron` to prove each is now
 * impossible. Originally reproduced (as failing tests, against the
 * pre-review engine) in
 * scratchpad/ares/dup.test.ts — see
 * docs/2026-09-27-agendados-comentarios.md, "Mudanças pós-revisão", for the
 * bloqueador each one maps to.
 */

const h = createFakeScheduledPostDb();

vi.mock("@/lib/db/client", () => ({ prisma: h.prisma }));
vi.mock("@/lib/scheduled-posts/advisory-lock", () => ({ withAdvisoryLock: h.withAdvisoryLock }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: h.decryptToken }));
vi.mock("@/lib/meta/client", () => h.meta);
vi.mock("@/lib/storage/media", () => ({
  deleteMediaFiles: h.deleteMediaFiles,
  listMediaFiles: h.listMediaFiles,
}));
vi.mock("@/lib/email/alert", () => ({
  sendPublishFailureAlert: h.sendPublishFailureAlert,
  sendPublishWarningAlert: h.sendPublishWarningAlert,
}));

const { runPublishScheduledCron } = await import("../lib/scheduled-posts/engine");

const account = { provider: "META", accessToken: "t", instagramId: "ig", username: "clubedamateria" };
const BASE = Date.parse("2026-10-01T15:00:00Z");
const T = (minutes: number) => new Date(BASE + minutes * 60_000);

async function tick(now: Date) {
  h.setNow(now);
  return runPublishScheduledCron(now);
}

function seed(overrides: Row = {}) {
  h.rows.clear();
  h.rows.set("p1", {
    id: "p1",
    workspaceId: "w",
    mediaType: "REELS",
    mediaUrls: ["https://media.local/v.mp4"],
    storagePaths: ["v.mp4"],
    coverPath: null,
    caption: "c",
    shareToFeed: true,
    coverUrl: null,
    attempts: 0,
    containerId: "C1",
    childContainerIds: [],
    mediaId: null,
    permalink: null,
    scheduledFor: T(0),
    status: "PREPARING",
    publishedAt: null,
    updatedAt: T(0),
    instagramAccount: account,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.clear();
  h.meta.getContentPublishingLimit.mockResolvedValue({
    quota_usage: 0,
    config: { quota_total: 100, quota_duration: 86400 },
  });
  h.meta.getMediaPermalink.mockResolvedValue({ permalink: "https://instagram.com/p/x" });
  h.meta.listRecentMedia.mockResolvedValue([]);
});

it("CENARIO 1: resposta do media_publish perdida — nunca chama media_publish 2x, mesmo após um erro transitório de polling", async () => {
  seed();
  const containerState: Record<string, string> = { C1: "FINISHED" };
  h.meta.getContainerStatus.mockImplementation(async (_t: string, id: string) => ({
    status_code: containerState[id],
  }));
  // Meta publishes, but the HTTP response is lost (socket reset / timeout).
  h.meta.publishMediaContainer.mockImplementationOnce(async (_t: string, _ig: string, id: string) => {
    containerState[id] = "PUBLISHED";
    throw new TypeError("fetch failed");
  });

  await tick(T(0));
  // Ambiguous media_publish failure: stays in PUBLISHING, not reverted.
  expect(h.rows.get("p1")!.status).toBe("PUBLISHING");

  // Ticks 1-2: still inside the 3-minute reconciliation window — no action.
  await tick(T(1));
  await tick(T(2));
  expect(h.rows.get("p1")!.status).toBe("PUBLISHING");

  // A transient Graph error on some other, unrelated poll must not matter —
  // reconciliation only fires once the row is stale.
  h.meta.createReelsContainer.mockImplementation(async () => {
    containerState.C2 = "FINISHED";
    return { id: "C2" };
  });

  // Tick past the 3-minute mark: reconciliation checks the container, finds
  // it PUBLISHED, and resolves the row WITHOUT ever calling media_publish
  // again.
  await tick(T(4));

  const r = h.rows.get("p1")!;
  expect(r.status).toBe("PUBLISHED");
  expect(h.meta.publishMediaContainer).toHaveBeenCalledTimes(1);
  expect(h.meta.createReelsContainer).not.toHaveBeenCalled();
});

it("CENARIO 2: crash logo após o claim de PUBLISHING — a reconciliação assume o post depois de 3 minutos, sem recriar o container", async () => {
  seed({ status: "PUBLISHING" }); // process died after claim (deploy/OOM) before any write
  h.meta.getContainerStatus.mockResolvedValue({ status_code: "FINISHED" });

  await tick(T(1)); // 1 minute stale — still under the reconciliation window
  expect(h.rows.get("p1")!.status).toBe("PUBLISHING");
  expect(h.meta.getContainerStatus).not.toHaveBeenCalled();

  await tick(T(4)); // 4 minutes stale — reconciliation kicks in
  const r = h.rows.get("p1")!;
  // FINISHED (never actually published) reverts to PREPARING so the normal
  // publish phase can try again with the SAME container — never recreated.
  expect(r.status).toBe("PREPARING");
  expect(r.containerId).toBe("C1");
  expect(h.meta.createReelsContainer).not.toHaveBeenCalled();

  h.meta.publishMediaContainer.mockResolvedValue({ id: "M1" });
  await tick(T(5));
  expect(h.meta.publishMediaContainer).toHaveBeenCalledTimes(1);
  expect(h.rows.get("p1")!.status).toBe("PUBLISHED");
});

it("CENARIO 3: escrita do mediaId falha no banco logo após media_publish confirmar — nunca publica de novo, reconciliação resolve depois", async () => {
  seed();
  h.meta.getContainerStatus.mockResolvedValue({ status_code: "FINISHED" });
  h.meta.publishMediaContainer.mockResolvedValue({ id: "M1" });

  // Meta confirms the publish, but the very next statement — the one that
  // would record mediaId — hits a dropped DB connection. Each `updateMany`
  // is its own independent statement (not one giant transaction wrapping
  // the whole tick — see lib/scheduled-posts/advisory-lock.ts for why), so
  // this failure does NOT undo the earlier PREPARING->PUBLISHING claim: the
  // row is left in PUBLISHING with no mediaId, exactly the ambiguous state
  // the reconciler is built to resolve.
  const realUpdateMany = h.prisma.scheduledPost.updateMany.getMockImplementation()!;
  let failNext = true;
  h.prisma.scheduledPost.updateMany.mockImplementation(async (args: unknown) => {
    const a = args as { data?: Record<string, unknown> };
    if (failNext && a.data && "mediaId" in a.data) {
      failNext = false;
      throw new Error("Timed out fetching a new connection from the connection pool");
    }
    return realUpdateMany(args as never);
  });

  await tick(T(0));
  let r = h.rows.get("p1")!;
  expect(r.status).toBe("PUBLISHING");
  expect(r.mediaId).toBeNull();
  expect(h.meta.publishMediaContainer).toHaveBeenCalledTimes(1);

  // Once stale, reconciliation checks the container directly, finds it
  // PUBLISHED, and resolves the row — without ever calling media_publish a
  // second time.
  h.meta.getContainerStatus.mockResolvedValue({ status_code: "PUBLISHED" });
  h.meta.listRecentMedia.mockResolvedValue([
    { id: "M1", caption: "c", timestamp: T(4).toISOString() },
  ]);
  await tick(T(4));

  r = h.rows.get("p1")!;
  expect(r.status).toBe("PUBLISHED");
  expect(r.mediaId).toBe("M1");
  expect(h.meta.publishMediaContainer).toHaveBeenCalledTimes(1);
});

it("CENARIO 4: tick sobreposto nunca roda em paralelo — o lock global impede a troca de container", async () => {
  seed();
  const containerState: Record<string, string> = { C1: "FINISHED" };
  let releasePublish!: () => void;
  const publishGate = new Promise<void>((r) => (releasePublish = r));
  h.meta.getContainerStatus.mockImplementation(async (_t: string, id: string) => ({
    status_code: containerState[id],
  }));
  h.meta.createReelsContainer.mockImplementation(async () => {
    containerState.C2 = "FINISHED";
    return { id: "C2" };
  });
  // Tick A: media_publish is slow and its response is ultimately lost.
  h.meta.publishMediaContainer.mockImplementationOnce(async () => {
    await publishGate;
    containerState.C1 = "PUBLISHED";
    throw new TypeError("fetch failed");
  });

  const tickA = tick(T(0));
  await new Promise((r) => setTimeout(r, 10)); // A is inside media_publish, holding the advisory lock

  // Tick B starts concurrently — it must be refused the lock entirely, never
  // even reading the row.
  const resultB = await tick(T(0));
  expect(resultB).toEqual({ skipped: "locked" });

  releasePublish();
  await tickA;

  expect(h.rows.get("p1")!.status).toBe("PUBLISHING");
  expect(h.meta.createReelsContainer).not.toHaveBeenCalled();

  // Later, once stale, reconciliation resolves it from the container's own
  // state — still without ever creating a second container or calling
  // media_publish again.
  await tick(T(4));
  const r = h.rows.get("p1")!;
  expect(r.status).toBe("PUBLISHED");
  expect(h.meta.publishMediaContainer).toHaveBeenCalledTimes(1);
  expect(h.meta.createReelsContainer).not.toHaveBeenCalled();
});
