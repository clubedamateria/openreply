import { describe, expect, it } from "vitest";
import {
  createScheduledPostSchema,
  isScheduledForTooFarInThePast,
  scheduledPostActionSchema,
} from "../lib/scheduled-posts/schema";

// Valid content-addressed filenames (see lib/scheduled-posts/paths.ts):
// `<16 lowercase hex>-<id, 6+ base64url chars>.(mp4|jpg)`.
const mp4 = (n: number) => `${n.toString(16).padStart(16, "0")}-aaaaaa.mp4`;
const jpg = (n: number) => `${n.toString(16).padStart(16, "0")}-bbbbbb.jpg`;

const NOW = new Date("2026-09-27T12:00:00.000Z");
const FUTURE = "2026-10-01T15:00:00.000Z";

const validBase = {
  mediaType: "REELS" as const,
  storagePaths: [mp4(1)],
  caption: "Legenda #hashtag",
  scheduledFor: FUTURE,
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
      storagePaths: [mp4(1), mp4(2)],
    });
    expect(result.success).toBe(false);
  });

  it("rejects CAROUSEL with a single storage path", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      mediaType: "CAROUSEL",
      storagePaths: [jpg(1)],
    });
    expect(result.success).toBe(false);
  });

  it("accepts CAROUSEL with 2 to 10 storage paths", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      mediaType: "CAROUSEL",
      storagePaths: [jpg(1), jpg(2), jpg(3)],
    });
    expect(result.success).toBe(true);
  });

  it("rejects CAROUSEL with more than 10 storage paths", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      mediaType: "CAROUSEL",
      storagePaths: Array.from({ length: 11 }, (_, i) => jpg(i)),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a storage path that isn't a flat content-addressed filename (path traversal, arbitrary names)", () => {
    for (const bad of ["../../etc/passwd", "instagram/minha_conta/video.mp4", "Quiz 1.mp4", "video.png"]) {
      const result = createScheduledPostSchema.safeParse({ ...validBase, storagePaths: [bad] });
      expect(result.success, `expected "${bad}" to be rejected`).toBe(false);
    }
  });

  it("rejects coverPath on a non-REELS post", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      mediaType: "IMAGE",
      coverPath: jpg(9),
    });
    expect(result.success).toBe(false);
  });

  it("accepts coverPath on a REELS post", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      coverPath: jpg(9),
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

  it("defaults force to false when omitted", () => {
    const result = createScheduledPostSchema.parse(validBase);
    expect(result.force).toBe(false);
  });

  it("rejects scheduledFor more than 5 minutes in the past", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      scheduledFor: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("accepts scheduledFor a couple minutes in the past (clock-skew slack)", () => {
    const result = createScheduledPostSchema.safeParse({
      ...validBase,
      scheduledFor: new Date(Date.now() - 2 * 60_000).toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

describe("isScheduledForTooFarInThePast", () => {
  it("is false for a time in the future", () => {
    expect(isScheduledForTooFarInThePast("2026-09-27T12:10:00.000Z", NOW)).toBe(false);
  });

  it("is false within the 5-minute slack", () => {
    expect(isScheduledForTooFarInThePast("2026-09-27T11:57:00.000Z", NOW)).toBe(false);
  });

  it("is true beyond the 5-minute slack", () => {
    expect(isScheduledForTooFarInThePast("2026-09-27T11:50:00.000Z", NOW)).toBe(true);
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
      scheduledFor: FUTURE,
    });
    expect(result.success).toBe(true);
  });

  it("rejects reschedule more than 5 minutes in the past", () => {
    const result = scheduledPostActionSchema.safeParse({
      action: "reschedule",
      scheduledFor: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown action", () => {
    const result = scheduledPostActionSchema.safeParse({ action: "delete" });
    expect(result.success).toBe(false);
  });
});
