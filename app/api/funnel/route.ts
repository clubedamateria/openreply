import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

/**
 * Funil de conversão: comentários -> palavra-chave -> DM enviada -> clique.
 * Opcionalmente agrega leads do quiz via QUIZ_STATS_URL.
 */

type Range = "7" | "30" | "90" | "all";

interface QuizStats {
  leadsInstagram: number;
  sessions: number;
  completos: number;
  ofertaCliques: number;
}

const QUIZ_TTL_MS = 60_000;
let quizCache: { at: number; value: QuizStats | null } | null = null;

async function fetchQuizStats(): Promise<QuizStats | null> {
  const url = process.env.QUIZ_STATS_URL;
  if (!url) return null;
  if (quizCache && Date.now() - quizCache.at < QUIZ_TTL_MS) return quizCache.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  let value: QuizStats | null = null;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const json = (await res.json()) as {
        sessions?: number;
        funnel?: Record<string, number | undefined>;
        bySource?: Record<string, number | undefined>;
      };
      value = {
        leadsInstagram: Number(json.bySource?.instagram ?? 0),
        sessions: Number(json.sessions ?? 0),
        completos: Number(json.funnel?.quiz_complete ?? 0),
        ofertaCliques: Number(json.funnel?.offer_click ?? 0),
      };
    }
  } catch (error) {
    console.error("[funnel] falha ao buscar QUIZ_STATS_URL", error);
    value = null;
  } finally {
    clearTimeout(timer);
  }
  quizCache = { at: Date.now(), value };
  return value;
}

function parseRange(raw: string | null): Range {
  return raw === "7" || raw === "30" || raw === "90" || raw === "all" ? raw : "30";
}

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  try {
    const range = parseRange(request.nextUrl.searchParams.get("range"));
    const requestedAccountId = request.nextUrl.searchParams.get("instagramAccountId");
    const accountFilter =
      requestedAccountId && requestedAccountId !== "all"
        ? { instagramAccountId: requestedAccountId }
        : {};

    let dateFilter: { createdAt: { gte: Date } } | Record<string, never> = {};
    if (range !== "all") {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      since.setDate(since.getDate() - Number(range));
      dateFilter = { createdAt: { gte: since } };
    }

    const baseWhere = { workspaceId, ...accountFilter, ...dateFilter };
    const notReveal = { NOT: { commentId: { startsWith: "reveal:" } } };

    const [comentarios, palavraChave, dmEnviada, conversaRows, cliqueLink, automations, dmByAutomation, commentsByAutomation, clicksByAutomation, quiz] =
      await Promise.all([
        // Um comentário gera até 2 registros: o comentário em si e o DM de
        // "revelar link" após o toque no botão (commentId "reveal:<id>").
        // Só o primeiro conta como comentário captado.
        prisma.dmLog.count({ where: { ...baseWhere, ...notReveal } }),
        prisma.dmLog.count({ where: { ...baseWhere, ...notReveal, status: { not: "SKIPPED_NO_MATCH" } } }),
        prisma.dmLog.count({ where: { ...baseWhere, status: "SENT" } }),
        prisma.dmLog.findMany({
          where: { ...baseWhere, status: "SENT" },
          distinct: ["commenterId"],
          select: { commenterId: true },
        }),
        prisma.linkClick.count({ where: baseWhere }),
        prisma.automation.findMany({
          where: { workspaceId, ...accountFilter },
          select: { id: true, name: true, isActive: true },
          orderBy: { createdAt: "desc" },
        }),
        prisma.dmLog.groupBy({
          by: ["automationId", "status"],
          where: baseWhere,
          _count: { _all: true },
        }),
        prisma.dmLog.groupBy({
          by: ["automationId"],
          where: { ...baseWhere, ...notReveal },
          _count: { _all: true },
        }),
        prisma.linkClick.groupBy({
          by: ["automationId"],
          where: baseWhere,
          _count: { _all: true },
        }),
        fetchQuizStats(),
      ]);

    const byCampaign = automations.map((a) => {
      const comments =
        commentsByAutomation.find((row) => row.automationId === a.id)?._count._all ?? 0;
      let sent = 0;
      for (const row of dmByAutomation) {
        if (row.automationId !== a.id) continue;
        if (row.status === "SENT") sent += row._count._all;
      }
      const clicks =
        clicksByAutomation.find((row) => row.automationId === a.id)?._count._all ?? 0;
      return { id: a.id, name: a.name, isActive: a.isActive, comments, sent, clicks };
    });

    return NextResponse.json({
      success: true,
      data: {
        range,
        stages: { comentarios, palavraChave, conversas: conversaRows.length, dmEnviada, cliqueLink },
        byCampaign,
        quiz,
      },
    });
  } catch (error) {
    console.error("[funnel] erro", error);
    return NextResponse.json(
      { success: false, error: "Não foi possível carregar o funil" },
      { status: 500 }
    );
  }
}
