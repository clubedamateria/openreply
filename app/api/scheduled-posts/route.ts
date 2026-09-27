import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { resolveScheduledPostActor } from "@/lib/scheduled-posts/auth";
import { createScheduledPostSchema } from "@/lib/scheduled-posts/schema";
import { getMediaPublicUrl, hashMediaFile, mediaFileExists } from "@/lib/storage/media";

// Needs real fs access (mediaFileExists/hashMediaFile) — must never run on
// the Edge runtime.
export const runtime = "nodejs";
// Read-your-writes for both the panel list and the CLI's dedup check.
export const dynamic = "force-dynamic";

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

export async function GET(request: NextRequest) {
  const actor = await resolveScheduledPostActor(request);
  if (!actor) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  if (actor.source === "LOTE") {
    // The CLI uses this to pre-check dedup (bloqueador 3, permanent) and to
    // skip files it already scheduled — never expose captions/tokens/other
    // workspaces here, only what the dedup decision needs.
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
      select: { id: true, storagePaths: true, status: true, contentHash: true },
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

/**
 * True when `candidate` (the post being created) has the exact same set of
 * file hashes as `existing` (a previously scheduled post on the same
 * account) — order-independent, since re-uploading the same files in a
 * different order is still the same content.
 */
function sameHashSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((h) => setB.has(h));
}

export async function POST(request: NextRequest) {
  const actor = await resolveScheduledPostActor(request);
  if (!actor) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
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

  // storagePaths only ever names files already streamed to MEDIA_DIR by
  // POST /api/scheduled-posts/upload — never trust the client's word that
  // they exist.
  const allPaths = input.coverPath ? [...input.storagePaths, input.coverPath] : input.storagePaths;
  for (const filename of allPaths) {
    if (!(await mediaFileExists(filename))) {
      return NextResponse.json(
        { success: false, error: `Arquivo não encontrado: ${filename}. Faça upload de novo.` },
        { status: 400 }
      );
    }
  }

  // Permanent dedup (bloqueador 3): the hash is computed from the bytes on
  // disk, never trusted from the client, and never cleared once set — even
  // after cleanup deletes the file itself (see
  // lib/scheduled-posts/engine.ts's cleanupFilesFor).
  const contentHash = await Promise.all(input.storagePaths.map((filename) => hashMediaFile(filename)));

  if (!input.force) {
    // `hasSome` uses the GIN index as a coarse pre-filter; the exact-set
    // comparison happens in application code since two posts can share one
    // file (e.g. reused cover) without being the same set.
    const candidates = await prisma.scheduledPost.findMany({
      where: {
        instagramAccountId: account.id,
        status: { not: "CANCELED" },
        contentHash: { hasSome: contentHash },
      },
      select: { id: true, contentHash: true },
    });
    const duplicate = candidates.find((c) => sameHashSet(c.contentHash, contentHash));
    if (duplicate) {
      return NextResponse.json(
        {
          success: false,
          error: `Este conteúdo já está agendado (post ${duplicate.id}). Envie force: true para agendar mesmo assim.`,
          duplicateId: duplicate.id,
        },
        { status: 409 }
      );
    }
  }

  const scheduledPost = await prisma.scheduledPost.create({
    data: {
      workspaceId: account.workspaceId,
      instagramAccountId: account.id,
      mediaType: input.mediaType,
      storagePaths: input.storagePaths,
      mediaUrls: input.storagePaths.map((filename) => getMediaPublicUrl(filename)),
      coverPath: input.coverPath ?? null,
      coverUrl: input.coverPath ? getMediaPublicUrl(input.coverPath) : null,
      contentHash,
      caption: input.caption,
      shareToFeed: input.shareToFeed,
      scheduledFor: new Date(input.scheduledFor),
      source: actor.source,
    },
  });

  return NextResponse.json({ success: true, data: scheduledPost }, { status: 201 });
}
