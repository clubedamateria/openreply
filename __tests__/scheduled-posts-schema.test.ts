import { describe, expect, it } from "vitest";
import {
  createScheduledPostSchema,
  scheduledPostActionSchema,
} from "../lib/scheduled-posts/schema";

const validBase = {
  mediaType: "REELS" as const,
  storagePaths: ["instagram/minha_conta/video.mp4"],
  caption: "Legenda #hashtag",
  scheduledFor: "2026-10-01T15:00:00.000Z",
  username: "minha_conta",
};

describe("createScheduledPostSchema", () => {
  it("accepts a valid REELS payload from the lote (username) caller", () => {
    const result = createScheduledPostSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("accepts a valid payload from the painel (instagramAccountId) caller", () => {
    const withoutUsername: Partial<typeof validBase> = { ...validBase };
    delete withoutUsername.username;
    const result = createScheduledPostSchema.safeParse({
      ...withoutUsername,
      instagramAccountId: "acc_123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload with neither instagramAccountId nor username", () => {
    const withoutUsername: Partial<typeof validBase> = { ...validBase };
    delete withoutUsername.username;
    const result = createScheduledPostSchema.safeParse(withoutUsername);
    expect(result.success).toBe(false);
  });

  it("rejects REELS/IMAGE with more than one storage path", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      storagePaths: ["a.mp4", "b.mp4"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects CAROUSEL with a single storage path", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      mediaType: "CAROUSEL",
      storagePaths: ["only-one.jpg"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts CAROUSEL with 2 to 10 storage paths", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      mediaType: "CAROUSEL",
      storagePaths: ["a.jpg", "b.jpg", "c.jpg"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects CAROUSEL with more than 10 storage paths", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      mediaType: "CAROUSEL",
      storagePaths: Array.from({ length: 11 }, (_, i) => `img-${i}.jpg`),
    });
    expect(result.success).toBe(false);
  });

  it("rejects coverPath on a non-REELS post", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      mediaType: "IMAGE",
      coverPath: "cover.jpg",
    });
    expect(result.success).toBe(false);
  });

  it("accepts coverPath on a REELS post", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      coverPath: "cover.jpg",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a caption longer than 2,200 characters", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      caption: "a".repeat(2201),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a caption with more than 30 hashtags", () => {
    const manyHashtags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      caption: manyHashtags,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO scheduledFor", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      scheduledFor: "01/10/2026 12:00",
    });
    expect(result.success).toBe(false);
  });

  it("defaults shareToFeed to true when omitted", () => {
    const result = createScheduledPostSchema.parse(validBase);
    expect(result.shareToFeed).toBe(true);
  });
});

describe("scheduledPostActionSchema", () => {
  it.each(["cancel", "retry", "publish-now"] as const)(
    "accepts the %s action with no extra fields",
    (action) => {
      const result = scheduledPostActionSchema.safeParse({ action });
      expect(result.success).toBe(true);
    }
  );

  it("requires scheduledFor on reschedule", () => {
    const result = scheduledPostActionSchema.safeParse({ action: "reschedule" });
    expect(result.success).toBe(false);
  });

  it("accepts reschedule with a valid scheduledFor", () => {
    const result = scheduledPostActionSchema.safeParse({
      action: "reschedule",
      scheduledFor: "2026-10-02T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown action", () => {
    const result = scheduledPostActionSchema.safeParse({ action: "delete" });
    expect(result.success).toBe(false);
  });
});
