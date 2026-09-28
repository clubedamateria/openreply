import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getZernioAccountIdForPlatform } from "@/lib/env";

/**
 * Fase 4: which TikTok/YouTube destinations the "Novo post" form is allowed
 * to offer — each is only enabled once `ZERNIO_API_KEY` AND that platform's
 * own account id are both set in the environment (see
 * getZernioAccountIdForPlatform in lib/env.ts). Instagram's own
 * availability keeps coming from `GET /api/instagram/accounts`, unchanged.
 */
export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  return NextResponse.json({
    success: true,
    data: {
      tiktok: Boolean(getZernioAccountIdForPlatform("TIKTOK")),
      youtube: Boolean(getZernioAccountIdForPlatform("YOUTUBE")),
    },
  });
}
