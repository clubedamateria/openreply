import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runPublishScheduledCron } from "@/lib/scheduled-posts/engine";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Two-phase publisher for agendados (see lib/scheduled-posts/engine.ts) plus
 * disk cleanup, both run every minute from `scripts/cron.sh` — a tighter
 * interval than the other cron jobs because a missed minute here is a post
 * going out late, not just a delayed refresh.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  // Fails closed: with no secret configured at all, this must never accept
  // requests just because both sides happen to be "empty" — there is no
  // valid Bearer header that satisfies an unset secret.
  const authorized =
    Boolean(cronSecret) &&
    authHeader !== null &&
    authHeader.startsWith("Bearer ") &&
    safeEqual(authHeader.slice("Bearer ".length), cronSecret as string);

  if (!authorized) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const data = await runPublishScheduledCron();

  return NextResponse.json({ success: true, data });
}
