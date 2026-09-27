import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { scheduledPostActionSchema } from "@/lib/scheduled-posts/schema";

type RouteProps = { params: Promise<{ id: string }> };

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
    if (!["SCHEDULED", "PREPARING", "FAILED"].includes(post.status)) {
      return NextResponse.json(
        { success: false, error: `Não é possível cancelar um post ${post.status.toLowerCase()}` },
        { status: 409 }
      );
    }
    const updated = await prisma.scheduledPost.update({
      where: { id },
      data: { status: "CANCELED" },
    });
    return NextResponse.json({ success: true, data: updated });
  }

  if (action.action === "retry") {
    if (post.status !== "FAILED") {
      return NextResponse.json(
        { success: false, error: "Só é possível tentar de novo um post que falhou" },
        { status: 409 }
      );
    }
    const updated = await prisma.scheduledPost.update({
      where: { id },
      data: {
        status: "SCHEDULED",
        attempts: 0,
        errorMessage: null,
        containerId: null,
        childContainerIds: [],
        mediaId: null,
      },
    });
    return NextResponse.json({ success: true, data: updated });
  }

  if (action.action === "publish-now") {
    if (post.status !== "SCHEDULED") {
      return NextResponse.json(
        { success: false, error: "Só é possível publicar agora um post agendado" },
        { status: 409 }
      );
    }
    const updated = await prisma.scheduledPost.update({
      where: { id },
      data: { scheduledFor: new Date() },
    });
    return NextResponse.json({ success: true, data: updated });
  }

  // reschedule
  if (!["SCHEDULED", "FAILED"].includes(post.status)) {
    return NextResponse.json(
      { success: false, error: `Não é possível reagendar um post ${post.status.toLowerCase()}` },
      { status: 409 }
    );
  }
  const updated = await prisma.scheduledPost.update({
    where: { id },
    data: {
      scheduledFor: new Date(action.scheduledFor),
      // Rescheduling a failed post is also how you retry it.
      ...(post.status === "FAILED"
        ? {
            status: "SCHEDULED" as const,
            attempts: 0,
            errorMessage: null,
            containerId: null,
            childContainerIds: [],
            mediaId: null,
          }
        : {}),
    },
  });
  return NextResponse.json({ success: true, data: updated });
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
  if (post.status === "PUBLISHING") {
    return NextResponse.json(
      { success: false, error: "Não é possível excluir um post em publicação" },
      { status: 409 }
    );
  }

  await prisma.scheduledPost.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
