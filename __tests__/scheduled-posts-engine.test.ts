import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFakeScheduledPostDb, type Row } from "./helpers/fake-scheduled-post-db";

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

const NOW = new Date("2026-10-01T15:00:00.000Z");
/** Runs a tick, keeping the fake DB's updatedAt bookkeeping in sync with the
 * tick's own logical clock (what Postgres' real @updatedAt would reflect). */
async function tick(now: Date) {
  h.setNow(now);
  return runPublishScheduledCron(now);
}

function metaAccount(overrides: Partial<{ provider: string; username: string }> = {}) {
  return {
    provider: "META",
    accessToken: "enc-token",
    instagramId: "ig-123",
    username: "minha_conta",
    ...overrides,
  };
}

function scheduledPost(overrides: Row = {}): Row {
  return {
    id: "post_1",
    workspaceId: "ws_1",
    mediaType: "REELS",
    mediaUrls: ["https://media.local/video.mp4"],
    storagePaths: ["abc0123456789def-xxxxxx.mp4"],
    coverPath: null,
    caption: "Legenda",
    shareToFeed: true,
    coverUrl: null,
    attempts: 0,
    containerId: null,
    childContainerIds: [],
    mediaId: null,
    permalink: null,
    scheduledFor: NOW,
    status: "SCHEDULED",
    publishedAt: null,
    updatedAt: NOW,
    instagramAccount: metaAccount(),
    ...overrides,
  };
}

function seed(...posts: Row[]) {
  h.rows.clear();
  for (const p of posts) h.rows.set(p.id as string, p);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.clear();
  h.meta.getContentPublishingLimit.mockResolvedValue({
    quota_usage: 0,
    config: { quota_total: 100, quota_duration: 86400 },
  });
  h.meta.getMediaPermalink.mockResolvedValue({ permalink: undefined });
  h.meta.listRecentMedia.mockResolvedValue([]);
});

describe("runPublishScheduledCron — prepare phase", () => {
  it("claims a due SCHEDULED post and creates a REELS container", async () => {
    seed(scheduledPost());
    h.meta.createReelsContainer.mockResolvedValue({ id: "container_1" });

    const result = await tick(NOW);

    expect(h.meta.createReelsContainer).toHaveBeenCalledWith("enc-token", "ig-123", {
      videoUrl: "https://media.local/video.mp4",
      caption: "Legenda",
      shareToFeed: true,
      coverUrl: undefined,
    });
    expect(h.rows.get("post_1")?.containerId).toBe("container_1");
    expect(h.rows.get("post_1")?.status).toBe("PREPARING");
    expect((result as { prepared: number }).prepared).toBe(1);
  });

  it("fails a ZERNIO-connected account immediately with a clear message, and alerts", async () => {
    seed(scheduledPost({ instagramAccount: metaAccount({ provider: "ZERNIO" }) }));

    const result = await tick(NOW);

    expect(h.meta.createReelsContainer).not.toHaveBeenCalled();
    expect(h.rows.get("post_1")?.status).toBe("FAILED");
    expect((result as { failed: number }).failed).toBe(1);
    expect(h.sendPublishFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledPostId: "post_1" })
    );
  });

  it("fails only that post when its token can't be decrypted, without aborting the tick", async () => {
    seed(
      scheduledPost({ id: "post_bad_token" }),
      scheduledPost({ id: "post_ok", storagePaths: ["deadbeef01234567-yyyyyy.mp4"] })
    );
    h.decryptToken.mockImplementationOnce(() => {
      throw new Error("bad ciphertext");
    });
    h.meta.createReelsContainer.mockResolvedValue({ id: "container_ok" });

    const result = await tick(NOW);

    expect(h.rows.get("post_bad_token")?.status).toBe("FAILED");
    expect(h.rows.get("post_ok")?.status).toBe("PREPARING");
    expect(h.rows.get("post_ok")?.containerId).toBe("container_ok");
    expect((result as { failed: number; prepared: number }).failed).toBe(1);
    expect((result as { failed: number; prepared: number }).prepared).toBe(1);
  });

  it("builds a CAROUSEL by creating every child before the parent, with an explicit media_type on video slides", async () => {
    seed(
      scheduledPost({
        mediaType: "CAROUSEL",
        mediaUrls: ["https://media.local/1.jpg", "https://media.local/2.mp4"],
      })
    );
    h.meta.createCarouselChildContainer
      .mockResolvedValueOnce({ id: "child_1" })
      .mockResolvedValueOnce({ id: "child_2" });
    h.meta.createCarouselContainer.mockResolvedValue({ id: "parent_1" });

    await tick(NOW);

    expect(h.meta.createCarouselChildContainer).toHaveBeenNthCalledWith(1, "enc-token", "ig-123", {
      mediaUrl: "https://media.local/1.jpg",
      isVideo: false,
    });
    expect(h.meta.createCarouselChildContainer).toHaveBeenNthCalledWith(2, "enc-token", "ig-123", {
      mediaUrl: "https://media.local/2.mp4",
      isVideo: true,
    });
    expect(h.rows.get("post_1")?.containerId).toBe("parent_1");
    expect(h.rows.get("post_1")?.childContainerIds).toEqual(["child_1", "child_2"]);
  });

  it("caps preparation at 10 posts per tick", async () => {
    const posts = Array.from({ length: 12 }, (_, i) =>
      scheduledPost({ id: `post_${i}`, scheduledFor: new Date(NOW.getTime() + i * 1000) })
    );
    seed(...posts);
    h.meta.createReelsContainer.mockResolvedValue({ id: "container_x" });

    const result = await tick(NOW);

    expect((result as { prepared: number }).prepared).toBe(10);
  });
});

