import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { scheduledPostActionSchema } from "@/lib/scheduled-posts/schema";
import { decryptToken } from "@/lib/meta/oauth";
import { getContainerStatus } from "@/lib/meta/client";
import { getZernioPost } from "@/lib/zernio/client";
import { getZernioApiKey } from "@/lib/env";
import {
  applyZernioPlatformResult,
  emptyResult,
  reconcilePublishedContainer,
  reconcileZernioByList,
  zernioPlatformName,
} from "@/lib/scheduled-posts/engine";
import { mediaFileExists } from "@/lib/storage/media";
import type { InstagramProvider, ScheduledPost, ScheduledPostStatus } from "@/app/generated/prisma/client";

// Needs real fs access (mediaFileExists) and calls the Meta Graph API /
// Zernio directly (getContainerStatus/getZernioPost) — must never run on
// the Edge runtime.
export const runtime = "nodejs";

type RouteProps = { params: Promise<{ id: string }> };

type PostWithAccount = ScheduledPost & {
  instagramAccount: { provider: InstagramProvider; accessToken: string; instagramId: string; username: string } | null;
};

/**
 * Every write below is a status-guarded `updateMany` (bloqueador 5): the
 * initial `findFirst` only decides which error message to show if the
 * action doesn't apply — it is not what makes the write safe. The publish
 * cron (lib/scheduled-posts/engine.ts) can move a row out from under a panel
 * action between that read and the write (e.g. SCHEDULED -> PREPARING), and
 * the guard is what stops a stale click from silently overwriting a status
 * the row no longer has.
 */
async function guardedUpdate(
  id: string,
  fromStatuses: ScheduledPostStatus[],
  data: Parameters<typeof prisma.scheduledPost.update>[0]["data"]
) {
  return prisma.scheduledPost.updateMany({
    where: { id, status: { in: fromStatuses } },
    data,
  });
}

/** Every filename this row's own retry/reschedule would rely on must still
 * be on disk (Rodada 3, achado 4) — the orphan/retention cleanups in
 * lib/scheduled-posts/engine.ts only ever delete a post's files once that
 * post is itself past its own retention window, but a post can sit FAILED
 * for much longer than that before someone clicks retry. */
async function firstMissingFile(post: Pick<ScheduledPost, "storagePaths" | "coverPath">): Promise<string | null> {
  const filenames = [...post.storagePaths, ...(post.coverPath ? [post.coverPath] : [])];
  for (const filename of filenames) {
    if (!(await mediaFileExists(filename))) return filename;
  }
  return null;
}

const CANT_CONFIRM_MESSAGE =
  'Não dá para confirmar se este post já foi publicado — confira manualmente na plataforma e, se tiver certeza que não foi, use "Já conferi, publicar de novo".';

const ALREADY_PUBLISHED_MESSAGE =
  "Este post já tinha sido publicado — a tela foi atualizada, não tente de novo.";

/**
 * Rodada 3, achado 1 (Instagram) / Fase 4 (TikTok/YouTube via Zernio): a
 * FAILED post that still has a containerId/zernioPostId from its last
 * attempt might already have been published — the failure can have been an
 * ambiguous timeout/outage rather than a confirmed rejection
 * (`post.outcomeUncertain`, set by lib/scheduled-posts/engine.ts). Blindly
 * zeroing containerId/mediaId/zernioPostId and starting over, as
 * retry/reschedule used to do unconditionally, risks a second, real publish
 * for content that is already live.
 *
 * Returns `null` when it is safe to proceed with a normal retry (nothing to
 * verify, or verification found the old attempt was NOT published).
 * Otherwise returns the error response to send instead of retrying.
 */
