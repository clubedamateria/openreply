import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { getSchedulerApiToken, getSupabaseStorageConfig } from "@/lib/env";
import { getPublicStorageUrl } from "@/lib/storage/supabase";
import { createScheduledPostSchema } from "@/lib/scheduled-posts/schema";

// Read-your-writes for both the panel list and the CLI's dedup check.
export const dynamic = "force-dynamic";

type Actor =
  | { source: "PAINEL"; workspaceId: string }
  | { source: "LOTE" };

/** Shape of one row in `GET /api/scheduled-posts` for a panel (session) caller. */
export interface ScheduledPostListItem {
  id: string;
  instagramAccountId: string;
  instagramAccount: { username: string };
  mediaType: "REELS" | "IMAGE" | "CAROUSEL";
  mediaUrls: string[];
  coverUrl: string | null;
  caption: string;
  shareToFeed: boolean;
  scheduledFor: string;
  status: "SCHEDULED" | "PREPARING" | "PUBLISHING" | "PUBLISHED" | "FAILED" | "CANCELED";
  permalink: string | null;
  errorMessage: string | null;
  attempts: number;
  publishedAt: string | null;
  source: "PAINEL" | "LOTE";
}

/**
 * Resolves who is calling: a signed-in panel user (session cookie), or the
 * `agendar-lote` CLI (`Authorization: Bearer $SCHEDULER_API_TOKEN`). Returns
 * null when neither checks out, which callers turn into a 401.
 */
async function resolveActor(request: NextRequest): Promise<Actor | null> {
  const authHeader = request.headers.get("authorization");
  const schedulerToken = getSchedulerApiToken();
  if (schedulerToken && authHeader === `Bearer ${schedulerToken}`) {
    return { source: "LOTE" };
  }

  const workspaceId = await getCurrentWorkspaceId();
  if (workspaceId) return { source: "PAINEL", workspaceId };

  return null;
}

export async function GET(request: NextRequest) {
  const actor = await resolveActor(request);
  if (!actor) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  if (actor.source === "LOTE") {
    // The CLI only needs storagePaths to skip files it already scheduled —
    // never expose captions/tokens/other workspaces here.
    const username = request.nextUrl.searchParams.get("username");
    if (!username) {
      return NextResponse.json(
        { success: false, error: "Informe ?username=" },
        { status: 400 }
      );
    }

    const account = await prisma.instagramAccount.findFirst({
      where: { username: { equals: username, mode: "insensitive" } },
      select: { id: true },
    });
    if (!account) {
      return NextResponse.json({ success: true, data: [] });
    }

    const posts = await prisma.scheduledPost.findMany({
      where: { instagramAccountId: account.id, status: { not: "CANCELED" } },
      select: { id: true, storagePaths: true, status: true },
    });
    return NextResponse.json({ success: true, data: posts });
  }

  const instagramAccountId = request.nextUrl.searchParams.get("instagramAccountId");
  const accountFilter =
    instagramAccountId && instagramAccountId !== "all" ? { instagramAccountId } : {};

  const posts = await prisma.scheduledPost.findMany({
    where: { workspaceId: actor.workspaceId, ...accountFilter },
    include: { instagramAccount: { select: { username: true } } },
    orderBy: { scheduledFor: "asc" },
  });

  return NextResponse.json({ success: true, data: posts });
}

export async function POST(request: NextRequest) {
  const actor = await resolveActor(request);
  if (!actor) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  const storageConfig = getSupabaseStorageConfig();
  if (!storageConfig) {
    return NextResponse.json(
      {
        success: false,
        error: "Armazenamento não configurado (defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY)",
      },
      { status: 503 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = createScheduledPostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos" },
      { status: 400 }
    );
  }
  const input = parsed.data;

  const account =
    actor.source === "LOTE"
      ? await prisma.instagramAccount.findFirst({
          where: { username: { equals: input.username, mode: "insensitive" } },
        })
      : await getWorkspaceInstagramAccount(actor.workspaceId, input.instagramAccountId);

  if (!account) {
    return NextResponse.json(
      { success: false, error: "Conta do Instagram não encontrada" },
      { status: 400 }
    );
  }
  // A PAINEL caller could otherwise pass any instagramAccountId — the lookup
  // above already scopes it to the workspace, but double-check explicitly so
  // a future refactor of getWorkspaceInstagramAccount can't silently widen it.
  if (actor.source === "PAINEL" && account.workspaceId !== actor.workspaceId) {
    return NextResponse.json(
      { success: false, error: "Conta do Instagram não encontrada" },
      { status: 400 }
    );
  }

  const scheduledPost = await prisma.scheduledPost.create({
    data: {
      workspaceId: account.workspaceId,
      instagramAccountId: account.id,
      mediaType: input.mediaType,
      storagePaths: input.storagePaths,
      mediaUrls: input.storagePaths.map((path) => getPublicStorageUrl(path, storageConfig)),
      coverUrl: input.coverPath ? getPublicStorageUrl(input.coverPath, storageConfig) : null,
      caption: input.caption,
      shareToFeed: input.shareToFeed,
      scheduledFor: new Date(input.scheduledFor),
      source: actor.source,
    },
  });

  return NextResponse.json({ success: true, data: scheduledPost }, { status: 201 });
}
