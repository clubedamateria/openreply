import { describe, expect, it } from "vitest";
import { buildScheduleGrid } from "../lib/scheduled-posts/schedule-grid";

describe("buildScheduleGrid", () => {
  it("assigns one item per horário, one day at a time, when porDia is omitted", () => {
    const slots = buildScheduleGrid({
      itemCount: 4,
      startDate: "2026-10-01",
      horarios: ["12:00", "19:00"],
    });

    expect(slots).toHaveLength(4);
    // 2026-10-01T12:00 in America/Sao_Paulo (UTC-3) is 15:00 UTC.
    expect(slots[0].scheduledForUtcIso).toBe("2026-10-01T15:00:00.000Z");
    expect(slots[1].scheduledForUtcIso).toBe("2026-10-01T22:00:00.000Z");
    // Day 2 repeats the same two horários.
    expect(slots[2].scheduledForUtcIso).toBe("2026-10-02T15:00:00.000Z");
    expect(slots[3].scheduledForUtcIso).toBe("2026-10-02T22:00:00.000Z");
  });

  it("uses only the first porDia horários of each day when porDia is smaller", () => {
    const slots = buildScheduleGrid({
      itemCount: 3,
      startDate: "2026-10-01",
      horarios: ["09:00", "12:00", "19:00"],
      porDia: 1,
    });

    // One post a day, always at the first horário — three different days.
    expect(slots.map((s) => s.scheduledForUtcIso)).toEqual([
      "2026-10-01T12:00:00.000Z",
      "2026-10-02T12:00:00.000Z",
      "2026-10-03T12:00:00.000Z",
    ]);
  });

  it("preserves input order via index, independent of scheduling order", () => {
    const slots = buildScheduleGrid({
      itemCount: 3,
      startDate: "2026-10-01",
      horarios: ["12:00"],
    });
    expect(slots.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it("rejects porDia greater than the number of horários", () => {
    expect(() =>
      buildScheduleGrid({
        itemCount: 5,
        startDate: "2026-10-01",
        horarios: ["12:00"],
        porDia: 2,
      })
    ).toThrow(/por-dia/);
  });

  it("rejects an empty horários list", () => {
    expect(() =>
      buildScheduleGrid({ itemCount: 1, startDate: "2026-10-01", horarios: [] })
    ).toThrow(/horário/);
  });

  it("returns an empty grid for zero items without needing valid dates", () => {
    expect(
      buildScheduleGrid({ itemCount: 0, startDate: "2026-10-01", horarios: ["12:00"] })
    ).toEqual([]);
  });
});
