import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { scheduledPostActionSchema } from "@/lib/scheduled-posts/schema";
import type { ScheduledPostStatus } from "@/app/generated/prisma/client";

type RouteProps = { params: Promise<{ id: string }> };

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
  const post = await prisma.scheduledPost.findFirst({ where: { id, workspaceId } });
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
    // Bloqueador F: only SCHEDULED/PREPARING can be canceled — once a
    // container exists and publishing is underway (PUBLISHING) or done
    // (PUBLISHED/FAILED/CANCELED), cancel no longer applies.
    const updated = await guardedUpdate(id, ["SCHEDULED", "PREPARING"], { status: "CANCELED" });
    if (updated.count === 0) {
      return NextResponse.json(
        { success: false, error: `Não é possível cancelar um post ${post.status.toLowerCase()}` },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, data: { id, status: "CANCELED" } });
  }

  if (action.action === "retry") {
    const updated = await guardedUpdate(id, ["FAILED"], {
      status: "SCHEDULED",
      attempts: 0,
      errorMessage: null,
      containerId: null,
      childContainerIds: [],
      mediaId: null,
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

  // Bloqueador F: same restriction as cancel — only SCHEDULED/PREPARING,
  // guarded, so a delete can't race a cron tick that just moved the row on.
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