async function checkRetrySafety(post: PostWithAccount, force: boolean): Promise<NextResponse | null> {
  if (force) return null;
  if (!post.outcomeUncertain) return null;

  if (post.platform !== "INSTAGRAM") {
    return checkZernioRetrySafety(post);
  }

  if (!post.containerId) return null;
  if (!post.instagramAccount || post.instagramAccount.provider !== "META") return null; // nothing to check on a Zernio-only failure

  let accessToken: string;
  try {
    accessToken = decryptToken(post.instagramAccount.accessToken);
  } catch {
    return NextResponse.json(
      { success: false, error: CANT_CONFIRM_MESSAGE, outcomeUncertain: true },
      { status: 409 }
    );
  }

  let statusCode: Awaited<ReturnType<typeof getContainerStatus>>["status_code"];
  try {
    statusCode = (await getContainerStatus(accessToken, post.containerId)).status_code;
  } catch {
    return NextResponse.json(
      { success: false, error: CANT_CONFIRM_MESSAGE, outcomeUncertain: true },
      { status: 409 }
    );
  }

  if (statusCode === "PUBLISHED") {
    // Reconcile it for real (same logic the cron uses) instead of just
    // refusing — the row was going to sit wrongly as FAILED forever
    // otherwise, since nothing else re-checks a FAILED post's old container.
    await reconcilePublishedContainer(
      prisma,
      { ...post, instagramAccount: post.instagramAccount },
      accessToken,
      new Date(),
      emptyResult(),
      "FAILED"
    );
    return NextResponse.json(
      { success: false, error: ALREADY_PUBLISHED_MESSAGE, outcomeUncertain: true },
      { status: 409 }
    );
  }

  // ERROR/EXPIRED/FINISHED/IN_PROGRESS: an explicit, non-PUBLISHED status
  // confirms the old container was NOT published — safe to recreate.
  return null;
}

/** Fase 4 equivalent of the Instagram branch above, for a FAILED TIKTOK/
 * YOUTUBE post. Mirrors the cron's own reconciliation
 * (lib/scheduled-posts/engine.ts's reconcileZernioPublishing) but with
 * `fromStatus: "FAILED"` throughout, since this row is not PUBLISHING. */
async function checkZernioRetrySafety(post: PostWithAccount): Promise<NextResponse | null> {
  const apiKey = getZernioApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: CANT_CONFIRM_MESSAGE, outcomeUncertain: true },
      { status: 409 }
    );
  }

  if (post.zernioPostId) {
    let remote: Awaited<ReturnType<typeof getZernioPost>>;
    try {
      remote = await getZernioPost(apiKey, post.zernioPostId);
    } catch {
      return NextResponse.json(
        { success: false, error: CANT_CONFIRM_MESSAGE, outcomeUncertain: true },
        { status: 409 }
      );
    }
    const platformName = zernioPlatformName(post.platform as "TIKTOK" | "YOUTUBE");
    const platformResult = remote.platforms.find((p) => p.platform === platformName) ?? remote.platforms[0];
    const outcome = await applyZernioPlatformResult(
      prisma,
      post,
      post.zernioPostId,
      platformResult,
      new Date(),
      emptyResult(),
      "FAILED"
    );
    if (outcome === "published") {
      return NextResponse.json(
        { success: false, error: ALREADY_PUBLISHED_MESSAGE, outcomeUncertain: true },
        { status: 409 }
      );
    }
    if (outcome === "failed") return null; // confirmed not published — safe to recreate
    return NextResponse.json(
      { success: false, error: CANT_CONFIRM_MESSAGE, outcomeUncertain: true },
      { status: 409 }
    );
  }

  // No zernioPostId: the original POST itself was ambiguous — try the same
  // fuzzier content+media+time-window search the cron uses.
  const outcome = await reconcileZernioByList(prisma, post, apiKey, new Date(), emptyResult(), "FAILED").catch(
    () => "pending" as const
  );
  if (outcome === "published") {
    return NextResponse.json(
      { success: false, error: ALREADY_PUBLISHED_MESSAGE, outcomeUncertain: true },
      { status: 409 }
    );
  }
  if (outcome === "failed") return null;
  return NextResponse.json(
    { success: false, error: CANT_CONFIRM_MESSAGE, outcomeUncertain: true },
    { status: 409 }
  );
}

/**
 * Row actions from the `/agendados` panel: cancel, retry a FAILED post,
 * publish a SCHEDULED one right away, or reschedule it. All session-scoped —
 * the `agendar-lote` CLI only ever creates posts (POST `/api/scheduled-posts`),
 * it does not manage them afterward.
 */
