import { NextRequest, NextResponse } from "next/server";
import { duplicateCampaign } from "@/lib/campaigns/duplicate";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Não autorizado" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Só donos e administradores podem criar campanhas" },
      { status: 403 }
    );
  }

  const automationId = request.nextUrl.searchParams.get("id");
  if (!automationId) {
    return NextResponse.json(
      { success: false, error: "ID da campanha ausente" },
      { status: 400 }
    );
  }

  const duplicate = await duplicateCampaign({
    automationId,
    workspaceId: context.workspaceId,
  });

  if (!duplicate) {
    return NextResponse.json(
      { success: false, error: "Campanha não encontrada" },
      { status: 404 }
    );
  }

  return NextResponse.json(
    { success: true, data: duplicate },
    { status: 201 }
  );
}
