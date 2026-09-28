import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Rodada 5, achado 9: `GET /api/scheduled-posts?platform=` used to cast the
 * raw query string straight into a Prisma filter (`as
 * Prisma.EnumScheduledPostPlatformFilter["equals"]`) — an invalid value
 * crashed the query with an opaque 500 instead of a clear 400.
 */

const { mockPrisma, mockActor } = vi.hoisted(() => ({
  mockPrisma: {
    scheduledPost: { findMany: vi.fn(async () => []) },
    instagramAccount: { findFirst: vi.fn() },
  },
  mockActor: vi.fn(async () => ({ source: "PAINEL" as const, workspaceId: "ws_1" })),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/scheduled-posts/auth", () => ({ resolveScheduledPostActor: mockActor }));

const { GET } = await import("../app/api/scheduled-posts/route");

function getRequest(query: string) {
  return new NextRequest(`http://localhost/api/scheduled-posts${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockActor.mockResolvedValue({ source: "PAINEL", workspaceId: "ws_1" });
  mockPrisma.scheduledPost.findMany.mockResolvedValue([]);
});

describe("GET /api/scheduled-posts — ?platform= validation (achado 9)", () => {
  it("responds 400 on an invalid platform value, without ever querying the database", async () => {
    const res = await GET(getRequest("?platform=facebook"));

    expect(res.status).toBe(400);
    expect(mockPrisma.scheduledPost.findMany).not.toHaveBeenCalled();
  });

  it("accepts a valid platform value and filters by it", async () => {
    const res = await GET(getRequest("?platform=TIKTOK"));

    expect(res.status).toBe(200);
    expect(mockPrisma.scheduledPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ platform: "TIKTOK" }) })
    );
  });

  it('treats "all" as no filter (unchanged behavior)', async () => {
    const res = await GET(getRequest("?platform=all"));

    expect(res.status).toBe(200);
    expect(mockPrisma.scheduledPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws_1" } })
    );
  });

  it("omitting ?platform= entirely still works (unchanged behavior)", async () => {
    const res = await GET(getRequest(""));

    expect(res.status).toBe(200);
    expect(mockPrisma.scheduledPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws_1" } })
    );
  });
});