describe("runPublishScheduledCron — publish phase", () => {
  it("publishes a PREPARING post once its container is FINISHED, writing mediaId before the permalink", async () => {
    seed(scheduledPost({ status: "PREPARING", containerId: "container_1" }));
    h.meta.getContainerStatus.mockResolvedValue({ status_code: "FINISHED" });
    h.meta.publishMediaContainer.mockResolvedValue({ id: "media_1" });
    h.meta.getMediaPermalink.mockResolvedValue({ permalink: "https://instagram.com/p/abc" });

    const result = await tick(NOW);

    expect(h.meta.publishMediaContainer).toHaveBeenCalledWith("enc-token", "ig-123", "container_1");
    const row = h.rows.get("post_1")!;
    expect(row.status).toBe("PUBLISHED");
    expect(row.mediaId).toBe("media_1");
    expect(row.permalink).toBe("https://instagram.com/p/abc");
    expect((result as { published: number }).published).toBe(1);
  });

  it("waits for a container still IN_PROGRESS instead of publishing or failing", async () => {
    seed(scheduledPost({ status: "PREPARING", containerId: "container_1" }));
    h.meta.getContainerStatus.mockResolvedValue({ status_code: "IN_PROGRESS" });

    const result = await tick(NOW);

    expect(h.meta.publishMediaContainer).not.toHaveBeenCalled();
    expect((result as { published: number; failed: number }).published).toBe(0);
    expect((result as { published: number; failed: number }).failed).toBe(0);
    expect(h.rows.get("post_1")?.status).toBe("PREPARING");
  });

  it("defers when the account's publishing quota is exhausted, without claiming the row", async () => {
    seed(scheduledPost({ status: "PREPARING", containerId: "container_1" }));
    h.meta.getContainerStatus.mockResolvedValue({ status_code: "FINISHED" });
    h.meta.getContentPublishingLimit.mockResolvedValue({
      quota_usage: 100,
      config: { quota_total: 100, quota_duration: 86400 },
    });

    const result = await tick(NOW);

    expect(h.meta.publishMediaContainer).not.toHaveBeenCalled();
    expect(h.rows.get("post_1")?.status).toBe("PREPARING");
    expect((result as { deferredQuota: number }).deferredQuota).toBe(1);
  });

  it("recreates the container on an explicit ERROR status and keeps attempts under the cap", async () => {
    seed(scheduledPost({ status: "PREPARING", containerId: "container_1", attempts: 0 }));
    h.meta.getContainerStatus.mockResolvedValue({ status_code: "ERROR" });
    h.meta.createReelsContainer.mockResolvedValue({ id: "container_2" });

    const result = await tick(NOW);

    expect(h.meta.createReelsContainer).toHaveBeenCalledTimes(1);
    const row = h.rows.get("post_1")!;
    expect(row.status).toBe("PREPARING");
    expect(row.containerId).toBe("container_2");
    expect(row.attempts).toBe(1);
    expect((result as { failed: number }).failed).toBe(0);
    expect(h.sendPublishFailureAlert).not.toHaveBeenCalled();
  });

  it("gives up and marks FAILED once the 3rd attempt also errors", async () => {
    seed(scheduledPost({ status: "PREPARING", containerId: "container_1", attempts: 2 }));
    h.meta.getContainerStatus.mockResolvedValue({ status_code: "EXPIRED" });

    const result = await tick(NOW);

    expect(h.meta.createReelsContainer).not.toHaveBeenCalled();
    const row = h.rows.get("post_1")!;
    expect(row.status).toBe("FAILED");
    expect(row.attempts).toBe(3);
    expect((result as { failed: number }).failed).toBe(1);
    expect(h.sendPublishFailureAlert).toHaveBeenCalledTimes(1);
  });

  it("does NOT recreate the container when the status poll merely throws (network/Meta hiccup)", async () => {
    seed(scheduledPost({ status: "PREPARING", containerId: "container_1", updatedAt: NOW }));
    h.meta.getContainerStatus.mockRejectedValue(new Error("socket hang up"));

    await tick(NOW);

    expect(h.meta.createReelsContainer).not.toHaveBeenCalled();
    const row = h.rows.get("post_1")!;
    expect(row.status).toBe("PREPARING");
    expect(row.containerId).toBe("container_1");
  });

  it("fails a post stuck 30+ minutes on repeated status-poll errors", async () => {
    seed(scheduledPost({ status: "PREPARING", containerId: "container_1", updatedAt: NOW }));
    h.meta.getContainerStatus.mockRejectedValue(new Error("socket hang up"));

    const result = await tick(new Date(NOW.getTime() + 31 * 60_000));

    expect(h.rows.get("post_1")?.status).toBe("FAILED");
    expect((result as { failed: number }).failed).toBe(1);
  });

  it("marks PUBLISHED via reconciliation when the container already shows PUBLISHED (lost media_publish response)", async () => {
    seed(scheduledPost({ status: "PREPARING", containerId: "container_1" }));
    h.meta.getContainerStatus.mockResolvedValue({ status_code: "PUBLISHED" });
    h.meta.listRecentMedia.mockResolvedValue([
      { id: "media_9", caption: "Legenda", timestamp: NOW.toISOString(), permalink: "https://instagram.com/p/z" },
    ]);

    const result = await tick(NOW);

    expect(h.meta.publishMediaContainer).not.toHaveBeenCalled();
    const row = h.rows.get("post_1")!;
    expect(row.status).toBe("PUBLISHED");
    expect(row.mediaId).toBe("media_9");
    expect((result as { published: number }).published).toBe(1);
  });

  it("marks PUBLISHED without mediaId and sends a warning alert when no unambiguous match exists", async () => {
    seed(scheduledPost({ status: "PREPARING", containerId: "container_1" }));
    h.meta.getContainerStatus.mockResolvedValue({ status_code: "PUBLISHED" });
    h.meta.listRecentMedia.mockResolvedValue([]);

    await tick(NOW);

    const row = h.rows.get("post_1")!;
    expect(row.status).toBe("PUBLISHED");
    expect(row.mediaId).toBeNull();
    expect(h.sendPublishWarningAlert).toHaveBeenCalledTimes(1);
  });
});

