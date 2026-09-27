/**
 * America/Sao_Paulo local time <-> UTC, computed with `Intl.DateTimeFormat`
 * instead of a hardcoded "-03:00". Brazil currently has no DST, but it did
 * until 2019 (and could again), so a fixed offset silently mis-schedules any
 * date that falls outside "today's" rule. This is the single place that
 * conversion happens — the form, the reschedule action, the CLI and the
 * schedule grid all import it.
 */

const SAO_PAULO_TIME_ZONE = "America/Sao_Paulo";

/**
 * Offset (in ms) such that `localTime = utcInstant + offset`, for the given
 * timezone at the given instant. Works for any IANA zone, not just Brazil's.
 */
export function getTimeZoneOffsetMs(utcInstant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(utcInstant).map((p) => [p.type, p.value])
  );
  // Reinterpreting the timezone's wall-clock digits as if they were UTC gives
  // an instant offset from the real UTC instant by exactly the zone's offset.
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - utcInstant.getTime();
}

/**
 * Converts a local wall-clock date+time in `timeZone` to the correct UTC
 * instant. One fixed-point iteration is enough in practice: the offset can
 * only change across a DST boundary, and re-deriving it from the corrected
 * guess resolves the (rare) case where the initial guess landed on the wrong
 * side of one.
 */
export function localDateTimeToUtcIso(
  dateStr: string,
  timeStr: string,
  timeZone: string = SAO_PAULO_TIME_ZONE
): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) {
    throw new Error(`Data/hora inválida: ${dateStr} ${timeStr}`);
  }

  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utcMs = naiveUtcMs;
  for (let i = 0; i < 2; i++) {
    const offsetMs = getTimeZoneOffsetMs(new Date(utcMs), timeZone);
    utcMs = naiveUtcMs - offsetMs;
  }
  return new Date(utcMs).toISOString();
}

/** Convenience wrapper fixed to America/Sao_Paulo — the only zone this app uses. */
export function saoPauloToUtcIso(dateStr: string, timeStr: string): string {
  return localDateTimeToUtcIso(dateStr, timeStr, SAO_PAULO_TIME_ZONE);
}
