import { Client } from "pg";

// Arbitrary fixed constant, unique among this app's advisory locks (there
// are no others today).
const ADVISORY_LOCK_KEY = 781_954_223;

export type LockResult<T> = T | { skipped: "locked" };

/**
 * Rodada 3, achado 2: the dedicated connection can drop mid-tick (network
 * blip, VM under memory pressure, Postgres restart) without the process
 * noticing — `pg.Client` does not throw synchronously when its socket dies,
 * it emits an `"error"` event. Unhandled, that event would crash the whole
 * process; handled but ignored, the tick would keep calling
 * `media_publish`/creating containers believing it still holds the lock,
 * even though Postgres has already released it (session-scoped advisory
 * locks are freed the instant the connection closes) and a second,
 * overlapping tick may now also be running.
 *
 * `isHeld()` is the caller's only way to notice this happened: it starts
 * true and flips to false the moment the connection reports an error, so a
 * long-running tick can check it before every one-way Meta call and abort
 * the rest of its own work rather than race a tick that may have taken over
 * the lock.
 */
export interface LockHandle {
  isHeld(): boolean;
}

/**
 * Bloqueador 7 (docs/2026-09-27-agendados-comentarios.md, "Mudanças
 * pós-revisão"): a single global advisory lock serializes overlapping
 * `publish-scheduled` ticks (a slow HTTP request plus the next minute's
 * `wget` from cron.sh).
 *
 * Uses a SESSION-scoped lock (`pg_try_advisory_lock` / `pg_advisory_unlock`)
 * on a dedicated `pg.Client` connection created just for this call — not
 * `prisma.$queryRaw` on the shared, pooled adapter-pg client, and not
 * `pg_try_advisory_xact_lock` inside one giant `prisma.$transaction`
 * wrapping the whole tick. Both alternatives were tried first and rejected:
 *
 * - `prisma.$queryRaw` for lock/unlock on the pooled client: with
 *   connection pooling, Prisma checks a connection in and out of the pool
 *   per query, so the lock call and the later unlock call are not
 *   guaranteed to run on the same underlying Postgres session — the unlock
 *   could silently no-op while the lock leaks on a connection sitting back
 *   in the pool.
 * - Wrapping the entire tick (every post's reads/writes) in one interactive
 *   `$transaction` with `pg_try_advisory_xact_lock`: this does pin a single
 *   connection, fixing the point above, but creates a worse problem. Meta
 *   `media_publish` calls are irreversible, real-world side effects, while a
 *   Postgres transaction is all-or-nothing. If ANY later statement in that
 *   same transaction failed for any reason (an unrelated post's cleanup
 *   query, a dropped connection), the whole transaction rolls back —
 *   including the `mediaId` write for a post Meta had *already actually
 *   published* earlier in that same tick. That reintroduces exactly the
 *   double-publish risk this module exists to remove.
 *
 * A dedicated, unpooled connection used for nothing but this lock avoids
 * both problems: lock and unlock always share one session, and every other
 * statement in the tick still runs as its own independent, already-safe
 * (conditional `updateMany`, guarded by status + containerId) unit of work —
 * a failure writing one post can never undo another post's already
 * committed, real-world publish.
 */
export async function withAdvisoryLock<T>(
  fn: (lock: LockHandle) => Promise<T>
): Promise<LockResult<T>> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const client = new Client({ connectionString });
  let lost = false;
  // Without this handler, a dropped socket emits an unhandled "error" that
  // crashes the process instead of just marking the lock lost — attach it
  // before connecting so nothing in between is unprotected.
  client.on("error", (err) => {
    lost = true;
    console.error("[Agendados] conexão do lock consultivo caiu no meio do tick:", err);
  });
  const lock: LockHandle = { isHeld: () => !lost };

  await client.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [ADVISORY_LOCK_KEY]
    );
    if (!rows[0]?.locked) {
      return { skipped: "locked" };
    }

    try {
      return await fn(lock);
    } finally {
      // Best-effort explicit unlock. Even if this call itself fails (or the
      // process crashes right before it runs), closing this dedicated
      // connection immediately below ends the Postgres session, which
      // releases a session-scoped advisory lock just the same.
      if (lock.isHeld()) {
        await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}