describe("runPublishScheduledCron — reconciliation of stuck PUBLISHING rows", () => {
  it("reverts a stale PUBLISHING row back to PREPARING when the container is still FINISHED", async () => {
    seed(
      scheduledPost({
        status: "PUBLISHING",
        containerId: "container_1",
        updatedAt: new Date(NOW.getTime() - 4 * 60_000),
      })
    );
    h.meta.getContainerStatus.mockResolvedValue({ status_code: "FINISHED" });

    await tick(NOW);

    const row = h.rows.get("post_1")!;
    expect(row.status).toBe("PREPARING");
    expect(row.mediaId).toBeNull();
  });

  it("marks FAILED when a stale PUBLISHING row's container comes back ERROR", async () => {
    seed(
      scheduledPost({
        status: "PUBLISHING",
        containerId: "container_1",
        updatedAt: new Date(NOW.getTime() - 4 * 60_000),
      })
    );
    h.meta.getContainerStatus.mockResolvedValue({ status_code: "ERROR" });

    await tick(NOW);

    expect(h.rows.get("post_1")?.status).toBe("FAILED");
    expect(h.sendPublishFailureAlert).toHaveBeenCalledTimes(1);
  });

  it("never calls media_publish again while reconciling a stale PUBLISHING row", async () => {
    seed(
      scheduledPost({
        status: "PUBLISHING",
        containerId: "container_1",
        updatedAt: new Date(NOW.getTime() - 4 * 60_000),
      })
    );
    h.meta.getContainerStatus.mockResolvedValue({ status_code: "PUBLISHED" });
    h.meta.listRecentMedia.mockResolvedValue([
      { id: "media_9", caption: "Legenda", timestamp: NOW.toISOString() },
    ]);

    await tick(NOW);

    expect(h.meta.publishMediaContainer).not.toHaveBeenCalled();
    expect(h.rows.get("post_1")?.status).toBe("PUBLISHED");
  });

  it("leaves a PUBLISHING row untouched before the 3-minute staleness window", async () => {
    seed(
      scheduledPost({
        status: "PUBLISHING",
        containerId: "container_1",
        updatedAt: new Date(NOW.getTime() - 60_000),
      })
    );

    await tick(NOW);

    expect(h.meta.getContainerStatus).not.toHaveBeenCalled();
    expect(h.rows.get("post_1")?.status).toBe("PUBLISHING");
  });
});

