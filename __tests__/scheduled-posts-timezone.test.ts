import { describe, expect, it } from "vitest";
import {
  getTimeZoneOffsetMs,
  localDateTimeToUtcIso,
  saoPauloToUtcIso,
} from "../lib/scheduled-posts/timezone";

describe("saoPauloToUtcIso", () => {
  it("converts a current-day time using today's fixed UTC-3 offset", () => {
    expect(saoPauloToUtcIso("2026-10-01", "12:00")).toBe("2026-10-01T15:00:00.000Z");
  });

  it("proves the offset is computed dynamically, not hardcoded: Brazil had DST (-2h) in January 2018", () => {
    // If this were hardcoded to "-03:00" (as it was before the fix), this
    // would come back as 14:00Z instead of the historically correct 13:00Z
    // for a date that predates Brazil dropping DST in 2019.
    expect(saoPauloToUtcIso("2018-01-15", "11:00")).toBe("2018-01-15T13:00:00.000Z");
  });

  it("accepts a time with no leading zero on the hour", () => {
    expect(saoPauloToUtcIso("2026-10-01", "9:00")).toBe(
      saoPauloToUtcIso("2026-10-01", "09:00")
    );
  });

  it("round-trips midnight correctly across the date boundary", () => {
    expect(saoPauloToUtcIso("2026-10-01", "00:00")).toBe("2026-10-01T03:00:00.000Z");
  });
});

describe("localDateTimeToUtcIso", () => {
  it("works for an arbitrary IANA zone, not just America/Sao_Paulo", () => {
    // Tokyo is UTC+9 with no DST.
    expect(localDateTimeToUtcIso("2026-10-01", "21:00", "Asia/Tokyo")).toBe(
      "2026-10-01T12:00:00.000Z"
    );
  });

  it("throws on an invalid date/time string instead of silently producing Invalid Date", () => {
    expect(() => localDateTimeToUtcIso("not-a-date", "12:00")).toThrow();
  });
});

describe("getTimeZoneOffsetMs", () => {
  it("returns -3h (in ms) for a present-day America/Sao_Paulo instant", () => {
    const offset = getTimeZoneOffsetMs(new Date("2026-10-01T15:00:00.000Z"), "America/Sao_Paulo");
    expect(offset).toBe(-3 * 60 * 60 * 1000);
  });

  it("returns -2h for a January 2018 instant (Brazil's old DST)", () => {
    const offset = getTimeZoneOffsetMs(new Date("2018-01-15T13:00:00.000Z"), "America/Sao_Paulo");
    expect(offset).toBe(-2 * 60 * 60 * 1000);
  });
});
