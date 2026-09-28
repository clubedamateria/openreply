import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getZernioApiKey, getZernioAccountIdForPlatform } from "@/lib/env";
import { getTikTokCreatorInfo } from "@/lib/zernio/client";

/**
 * Rodada 5, achado 5: `docs.zernio.com/platforms/tiktok` confirms a
 * creator-info endpoint (`GET /accounts/{accountId}/tiktok/creator-info`)
 * that reports which interaction settings (comment/duet/stitch) the creator
 * has already turned off in the TikTok app itself — `enabled: false` there
 * means the panel must disable/force-false that toggle rather than let a
 * submit fail on TikTok's side with a confusing error. Best-effort: any
 * failure (network, Zernio outage, TikTok account not connected yet) just
 * means the form falls back to offering all three toggles, same as before
 * this endpoint existed.
 */
export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  const apiKey = getZernioApiKey();
  const accountId = getZernioAccountIdForPlatform("TIKTOK");
  if (!apiKey || !accountId) {
    return NextResponse.json({ success: true, data: null });
  }

  try {
    const info = await getTikTokCreatorInfo(apiKey, accountId);
    return NextResponse.json({ success: true, data: info });
  } catch (err) {
    console.warn("[Agendados] getTikTokCreatorInfo falhou:", err);
    return NextResponse.json({ success: true, data: null });
  }
}
