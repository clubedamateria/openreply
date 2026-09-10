"use client";

/**
 * Funil de conversão
 *
 * Etapas do fluxo comentário -> DM -> clique (-> quiz), com filtro de período
 * e quebra por campanha.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ClipboardCheck,
  Filter,
  KeyRound,
  MessageCircle,
  MousePointerClick,
  Send,
} from "lucide-react";

type Range = "7" | "30" | "90" | "all";

interface FunnelData {
  range: Range;
  stages: {
    comentarios: number;
    palavraChave: number;
    conversas: number;
    dmEnviada: number;
    cliqueLink: number;
  };
  byCampaign: Array<{
    id: string;
    name: string;
    isActive: boolean;
    comments: number;
    sent: number;
    clicks: number;
  }>;
  quiz: {
    leadsInstagram: number;
    sessions: number;
    completos: number;
    ofertaCliques: number;
  } | null;
}

const RANGES: Array<{ value: Range; label: string }> = [
  { value: "7", label: "7 dias" },
  { value: "30", label: "30 dias" },
  { value: "90", label: "90 dias" },
  { value: "all", label: "Tudo" },
];

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

function fmt(n: number): string {
  return n.toLocaleString("pt-BR");
}

function FunnelSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando funil">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="skeleton h-36 rounded-2xl" />
        ))}
      </div>
      <div className="skeleton h-64 rounded-2xl" />
    </div>
  );
}

export default function FunilPage() {
  const [range, setRange] = useState<Range>("30");
  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetch(`/api/funnel?range=${range}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.success) setData(json.data);
        else setError(json.error ?? "Não foi possível carregar o funil");
      })
      .catch(() => {
        if (!cancelled) setError("Não foi possível carregar o funil");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const stages = data
    ? [
        {
          key: "comentarios",
          label: "Comentários",
          value: data.stages.comentarios,
          icon: <MessageCircle size={22} aria-hidden="true" />,
        },
        {
          key: "palavraChave",
          label: "Com palavra-chave",
          value: data.stages.palavraChave,
          icon: <KeyRound size={22} aria-hidden="true" />,
        },
        {
          key: "conversas",
          label: "Conversas iniciadas",
          value: data.stages.conversas,
          hint: `${data.stages.dmEnviada} ${data.stages.dmEnviada === 1 ? "DM enviada" : "DMs enviadas"}`,
          icon: <Send size={22} aria-hidden="true" />,
        },
        {
          key: "cliqueLink",
          label: "Cliques no link",
          value: data.stages.cliqueLink,
          icon: <MousePointerClick size={22} aria-hidden="true" />,
        },
        ...(data.quiz
          ? [
              {
                key: "quiz",
                label: "Leads no quiz",
                value: data.quiz.leadsInstagram,
                icon: <ClipboardCheck size={22} aria-hidden="true" />,
              },
            ]
          : []),
      ]
    : [];

  const first = stages[0]?.value ?? 0;
  const hasData = first > 0;

  return (
    <div className="space-y-6 sm:space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-foreground">Funil de conversão</h1>
          <p className="mt-1 text-sm text-muted">
            Do comentário no Instagram até o clique no link.
          </p>
        </div>
        <div
          role="group"
          aria-label="Período"
          className="flex flex-wrap gap-2 rounded-2xl bg-surface-hover p-1"
        >
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              aria-pressed={range === r.value}
              onClick={() => setRange(r.value)}
              className={`btn btn-sm min-h-[44px] ${
                range === r.value ? "btn-brand" : "btn-ghost"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" className="card p-4 text-sm text-error">
          {error}
        </div>
      )}

      {loading ? (
        <FunnelSkeleton />
      ) : !data ? null : (
        <>
          {/* Etapas */}
          <section aria-label="Etapas do funil">
            {!hasData ? (
              <div className="card p-8 flex flex-col items-center gap-3 text-center">
                <span className="icon-tile bg-sun-soft text-foreground">
                  <Filter size={22} aria-hidden="true" />
                </span>
                <p className="text-sm text-muted max-w-sm">
                  Nenhum comentário captado nesse período. Crie uma campanha ou amplie o período.
                </p>
                <Link href="/campaigns/new" className="btn btn-primary">
                  Nova campanha
                </Link>
              </div>
            ) : (
              <div className="flex flex-col md:flex-row md:items-stretch gap-3 stagger">
                {stages.map((stage, i) => {
                  const isLast = i === stages.length - 1;
                  const width = Math.max(4, first > 0 ? (stage.value / first) * 100 : 0);
                  return (
                    <div key={stage.key} className="contents">
                      {i > 0 && (
                        <div
                          className="flex items-center justify-center gap-1 text-sm font-bold text-muted md:flex-col md:px-1"
                          aria-label={`Conversão ${pct(stage.value, stages[i - 1].value)}`}
                        >
                          <span>{pct(stage.value, stages[i - 1].value)}</span>
                          <ArrowRight
                            size={18}
                            aria-hidden="true"
                            className="rotate-90 md:rotate-0"
                          />
                        </div>
                      )}
                      <div className="flex-1 min-w-0 flex flex-col gap-2">
                        <div className="card card-hover p-4 flex-1">
                          <span
                            className={`icon-tile ${
                              isLast ? "bg-accent text-white" : "bg-brand-soft text-brand"
                            }`}
                          >
                            {stage.icon}
                          </span>
                          <p className="mt-3 text-3xl font-extrabold text-foreground">
                            {fmt(stage.value)}
                          </p>
                          <p className="text-sm text-muted">{stage.label}</p>
                          {"hint" in stage && stage.hint ? (
                            <p className="mt-1 text-xs font-bold text-brand">{stage.hint}</p>
                          ) : null}
                        </div>
                        <div
                          className="h-2 w-full rounded-full bg-surface-hover overflow-hidden"
                          aria-hidden="true"
                        >
                          <div
                            className={`h-full rounded-full ${isLast ? "bg-accent" : "bg-brand"}`}
                            style={{ width: `${Math.min(100, width)}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Quiz */}
          {data.quiz ? (
            <section className="card p-4 sm:p-6" aria-labelledby="quiz-title">
              <div className="flex items-center gap-3 mb-4">
                <span className="icon-tile bg-sun-soft text-foreground">
                  <ClipboardCheck size={20} aria-hidden="true" />
                </span>
                <h2 id="quiz-title" className="text-sm font-bold text-foreground">
                  Leads do quiz (Instagram)
                </h2>
              </div>
              <dl className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "Leads vindos do Instagram", value: data.quiz.leadsInstagram },
                  { label: "Sessões no quiz", value: data.quiz.sessions },
                  { label: "Quizzes completos", value: data.quiz.completos },
                  { label: "Cliques na oferta", value: data.quiz.ofertaCliques },
                ].map((item) => (
                  <div key={item.label} className="rounded-2xl bg-surface-hover px-4 py-3">
                    <dt className="text-xs text-muted">{item.label}</dt>
                    <dd className="text-2xl font-extrabold text-foreground">{fmt(item.value)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : (
            <section className="card p-4 sm:p-5 flex items-center gap-3">
              <span className="icon-tile bg-surface-hover text-muted">
                <ClipboardCheck size={20} aria-hidden="true" />
              </span>
              <p className="text-sm text-muted">
                Conecte o quiz definindo <code className="font-mono">QUIZ_STATS_URL</code> no
                servidor para ver os leads aqui.
              </p>
            </section>
          )}

          {/* Por campanha */}
          <section className="card overflow-hidden" aria-labelledby="campanhas-title">
            <div className="p-4 sm:p-6 pb-0">
              <h2 id="campanhas-title" className="text-sm font-bold text-foreground">
                Por campanha
              </h2>
            </div>
            {data.byCampaign.length === 0 ? (
              <div className="p-6 flex flex-col items-center gap-3 text-center">
                <span className="icon-tile bg-sun-soft text-foreground">
                  <Send size={22} aria-hidden="true" />
                </span>
                <p className="text-sm text-muted">Nenhuma campanha criada ainda.</p>
                <Link href="/campaigns/new" className="btn btn-secondary btn-sm">
                  Criar campanha
                </Link>
              </div>
            ) : (
              <div className="overflow-x-auto p-4 sm:p-6 pt-4">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-muted">
                      <th className="py-2 pr-4 font-bold">Campanha</th>
                      <th className="py-2 pr-4 font-bold">Status</th>
                      <th className="py-2 pr-4 font-bold text-right">Comentários</th>
                      <th className="py-2 pr-4 font-bold text-right">DMs enviadas</th>
                      <th className="py-2 pr-4 font-bold text-right">Cliques</th>
                      <th className="py-2 font-bold text-right">Taxa DM para clique</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byCampaign.map((c) => (
                      <tr
                        key={c.id}
                        className="border-t border-border hover:bg-surface-hover"
                      >
                        <td className="py-3 pr-4 font-bold text-foreground max-w-[240px] truncate">
                          {c.name}
                        </td>
                        <td className="py-3 pr-4">
                          <span
                            className={`badge ${c.isActive ? "badge-success" : "badge-neutral"}`}
                          >
                            {c.isActive ? "Ativa" : "Pausada"}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-right tabular-nums">{fmt(c.comments)}</td>
                        <td className="py-3 pr-4 text-right tabular-nums">{fmt(c.sent)}</td>
                        <td className="py-3 pr-4 text-right tabular-nums">{fmt(c.clicks)}</td>
                        <td className="py-3 text-right tabular-nums font-bold">
                          {pct(c.clicks, c.sent)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