describe("runPublishScheduledCron — global advisory lock", () => {
  it("skips the whole tick when the advisory lock is already held", async () => {
    seed(scheduledPost());
    h.meta.createReelsContainer.mockResolvedValue({ id: "container_1" });

    // Simulate an overlapping tick already holding the lock.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holding = h.withAdvisoryLock(async () => {
      await gate;
      return "held";
    });

    const result = await tick(NOW);
    expect(result).toEqual({ skipped: "locked" });
    expect(h.meta.createReelsContainer).not.toHaveBeenCalled();

    release();
    await holding;
  });
});

describe("runPublishScheduledCron — disk cleanup", () => {
  it("deletes media files for posts published more than 24h ago, keeping contentHash", async () => {
    seed(
      scheduledPost({
        status: "PUBLISHED",
        publishedAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
        storagePaths: ["abc0123456789def-xxxxxx.mp4"],
        contentHash: ["abc0123456789defabc0123456789defabc0123456789defabc0123456789de"],
      })
    );

    const result = await tick(NOW);

    expect(h.deleteMediaFiles).toHaveBeenCalledWith(["abc0123456789def-xxxxxx.mp4"]);
    const row = h.rows.get("post_1")!;
    expect(row.storagePaths).toEqual([]);
    expect(row.contentHash).toEqual([
      "abc0123456789defabc0123456789defabc0123456789defabc0123456789de",
    ]);
    expect((result as { cleaned: number }).cleaned).toBe(1);
  });

  it("does not touch a PUBLISHED post's files before the 24h mark", async () => {
    seed(
      scheduledPost({
        status: "PUBLISHED",
        publishedAt: new Date(NOW.getTime() - 1 * 60 * 60 * 1000),
        storagePaths: ["abc0123456789def-xxxxxx.mp4"],
      })
    );

    await tick(NOW);

    expect(h.deleteMediaFiles).not.toHaveBeenCalled();
  });

  it("deletes orphan files older than 48h that no active post references", async () => {
    seed();
    h.listMediaFiles.mockResolvedValue([
      { filename: "orphan-old.mp4", mtimeMs: NOW.getTime() - 49 * 60 * 60 * 1000 },
      { filename: "orphan-new.mp4", mtimeMs: NOW.getTime() - 1 * 60 * 60 * 1000 },
    ]);

    const result = await tick(NOW);

    expect(h.deleteMediaFiles).toHaveBeenCalledWith(["orphan-old.mp4"]);
    expect((result as { orphansDeleted: number }).orphansDeleted).toBe(1);
  });
});
