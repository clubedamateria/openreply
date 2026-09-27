/**
 * Pure slot-assignment for `agendar-lote --inicio --horarios --por-dia`: given
 * N items, spread them across days starting at `startDate`, `porDia` per day,
 * at the given clock times — all in America/Sao_Paulo (fixed UTC-3; Brazil
 * dropped DST in 2019).
 *
 * Kept dependency-free (no fs/network) so the grid math is unit-testable on
 * its own, independent of uploads or the API call.
 */

const SAO_PAULO_UTC_OFFSET = "-03:00";

export interface ScheduleGridInput {
  itemCount: number;
  /** YYYY-MM-DD, the calendar day of the first slot in America/Sao_Paulo. */
  startDate: string;
  /** Clock times for each day, e.g. ["12:00", "19:00"], in order. */
  horarios: string[];
  /** Posts per day. Defaults to `horarios.length` (use every horário every day). */
  porDia?: number;
}

export interface ScheduleGridSlot {
  /** Position in the input order (0-based) — maps back to the caller's file list. */
  index: number;
  scheduledForUtcIso: string;
}

function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function buildScheduleGrid({
  itemCount,
  startDate,
  horarios,
  porDia,
}: ScheduleGridInput): ScheduleGridSlot[] {
  if (horarios.length === 0) {
    throw new Error("Informe pelo menos um horário em --horarios");
  }

  const perDay = porDia ?? horarios.length;
  if (perDay <= 0) {
    throw new Error("--por-dia precisa ser maior que zero");
  }
  if (perDay > horarios.length) {
    throw new Error(
      `--por-dia (${perDay}) não pode ser maior que a quantidade de horários em --horarios (${horarios.length})`
    );
  }

  const slots: ScheduleGridSlot[] = [];
  for (let i = 0; i < itemCount; i++) {
    const dayOffset = Math.floor(i / perDay);
    const slotOfDay = i % perDay;
    const date = addDays(startDate, dayOffset);
    const time = horarios[slotOfDay];
    slots.push({
      index: i,
      scheduledForUtcIso: new Date(
        `${date}T${time}:00${SAO_PAULO_UTC_OFFSET}`
      ).toISOString(),
    });
  }
  return slots;
}
