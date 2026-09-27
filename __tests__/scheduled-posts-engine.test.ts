import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrisma,
  mockDecryptToken,
  mockCreateReelsContainer,
  mockCreateImageContainer,
  mockCreateCarouselChildContainer,
  mockCreateCarouselContainer,
  mockGetContainerStatus,
  mockGetContentPublishingLimit,
  mockPublishMediaContainer,
  mockGetMediaPermalink,
  mockDeleteStorageObjects,
  mockSendPublishFailureAlert,
} = vi.hoisted(() => ({
  mockPrisma: {
    scheduledPost: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  },
  mockDecryptToken: vi.fn((token: string) => token),
  mockCreateReelsContainer: vi.fn(),
  mockCreateImageContainer: vi.fn(),
  mockCreateCarouselChildContainer: vi.fn(),
  mockCreateCarouselContainer: vi.fn(),
  mockGetContainerStatus: vi.fn(),
  mockGetContentPublishingLimit: vi.fn(),
  mockPublishMediaContainer: vi.fn(),
  mockGetMediaPermalink: vi.fn(),
  mockDeleteStorageObjects: vi.fn(),
  mockSendPublishFailureAlert: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));
vi.mock("@/lib/meta/client", () => ({
  createReelsContainer: mockCreateReelsContainer,
  createImageContainer: mockCreateImageContainer,
  createCarouselChildContainer: mockCreateCarouselChildContainer,
  createCarouselContainer: mockCreateCarouselContainer,
  getContainerStatus: mockGetContainerStatus,
  getContentPublishingLimit: mockGetContentPublishingLimit,
  publishMediaContainer: mockPublishMediaContainer,
  getMediaPermalink: mockGetMediaPermalink,
}));
vi.mock("@/lib/storage/supabase", () => ({
  deleteStorageObjects: mockDeleteStorageObjects,
}));
vi.mock("@/lib/email/alert", () => ({
  sendPublishFailureAlert: mockSendPublishFailureAlert,
}));

const { runPublishScheduledCron } = await import("../lib/scheduled-posts/engine");

const NOW = new Date("2026-10-01T15:00:00.000Z");

function metaAccount(overrides: Partial<{ provider: string; username: string }> = {}) {
  return {
    provider: "META",
    accessToken: "enc-token",
    instagramId: "ig-123",
    username: "minha_conta",
    ...overrides,
  };
}

function scheduledPost(overrides: Record<string, unknown> = {}) {
  return {
    id: "post_1",
    workspaceId: "ws_1",
    mediaType: "REELS",
    mediaUrls: ["https://bucket/video.mp4"],
    caption: "Legenda",
    shareToFeed: true,
    coverUrl: null,
    attempts: 0,
    containerId: null,
    scheduledFor: NOW,
    status: "SCHEDULED",
    instagramAccount: metaAccount(),
    ...overrides,
  };
}

/** findMany dispatches on `where.status` so each phase gets only its own rows. */
function mockFindManyByStatus(byStatus: Record<string, unknown[]>) {
  mockPrisma.scheduledPost.findMany.mockImplementation(
    async ({ where }: { where: { status?: string | { in?: string[] } } }) => {
      const status = where.status;
      if (typeof status === "string") return byStatus[status] ?? [];
      return byStatus["PUBLISHED"] ?? [];
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.scheduledPost.update.mockResolvedValue({});
  mockGetContentPublishingLimit.mockResolvedValue({
    quota_usage: 0,
    config: { quota_total: 100, quota_duration: 86400 },
  });
});

describe("runPublishScheduledCron — prepare phase", () => {
  it("claims a due SCHEDULED post and creates a REELS container", async () => {
    mockFindManyByStatus({ SCHEDULED: [scheduledPost()], PREPARING: [], PUBLISHED: [] });
    mockCreateReelsContainer.mockResolvedValue({ id: "container_1" });

    const result = await runPublishScheduledCron(NOW);

    expect(mockPrisma.scheduledPost.updateMany).toHaveBeenCalledWith({
      where: { id: "post_1", status: "SCHEDULED" },
      data: { status: "PREPARING" },
    });
    expect(mockCreateReelsContainer).toHaveBeenCalledWith("enc-token", "ig-123", {
      videoUrl: "https://bucket/video.mp4",
      caption: "Legenda",
      shareToFeed: true,
      coverUrl: undefined,
    });
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith({
      where: { id: "post_1" },
      data: { containerId: "container_1", childContainerIds: [] },
    });
    expect(result.prepared).toBe(1);
  });

  it("does not touch a post another overlapping tick already claimed", async () => {
    mockFindManyByStatus({ SCHEDULED: [scheduledPost()], PREPARING: [], PUBLISHED: [] });
    mockPrisma.scheduledPost.updateMany.mockResolvedValueOnce({ count: 0 });

    await runPublishScheduledCron(NOW);

    expect(mockCreateReelsContainer).not.toHaveBeenCalled();
  });

  it("fails a ZERNIO-connected account immediately with a clear message, and alerts", async () => {
    mockFindManyByStatus({
      SCHEDULED: [scheduledPost({ instagramAccount: metaAccount({ provider: "ZERNIO" }) })],
      PREPARING: [],
      PUBLISHED: [],
    });

    const result = await runPublishScheduledCron(NOW);

    expect(mockCreateReelsContainer).not.toHaveBeenCalled();
    expect(mockPrisma.scheduledPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) })
    );
    expect(result.failed).toBe(1);
    expect(mockSendPublishFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledPostId: "post_1" })
    );
  });

  it("builds a CAROUSEL by creating every child before the parent, in order", async () => {
    mockFindManyByStatus({
      SCHEDULED: [
        scheduledPost({
          mediaType: "CAROUSEL",
          mediaUrls: ["https://bucket/1.jpg", "https://bucket/2.mp4"],
        }),
      ],
      PREPARING: [],
      PUBLISHED: [],
    });
    mockCreateCarouselChildContainer
      .mockResolvedValueOnce({ id: "child_1" })
      .mockResolvedValueOnce({ id: "child_2" });
    mockCreateCarouselContainer.mockResolvedValue({ id: "parent_1" });

    await runPublishScheduledCron(NOW);

    expect(mockCreateCarouselChildContainer).toHaveBeenNthCalledWith(1, "enc-token", "ig-123", {
      mediaUrl: "https://bucket/1.jpg",
      isVideo: false,
    });
    expect(mockCreateCarouselChildContainer).toHaveBeenNthCalledWith(2, "enc-token", "ig-123", {
      mediaUrl: "https://bucket/2.mp4",
      isVideo: true,
    });
    expect(mockCreateCarouselContainer).toHaveBeenCalledWith("enc-token", "ig-123", {
      childContainerIds: ["child_1", "child_2"],
      caption: "Legenda",
    });
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith({
      where: { id: "post_1" },
      data: { containerId: "parent_1", childContainerIds: ["child_1", "child_2"] },
    });
  });
});

