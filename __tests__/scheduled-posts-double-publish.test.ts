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
    platform: "INSTAGRAM",
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

/**
 * Rodada 3 (segunda revisão adversarial): R1-R4, replayed from
 * scratchpad/ares/r2.test.ts against the fixed engine — each assertion below
 * is the CORRECT behavior after the fix, not the (bugged) one the original
 * reproduction file asserted.
 */

function seedR(id: string, overrides: Row = {}): void {
  h.rows.set(id, {
    id,
    workspaceId: "w",
    platform: "INSTAGRAM",
    mediaType: "REELS",
    mediaUrls: [`https://media.local/${id}.mp4`],
    storagePaths: [`${id}.mp4`],
    coverPath: null,
    caption: "Qual a resposta certa? #ingles",
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
    outcomeUncertain: false,
    ...overrides,
  });
}

it("R1: legenda repetida — reconciliação nunca casa com mídia fora da janela de tempo do claim", async () => {
  // An older, unrelated post happens to share the exact same caption — its
  // timestamp is nowhere near this row's claim-into-PUBLISHING moment.
  seedR("p2", { status: "PUBLISHING", containerId: "C2", updatedAt: T(0) });
  h.meta.getContainerStatus.mockResolvedValue({ status_code: "PUBLISHED" });
  h.meta.listRecentMedia.mockResolvedValue([
    {
      id: "M_ANTIGO",
      caption: "Qual a resposta certa? #ingles",
      timestamp: "2026-09-20T12:00:00+0000",
      permalink: "https://instagram.com/p/ANTIGO",
    },
  ]);

  await tick(T(4));

  const r = h.rows.get("p2")!;
  // Meta really did publish it — the row must not be left unresolved...
  expect(r.status).toBe("PUBLISHED");
  // ...but the out-of-window candidate is correctly rejected: no wrong-post
  // mediaId/permalink, and a human is alerted to fill it in by hand.
  expect(r.mediaId).toBeNull();
  expect(h.sendPublishWarningAlert).toHaveBeenCalledTimes(1);
});

it("R2: varredura de órfãos nunca apaga o arquivo de um post FAILED/PUBLISHED ainda dentro da própria retenção", async () => {
  seedR("p3", { status: "FAILED", containerId: null, updatedAt: T(0), storagePaths: ["p3.mp4"] });
  seedR("p4", {
    status: "PUBLISHED",
    containerId: null,
    mediaId: "M4",
    publishedAt: T(0),
    storagePaths: ["p4.mp4"],
  });
  // Both files' mtime is old (uploaded well before the post's own status
  // changed) — only each post's OWN cleanup (24h for PUBLISHED, 7 days for
  // FAILED/CANCELED) may ever delete them, never the orphan sweep, which now
  // treats every post's current storagePaths as referenced regardless of
  // status or file age.
  h.listMediaFiles.mockResolvedValue([
    { filename: "p3.mp4", mtimeMs: T(-72 * 60).getTime(), isTmp: false },
    { filename: "p4.mp4", mtimeMs: T(-72 * 60).getTime(), isTmp: false },
  ]);

  await tick(T(1));

  expect(h.deleteMediaFiles).not.toHaveBeenCalled();
  expect(h.rows.get("p3")!.storagePaths).toEqual(["p3.mp4"]);
  expect(h.rows.get("p4")!.storagePaths).toEqual(["p4.mp4"]);
});

it("R3: FAILED por timeout prolongado grava outcomeUncertain (retry deixa de recriar o container às cegas)", async () => {
  seedR("p5", { status: "PREPARING", containerId: "C5" });
  h.meta.getContainerStatus.mockResolvedValueOnce({ status_code: "FINISHED" });
  // Meta may well have published — the HTTP response is simply lost.
  h.meta.publishMediaContainer.mockRejectedValueOnce(new Error("fetch failed (timeout)"));
  await tick(T(0));
  expect(h.rows.get("p5")!.status).toBe("PUBLISHING");

  // Meta stays unreachable for the status check for 31 straight minutes.
  h.meta.getContainerStatus.mockRejectedValue(new Error("Meta fora do ar"));
  for (let m = 1; m <= 31; m++) await tick(T(m));

  const r = h.rows.get("p5")!;
  expect(r.status).toBe("FAILED");
  // This is what app/api/scheduled-posts/[id]/route.ts's retry/reschedule
  // guard checks before ever recreating the container for this row.
  expect(r.outcomeUncertain).toBe(true);
});

it("R4: lock perdido não deixa um tick velho marcar FAILED um post que outro tick está publicando", async () => {
  // Bypasses the lock wrapper entirely (as if the connection had silently
  // dropped and a second tick started concurrently) to prove the per-write
  // status+containerId guards are what actually keep this safe, not just the
  // lock.
  h.withAdvisoryLock.mockImplementation(async (fn: (lock: { isHeld(): boolean }) => unknown) =>
    fn({ isHeld: () => true })
  );
  seedR("p6", { status: "PREPARING", containerId: "C6", updatedAt: T(0) });

  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => (releaseA = r));
  let call = 0;
  h.meta.getContainerStatus.mockImplementation(async () => {
    call++;
    if (call === 1) {
      await gateA; // tick A: slow poll, holding a stale snapshot of p6
      throw new Error("timeout");
    }
    return { status_code: "FINISHED" };
  });
  let releasePublish!: (v: { id: string }) => void;
  h.meta.publishMediaContainer.mockImplementation(() => new Promise((r) => (releasePublish = r)));

  const a = tick(T(31)); // A: reads p6 (updatedAt T0), blocks inside the status poll
  await new Promise((r) => setTimeout(r, 5));
  const b = tick(T(31)); // B: reads p6, sees FINISHED, claims PUBLISHING, media_publish in flight
  await new Promise((r) => setTimeout(r, 5));
  expect(h.rows.get("p6")!.status).toBe("PUBLISHING");

  releaseA();
  await a; // A's poll finally fails; its stale markFailed call must no-op
  releasePublish({ id: "M6" });
  await b; // B's publish lands normally

  const r = h.rows.get("p6")!;
  expect(r.status).toBe("PUBLISHED");
  expect(r.mediaId).toBe("M6");
  expect(h.sendPublishFailureAlert).not.toHaveBeenCalled();
});
