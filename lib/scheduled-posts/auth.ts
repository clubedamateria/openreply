import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getSchedulerApiToken } from "@/lib/env";

export type ScheduledPostActor =
  | { source: "PAINEL"; workspaceId: string }
  | { source: "LOTE" };

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Buffers of different lengths would throw inside timingSafeEqual; the
  // length check leaks only the length of the *server's* secret (constant
  // per deploy), never anything about the guess.
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Every `/api/scheduled-posts*` route (list/create, row actions, upload)
 * accepts either the panel's session cookie or
 * `Authorization: Bearer $SCHEDULER_API_TOKEN` from the `agendar-lote` CLI.
 *
 * Fails closed: with `SCHEDULER_API_TOKEN` unset, the bearer branch is never
 * even attempted (no "empty equals empty" bypass), so the lote path is
 * simply unreachable until an operator sets the env.
 */
export async function resolveScheduledPostActor(
  request: NextRequest
): Promise<ScheduledPostActor | null> {
  const authHeader = request.headers.get("authorization");
  const schedulerToken = getSchedulerApiToken();
  if (schedulerToken && authHeader?.startsWith("Bearer ")) {
    const presented = authHeader.slice("Bearer ".length);
    if (safeEqual(presented, schedulerToken)) {
      return { source: "LOTE" };
    }
  }

  const workspaceId = await getCurrentWorkspaceId();
  if (workspaceId) return { source: "PAINEL", workspaceId };

  return null;
}