describe("runPublishScheduledCron — publish phase", () => {
  it("publishes a PREPARING post once its container is FINISHED", async () => {
    mockFindManyByStatus({
      SCHEDULED: [],
      PREPARING: [scheduledPost({ status: "PREPARING", containerId: "container_1" })],
      PUBLISHED: [],
    });
    mockGetContainerStatus.mockResolvedValue({ status_code: "FINISHED" });
    mockPublishMediaContainer.mockResolvedValue({ id: "media_1" });
    mockGetMediaPermalink.mockResolvedValue({ permalink: "https://instagram.com/p/abc" });

    const result = await runPublishScheduledCron(NOW);

    expect(mockPrisma.scheduledPost.updateMany).toHaveBeenCalledWith({
      where: { id: "post_1", status: "PREPARING", mediaId: null },
      data: { status: "PUBLISHING" },
    });
    expect(mockPublishMediaContainer).toHaveBeenCalledWith("enc-token", "ig-123", "container_1");
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith({
      where: { id: "post_1" },
      data: {
        status: "PUBLISHED",
        mediaId: "media_1",
        permalink: "https://instagram.com/p/abc",
        publishedAt: expect.any(Date),
        errorMessage: null,
      },
    });
    expect(result.published).toBe(1);
  });

  it("waits for a container still IN_PROGRESS instead of publishing or failing", async () => {
    mockFindManyByStatus({
      SCHEDULED: [],
      PREPARING: [scheduledPost({ status: "PREPARING", containerId: "container_1" })],
      PUBLISHED: [],
    });
    mockGetContainerStatus.mockResolvedValue({ status_code: "IN_PROGRESS" });

    const result = await runPublishScheduledCron(NOW);

    expect(mockPublishMediaContainer).not.toHaveBeenCalled();
    expect(result.published).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("never calls media_publish when the conditional claim loses the race", async () => {
    mockFindManyByStatus({
      SCHEDULED: [],
      PREPARING: [scheduledPost({ status: "PREPARING", containerId: "container_1" })],
      PUBLISHED: [],
    });
    mockGetContainerStatus.mockResolvedValue({ status_code: "FINISHED" });
    // Another overlapping tick already moved this row to PUBLISHING.
    mockPrisma.scheduledPost.updateMany.mockResolvedValueOnce({ count: 0 });

    await runPublishScheduledCron(NOW);

    expect(mockPublishMediaContainer).not.toHaveBeenCalled();
  });

  it("defers when the account's publishing quota is exhausted, without claiming the row", async () => {
    mockFindManyByStatus({
      SCHEDULED: [],
      PREPARING: [scheduledPost({ status: "PREPARING", containerId: "container_1" })],
      PUBLISHED: [],
    });
    mockGetContainerStatus.mockResolvedValue({ status_code: "FINISHED" });
    mockGetContentPublishingLimit.mockResolvedValue({
      quota_usage: 100,
      config: { quota_total: 100, quota_duration: 86400 },
    });

    const result = await runPublishScheduledCron(NOW);

    expect(mockPublishMediaContainer).not.toHaveBeenCalled();
    // The PREPARING->PUBLISHING claim never fires — quota is checked first.
    expect(mockPrisma.scheduledPost.updateMany).not.toHaveBeenCalled();
    expect(result.deferredQuota).toBe(1);
  });

  it("recreates the container on ERROR and keeps attempts under the cap", async () => {
    mockFindManyByStatus({
      SCHEDULED: [],
      PREPARING: [scheduledPost({ status: "PREPARING", containerId: "container_1", attempts: 0 })],
      PUBLISHED: [],
    });
    mockGetContainerStatus.mockResolvedValue({ status_code: "ERROR" });
    mockCreateReelsContainer.mockResolvedValue({ id: "container_2" });

    const result = await runPublishScheduledCron(NOW);

    expect(mockCreateReelsContainer).toHaveBeenCalledTimes(1);
    expect(mockPrisma.scheduledPost.updateMany).toHaveBeenCalledWith({
      where: { id: "post_1", status: { in: ["PREPARING", "PUBLISHING"] } },
      data: {
        status: "PREPARING",
        containerId: "container_2",
        childContainerIds: [],
        attempts: 1,
        errorMessage: expect.stringContaining("ERROR"),
      },
    });
    expect(result.failed).toBe(0);
    expect(mockSendPublishFailureAlert).not.toHaveBeenCalled();
  });

  it("gives up and marks FAILED once the 3rd attempt also errors", async () => {
    mockFindManyByStatus({
      SCHEDULED: [],
      PREPARING: [scheduledPost({ status: "PREPARING", containerId: "container_1", attempts: 2 })],
      PUBLISHED: [],
    });
    mockGetContainerStatus.mockResolvedValue({ status_code: "EXPIRED" });

    const result = await runPublishScheduledCron(NOW);

    expect(mockCreateReelsContainer).not.toHaveBeenCalled();
    expect(mockPrisma.scheduledPost.updateMany).toHaveBeenCalledWith({
      where: { id: "post_1", status: { in: ["PREPARING", "PUBLISHING"] } },
      data: { status: "FAILED", errorMessage: expect.stringContaining("EXPIRED"), attempts: 3 },
    });
    expect(result.failed).toBe(1);
    expect(mockSendPublishFailureAlert).toHaveBeenCalledTimes(1);
  });
});

describe("runPublishScheduledCron — cleanup phase", () => {
  it("deletes bucket objects for posts published more than 24h ago", async () => {
    mockFindManyByStatus({
      SCHEDULED: [],
      PREPARING: [],
      PUBLISHED: [{ id: "post_1", storagePaths: ["instagram/minha_conta/video.mp4"] }],
    });

    const result = await runPublishScheduledCron(NOW);

    expect(mockDeleteStorageObjects).toHaveBeenCalledWith(["instagram/minha_conta/video.mp4"]);
    expect(mockPrisma.scheduledPost.update).toHaveBeenCalledWith({
      where: { id: "post_1" },
      data: { storagePaths: [] },
    });
    expect(result.cleaned).toBe(1);
  });
});
