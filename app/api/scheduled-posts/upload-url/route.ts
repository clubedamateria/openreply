import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { getSupabaseStorageConfig } from "@/lib/env";
import { createSignedUploadUrl, getPublicStorageUrl } from "@/lib/storage/supabase";
import { storagePathFor } from "@/lib/scheduled-posts/paths";

const bodySchema = z.object({
  instagramAccountId: z.string().min(1),
  filename: z.string().min(1).max(200),
});

/**
 * Mints a signed Supabase Storage upload URL for the "Novo post" form. The
 * browser PUTs the file straight to Supabase with this URL — the service
 * role key never reaches the client.
 */
export async function POST(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  const config = getSupabaseStorageConfig();
  if (!config) {
    return NextResponse.json(
      {
        success: false,
        error: "Armazenamento não configurado (defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY)",
      },
      { status: 503 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos" },
      { status: 400 }
    );
  }

  const account = await getWorkspaceInstagramAccount(workspaceId, parsed.data.instagramAccountId);
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Conta do Instagram não encontrada" },
      { status: 400 }
    );
  }

  const path = storagePathFor(account.username, parsed.data.filename);
  const signed = await createSignedUploadUrl(path, config);

  return NextResponse.json({
    success: true,
    data: {
      path,
      uploadUrl: signed.signedUrl,
      publicUrl: getPublicStorageUrl(path, config),
    },
  });
}