export async function PATCH(request: NextRequest, { params }: RouteProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  const { id } = await params;
  const post = (await prisma.scheduledPost.findFirst({
    where: { id, workspaceId },
    include: { instagramAccount: { select: { provider: true, accessToken: true, instagramId: true, username: true } } },
  })) as PostWithAccount | null;
  if (!post) {
    return NextResponse.json(
      { success: false, error: "Post agendado não encontrado" },
      { status: 404 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = scheduledPostActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? "Ação inválida" },
      { status: 400 }
    );
  }
  const action = parsed.data;

  if (action.action === "cancel") {
    // Rodada 3, achado 7: FAILED is cancelable again (the panel's button
    // already showed it) — canceling it is also how its content hash stops
    // blocking a reschedule (the dedup check in POST /api/scheduled-posts
    // excludes CANCELED rows).
    const updated = await guardedUpdate(id, ["SCHEDULED", "PREPARING", "FAILED"], { status: "CANCELED" });
    if (updated.count === 0) {
      return NextResponse.json(
        { success: false, error: `Não é possível cancelar um post ${post.status.toLowerCase()}` },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, data: { id, status: "CANCELED" } });
  }

  if (action.action === "retry") {
    if (post.status !== "FAILED") {
      return NextResponse.json(
        { success: false, error: "Só é possível tentar de novo um post que falhou" },
        { status: 409 }
      );
    }

    const unsafe = await checkRetrySafety(post, action.force);
    if (unsafe) return unsafe;

    const missing = await firstMissingFile(post);
    if (missing) {
      return NextResponse.json(
        { success: false, error: `Arquivo expirou (${missing}), suba de novo em "Novo post".` },
        { status: 409 }
      );
    }

    const updated = await guardedUpdate(id, ["FAILED"], {
      status: "SCHEDULED",
      attempts: 0,
      errorMessage: null,
      containerId: null,
      childContainerIds: [],
      mediaId: null,
      // Fase 4: a stale zernioPostId here would make the next publish
      // attempt's own "write it, guarded by zernioPostId: null" step no-op
      // silently — recreating a real post on TikTok/YouTube that the row
      // would then never learn the id of. Harmless to also reset for an
      // Instagram row (always already null there).
      zernioPostId: null,
      outcomeUncertain: false,
    });
    if (updated.count === 0) {
      return NextResponse.json(
        { success: false, error: "Só é possível tentar de novo um post que falhou" },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, data: { id, status: "SCHEDULED" } });
  }

  if (action.action === "publish-now") {
    const updated = await guardedUpdate(id, ["SCHEDULED"], { scheduledFor: new Date() });
    if (updated.count === 0) {
      return NextResponse.json(
        { success: false, error: "Só é possível publicar agora um post agendado" },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, data: { id } });
  }

  // reschedule
  const isRetryViaReschedule = post.status === "FAILED";
  if (isRetryViaReschedule) {
    const unsafe = await checkRetrySafety(post, action.force);
    if (unsafe) return unsafe;

    const missing = await firstMissingFile(post);
    if (missing) {
      return NextResponse.json(
        { success: false, error: `Arquivo expirou (${missing}), suba de novo em "Novo post".` },
        { status: 409 }
      );
    }
  }

  const updated = await guardedUpdate(id, ["SCHEDULED", "FAILED"], {
    scheduledFor: new Date(action.scheduledFor),
    // Rescheduling a failed post is also how you retry it.
    ...(isRetryViaReschedule
      ? {
          status: "SCHEDULED" as const,
          attempts: 0,
          errorMessage: null,
          containerId: null,
          childContainerIds: [],
          mediaId: null,
          zernioPostId: null,
          outcomeUncertain: false,
        }
      : {}),
  });
  if (updated.count === 0) {
    return NextResponse.json(
      { success: false, error: `Não é possível reagendar um post ${post.status.toLowerCase()}` },
      { status: 409 }
    );
  }
  return NextResponse.json({ success: true, data: { id } });
}

export async function DELETE(_request: NextRequest, { params }: RouteProps) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  const { id } = await params;
  const post = await prisma.scheduledPost.findFirst({ where: { id, workspaceId } });
  if (!post) {
    return NextResponse.json(
      { success: false, error: "Post agendado não encontrado" },
      { status: 404 }
    );
  }

  // Bloqueador F: same restriction as cancel used to be — only SCHEDULED/
  // PREPARING, guarded, so a delete can't race a cron tick that just moved
  // the row on. Deleting (unlike canceling) drops the row entirely, so it is
  // deliberately NOT offered for FAILED — cancel is the way to free up a
  // failed post's content hash; delete stays reserved for posts that never
  // got as far as an attempt.
  const deleted = await prisma.scheduledPost.deleteMany({
    where: { id, status: { in: ["SCHEDULED", "PREPARING"] } },
  });
  if (deleted.count === 0) {
    return NextResponse.json(
      {
        success: false,
        error: `Não é possível excluir um post ${post.status.toLowerCase()} — só agendados ou em preparação`,
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ success: true });
}
