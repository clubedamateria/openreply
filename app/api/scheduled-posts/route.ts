import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { resolveScheduledPostActor } from "@/lib/scheduled-posts/auth";
import { createScheduledPostSchema } from "@/lib/scheduled-posts/schema";
import { getMediaPublicUrl, hashMediaFile, mediaFileExists } from "@/lib/storage/media";
import { getZernioAccountIdForPlatform } from "@/lib/env";
import type { Prisma } from "@/app/generated/prisma/client";

// Needs real fs access (mediaFileExists/hashMediaFile) — must never run on
// the Edge runtime.
export const runtime = "nodejs";
// Read-your-writes for both the panel list and the CLI's dedup check.
export const dynamic = "force-dynamic";

/** Shape of one row in `GET /api/scheduled-posts` for a panel (session) caller. */
export interface ScheduledPostListItem {
  id: string;
  instagramAccountId: string | null;
  /** `null` for a TIKTOK/YOUTUBE row (Fase 4) — those publish through
   * Zernio, not an InstagramAccount. */
  instagramAccount: { username: string } | null;
  platform: "INSTAGRAM" | "TIKTOK" | "YOUTUBE";
  mediaType: "REELS" | "IMAGE" | "CAROUSEL";
  mediaUrls: string[];
  coverUrl: string | null;
  caption: string;
  shareToFeed: boolean;
  scheduledFor: string;
  status: "SCHEDULED" | "PREPARING" | "PUBLISHING" | "PUBLISHED" | "FAILED" | "CANCELED";
  /** The Instagram permalink, or (Fase 4) the TikTok/YouTube
   * `platformPostUrl` once Zernio resolves it — `null` right after
   * publishing either way. */
  permalink: string | null;
  errorMessage: string | null;
  attempts: number;
  publishedAt: string | null;
  source: "PAINEL" | "LOTE";
  /** Set on a FAILED row when the engine could not confirm whether the
   * platform had already published it — see checkRetrySafety in
   * app/api/scheduled-posts/[id]/route.ts. The panel shows a warning and
   * requires an explicit `force` to retry/reschedule while this is true. */
  outcomeUncertain: boolean;
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
      select: { id: true, workspaceId: true },
    });
    if (!account) {
      return NextResponse.json({ success: true, data: [] });
    }

    // Fase 4: the CLI's dedup check groups by workspace (the "context
    // account"), not just the Instagram account — a TikTok/YouTube-only plan
    // from the same batch needs to see the same already-scheduled set.
    const posts = await prisma.scheduledPost.findMany({
      where: { workspaceId: account.workspaceId, status: { not: "CANCELED" } },
      select: { id: true, storagePaths: true, status: true, contentHash: true, platform: true },
    });
    return NextResponse.json({ success: true, data: posts });
  }

  const instagramAccountId = request.nextUrl.searchParams.get("instagramAccountId");
  const accountFilter =
    instagramAccountId && instagramAccountId !== "all" ? { instagramAccountId } : {};
  const platform = request.nextUrl.searchParams.get("platform");
  const platformFilter =
    platform && platform !== "all" ? { platform: platform as Prisma.EnumScheduledPostPlatformFilter["equals"] } : {};

  const posts = await prisma.scheduledPost.findMany({
    where: { workspaceId: actor.workspaceId, ...accountFilter, ...platformFilter },
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

/** Thrown inside the transaction below to unwind to a 409 without writing
 * anything — nothing has been created yet at that point, so there is
 * nothing to roll back except the read itself. */
class DuplicateContentError extends Error {
  constructor(public readonly duplicateId: string) {
    super("duplicate content");
  }
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

  // Fase 4: instagramAccountId/username is always required, for every
  // platform — it is what resolves `workspaceId` even for a TIKTOK/YOUTUBE
  // row (which stores its own instagramAccountId as null; the Zernio
  // account below is what it actually publishes through).
  const contextAccount =
    actor.source === "LOTE"
      ? await prisma.instagramAccount.findFirst({
          where: { username: { equals: input.username, mode: "insensitive" } },
        })
      : await getWorkspaceInstagramAccount(actor.workspaceId, input.instagramAccountId);

  if (!contextAccount) {
    return NextResponse.json(
      { success: false, error: "Conta do Instagram não encontrada" },
      { status: 400 }
    );
  }
  // A PAINEL caller could otherwise pass any instagramAccountId — the lookup
  // above already scopes it to the workspace, but double-check explicitly so
  // a future refactor of getWorkspaceInstagramAccount can't silently widen it.
  if (actor.source === "PAINEL" && contextAccount.workspaceId !== actor.workspaceId) {
    return NextResponse.json(
      { success: false, error: "Conta do Instagram não encontrada" },
      { status: 400 }
    );
  }

  // Fase 4: the Zernio account for TIKTOK/YOUTUBE is resolved server-side
  // from env, never from client input — a single fixed account per platform.
  let zernioAccountId: string | null = null;
  if (input.platform !== "INSTAGRAM") {
    zernioAccountId = getZernioAccountIdForPlatform(input.platform);
    if (!zernioAccountId) {
      return NextResponse.json(
        {
          success: false,
          error: `Destino ${input.platform === "TIKTOK" ? "TikTok" : "YouTube Shorts"} não está configurado neste ambiente.`,
        },
        { status: 400 }
      );
    }
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

  // Fase 4: dedup (and the lock that serializes it) is scoped per
  // (platform, destination account) — an Instagram row and a TikTok row
  // created from the very same upload/batch are never each other's
  // "duplicate", and a TikTok dedup can never block a YouTube post of the
  // same file either.
  const accountKey = input.platform === "INSTAGRAM" ? contextAccount.id : (zernioAccountId as string);
  const platformAccountFilter: Prisma.ScheduledPostWhereInput =
    input.platform === "INSTAGRAM"
      ? { instagramAccountId: contextAccount.id }
      : { zernioAccountId: accountKey };

  // Rodada 3, achado 3: the check-then-create above was two separate
  // statements, so two POSTs for the same content landing at the same time
  // could both pass the check before either had created a row. A Postgres
  // advisory xact-lock keyed by (platform, account id) — released
  // automatically when the transaction ends — serializes concurrent creates
  // for that destination; unrelated accounts/platforms never block each
  // other. `force: true` still skips the dedup lookup, but stays inside the
  // same transaction/lock so it can never race a non-force create for the
  // same content.
  try {
    const scheduledPost = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${input.platform}:${accountKey}`}))`;

      if (!input.force) {
        // `hasSome` uses the GIN index as a coarse pre-filter; the exact-set
        // comparison happens in application code since two posts can share
        // one file (e.g. reused cover) without being the same set.
        const candidates = await tx.scheduledPost.findMany({
          where: {
            platform: input.platform,
            ...platformAccountFilter,
            status: { not: "CANCELED" },
            contentHash: { hasSome: contentHash },
          },
          select: { id: true, contentHash: true },
        });
        const duplicate = candidates.find((c) => sameHashSet(c.contentHash, contentHash));
        if (duplicate) throw new DuplicateContentError(duplicate.id);
      }

      return tx.scheduledPost.create({
        data: {
          workspaceId: contextAccount.workspaceId,
          platform: input.platform,
          instagramAccountId: input.platform === "INSTAGRAM" ? contextAccount.id : null,
          zernioAccountId: input.platform === "INSTAGRAM" ? null : zernioAccountId,
          platformSettings:
            input.platform === "TIKTOK"
              ? input.tiktokSettings
              : input.platform === "YOUTUBE"
                ? input.youtubeSettings
                : undefined,
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
    });

    return NextResponse.json({ success: true, data: scheduledPost }, { status: 201 });
  } catch (err) {
    if (err instanceof DuplicateContentError) {
      return NextResponse.json(
        {
          success: false,
          error: `Este conteúdo já está agendado (post ${err.duplicateId}). Envie force: true para agendar mesmo assim.`,
          duplicateId: err.duplicateId,
        },
        { status: 409 }
      );
    }
    throw err;
  }
}
