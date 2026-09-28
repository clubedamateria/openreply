import { vi } from "vitest";

/**
 * Stateful fake of `prisma.scheduledPost` plus a faithful simulation of
 * `withAdvisoryLock` (lib/scheduled-posts/advisory-lock.ts), so tests can
 * replay multi-tick scenarios against the real `runPublishScheduledCron`.
 *
 * Shared between the engine's own unit tests and the double-publish
 * reproduction tests — both need the lock simulated accurately: while one
 * tick's callback is still pending, a second, overlapping tick must see the
 * lock as held and get `{ skipped: "locked" }` without running any phase at
 * all, exactly like `pg_try_advisory_lock` returning false would.
 */
export type Row = Record<string, unknown>;

export function createFakeScheduledPostDb() {
  const rows = new Map<string, Row>();
  let currentNow: Date = new Date();
  let lockHeld = false;

  function fieldMatches(value: unknown, cond: unknown): boolean {
    if (cond === undefined) return true;
    if (cond === null) return value === null;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond === "object") {
      const c = cond as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if ("not" in c) return !fieldMatches(value, c.not);
      if ("lte" in c) return value instanceof Date && value.getTime() <= (c.lte as Date).getTime();
      if ("gte" in c) return value instanceof Date && value.getTime() >= (c.gte as Date).getTime();
      if ("isEmpty" in c) {
        const len = Array.isArray(value) ? value.length : 0;
        return c.isEmpty ? len === 0 : len > 0;
      }
      return true;
    }
    return value === cond;
  }

  function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
    if (!where) return true;
    for (const key of Object.keys(where)) {
      if (key === "OR") continue;
      if (!fieldMatches(row[key], where[key])) return false;
    }
    // `OR` is just one more conjunct alongside the other top-level keys
    // (Prisma ANDs everything at the same level) — it does not replace them.
    if (where.OR) {
      return (where.OR as Record<string, unknown>[]).some((sub) => matches(row, sub));
    }
    return true;
  }

  const findMany = vi.fn(
    async ({ where, take }: { where?: Record<string, unknown>; take?: number }) => {
      let result = [...rows.values()].filter((r) => matches(r, where)).map((r) => ({ ...r }));
      if (typeof take === "number") result = result.slice(0, take);
      return result;
    }
  );

  const updateMany = vi.fn(
    async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      let count = 0;
      for (const r of rows.values()) {
        if (matches(r, where)) {
          Object.assign(r, data);
          r.updatedAt = currentNow;
          count++;
        }
      }
      return { count };
    }
  );

  const update = vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
    const r = rows.get(where.id);
    if (!r) throw new Error("Record not found (P2025)");
    Object.assign(r, data);
    r.updatedAt = currentNow;
    return { ...r };
  });

  const prisma = {
    scheduledPost: { findMany, updateMany, update },
  };

  // Mirrors withAdvisoryLock's observable contract exactly (see
  // lib/scheduled-posts/advisory-lock.ts): held for the whole duration of
  // `fn`, refusing a concurrent call outright, released once `fn` settles
  // (success or throw) — never left dangling. Also passes a `LockHandle`
  // whose `isHeld()` always reports true, like a real connection that never
  // drops — tests that need to simulate a lost lock (R4) override
  // `withAdvisoryLock` themselves instead of mutating this default.
  const withAdvisoryLock = vi.fn(async <T>(fn: (lock: { isHeld(): boolean }) => Promise<T>) => {
    if (lockHeld) return { skipped: "locked" as const };
    lockHeld = true;
    try {
      return await fn({ isHeld: () => true });
    } finally {
      lockHeld = false;
    }
  });

  class MetaApiError extends Error {
    httpStatus: number;
    constructor(message: string, httpStatus = 0) {
      super(message);
      this.name = "MetaApiError";
      this.httpStatus = httpStatus;
    }
  }

  const meta = {
    createReelsContainer: vi.fn(),
    createImageContainer: vi.fn(),
    createCarouselChildContainer: vi.fn(),
    createCarouselContainer: vi.fn(),
    getContainerStatus: vi.fn(),
    getContentPublishingLimit: vi.fn(async () => ({
      quota_usage: 0,
      config: { quota_total: 100, quota_duration: 86400 },
    })),
    publishMediaContainer: vi.fn(),
    getMediaPermalink: vi.fn(
      async (): Promise<{ permalink?: string }> => ({ permalink: undefined })
    ),
    listRecentMedia: vi.fn(
      async (): Promise<Array<{ id: string; caption?: string; timestamp: string; permalink?: string }>> =>
        []
    ),
    MetaApiError,
  };

  const decryptToken = vi.fn((token: string) => token);
  const deleteMediaFiles = vi.fn(async (filenames: string[]): Promise<void> => void filenames);
  const listMediaFiles = vi.fn(
    async (): Promise<Array<{ filename: string; mtimeMs: number; isTmp: boolean }>> => []
  );
  const sendPublishFailureAlert = vi.fn();
  const sendPublishWarningAlert = vi.fn();

  return {
    rows,
    prisma,
    withAdvisoryLock,
    meta,
    decryptToken,
    deleteMediaFiles,
    listMediaFiles,
    sendPublishFailureAlert,
    sendPublishWarningAlert,
    setNow: (d: Date) => {
      currentNow = d;
    },
  };
}
