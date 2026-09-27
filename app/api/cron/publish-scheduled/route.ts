import { NextRequest, NextResponse } from "next/server";
import { runPublishScheduledCron } from "@/lib/scheduled-posts/engine";

/**
 * Two-phase publisher for agendados (see lib/scheduled-posts/engine.ts) plus
 * the 24h bucket cleanup, both run every minute from `scripts/cron.sh` — a
 * tighter interval than the other cron jobs because a missed minute here is a
 * post going out late, not just a delayed refresh.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const data = await runPublishScheduledCron();

  return NextResponse.json({ success: true, data });
}
