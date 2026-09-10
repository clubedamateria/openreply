"use client";

/**
 * Painel inicial
 *
 * Saudação, cards de métricas, mini funil, gráfico de DMs por dia,
 * palavras-chave e atividade recente.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  Inbox,
  Megaphone,
  MessagesSquare,
  MousePointerClick,
  Percent,
  Send,
  Tag,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import StatCard from "@/components/stat-card";
import StatusBadge from "@/components/status-badge";

interface DashboardStats {
  userName: string | null;
  contactsCount: number;
  totalAutomations: number;
  activeAutomations: number;
  dmsSentToday: number;
  dmsSentWeek: number;
  dmsSentMonth: number;
  dmsSkippedMonth: number;
  dmsFailedMonth: number;
  commentsMonth: number;
  totalDMs: number;
  clicksThisMonth: number;
  totalClicks: number;
  ctrThisMonth: number;
  instagramAccounts: AccountOption[];
  selectedInstagramAccountId: string | null;
  topKeywords: { keyword: string; count: number }[];
  dailyDMs: { date: string; isoDate?: string; count: number }[];
  recentLogs: Array<{
    id: string;
    commenterName: string | null;
    commentText: string;
    status: string;
    createdAt: string;
    automation: { name: string };
    instagramAccount?: { username: string };
  }>;
}

const BRAND = "#0f4c9c";
const GRID_COLOR = "#e4e4e7";
const AXIS_TEXT = "#71717a";

/** Tempo relativo curto em pt-BR ("há 5 min"). */
function relativeTimePtBr(iso: string, now: Date = new Date()): string {
  const diffSec = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return "agora";
  const min = Math.round(diffSec / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return `há ${d} ${d === 1 ? "dia" : "dias"}`;
  const m = Math.round(d / 30);
  if (m < 12) return `há ${m} ${m === 1 ? "mês" : "meses"}`;
  const y = Math.round(m / 12);
  return `há ${y} ${y === 1 ? "ano" : "anos"}`;
}

function formatDayLabel(point: { date: string; isoDate?: string }): string {
  if (!point.isoDate) return point.date;
  const [, mm, dd] = point.isoDate.split("-");
  return `${dd}/${mm}`;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { date: string; isoDate?: string; count: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-[10px] border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="text-muted">{formatDayLabel(point)}</p>
      <p className="mt-1 font-bold text-foreground">
        {point.count.toLocaleString("pt-BR")} {point.count === 1 ? "DM enviada" : "DMs enviadas"}
      </p>
    </div>
  );
}

function EmptyState({
  icon,
  text,
  ctaLabel,
  ctaHref,
}: {
  icon: React.ReactNode;
  text: string;
  ctaLabel?: string;
  ctaHref?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
      <span className="icon-tile bg-sun-soft text-foreground">{icon}</span>
      <p className="text-sm text-muted max-w-xs">{text}</p>
      {ctaLabel && ctaHref && (
        <Link href={ctaHref} className="btn btn-secondary btn-sm">
          {ctaLabel}
        </Link>
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando painel">
      <div className="skeleton h-36 rounded-2xl" />
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="skeleton h-28 rounded-2xl" />
        ))}
      </div>
      <div className="skeleton h-40 rounded-2xl" />
      <div className="grid grid-cols-1 lg:grid-cols-6 gap-4 sm:gap-6">
        <div className="lg:col-span-3 skeleton h-64 rounded-2xl" />
        <div className="lg:col-span-1 skeleton h-64 rounded-2xl" />
        <div className="lg:col-span-2 skeleton h-64 rounded-2xl" />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedAccountId, setSelectedAccountId] = useState("all");

  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedAccountId !== "all") {
      params.set("instagramAccountId", selectedAccountId);
    }

    fetch(`/api/dashboard/stats${params.size ? `?${params}` : ""}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setStats(data.data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [selectedAccountId]);

  function handleAccountChange(accountId: string) {
    setLoading(true);
    setSelectedAccountId(accountId);
  }

  if (loading) return <DashboardSkeleton />;

  const connectedCount = stats?.instagramAccounts.length ?? 0;
  const selectedAccount =
    stats?.instagramAccounts.find((a) => a.id === selectedAccountId) ??
    stats?.instagramAccounts[0];
  const dmsToday = stats?.dmsSentToday ?? 0;

  const captured = stats?.commentsMonth ?? 0;
  const sent = stats?.dmsSentMonth ?? 0;
  const clicks = stats?.clicksThisMonth ?? 0;
  const funnel = [
    { label: "Comentários captados", value: captured },
    { label: "DMs enviadas", value: sent },
    { label: "Cliques", value: clicks },
  ];

  const chartData = (stats?.dailyDMs ?? []).map((d) => ({ ...d, label: formatDayLabel(d) }));

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* Cabeçalho */}
      <header className="brand-hero p-6 animate-fade-in">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-extrabold">Olá, {stats?.userName ?? "tudo bem"}!</h1>
            <p className="mt-1 text-sm text-white/85">
              {connectedCount === 0
                ? "Nenhuma conta do Instagram conectada ainda"
                : selectedAccountId === "all" && connectedCount > 1
                  ? `${connectedCount} contas conectadas`
                  : `Conta conectada: @${selectedAccount?.username ?? ""}`}
              {" · "}
              {dmsToday} {dmsToday === 1 ? "DM enviada hoje" : "DMs enviadas hoje"}
            </p>
            {stats && stats.instagramAccounts.length > 1 && (
              <div className="mt-4 max-w-xs [&_span]:text-white/80 [&_select]:text-foreground">
                <AccountSelect
                  accounts={stats.instagramAccounts}
                  value={selectedAccountId}
                  onChange={handleAccountChange}
                />
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/campaigns/new" className="btn btn-primary">
              <Megaphone size={18} aria-hidden="true" />
              Nova campanha
            </Link>
            <Link
              href="/funil"
              className="btn btn-ghost text-white hover:bg-white/10 hover:text-white"
            >
              Ver funil
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>

      {/* Cards de métricas */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 sm:gap-4 stagger">
        <StatCard
          label="Campanhas ativas"
          value={stats?.activeAutomations ?? 0}
          icon={<Megaphone size={20} aria-hidden="true" />}
          tone="brand"
        />
        <StatCard
          label="DMs hoje"
          value={dmsToday}
          icon={<Send size={20} aria-hidden="true" />}
          tone="accent"
        />
        <StatCard
          label="DMs 7 dias"
          value={stats?.dmsSentWeek ?? 0}
          icon={<CalendarDays size={20} aria-hidden="true" />}
          tone="info"
        />
        <StatCard
          label="DMs no mês"
          value={sent}
          icon={<MessagesSquare size={20} aria-hidden="true" />}
          tone="brand"
        />
        <StatCard
          label="Cliques no mês"
          value={clicks}
          icon={<MousePointerClick size={20} aria-hidden="true" />}
          tone="sun"
        />
        <StatCard
          label="Taxa de clique"
          value={`${stats?.ctrThisMonth ?? 0}%`}
          icon={<Percent size={20} aria-hidden="true" />}
          tone="success"
        />
      </div>

      {/* Mini funil */}
      <section className="card p-4 sm:p-6" aria-labelledby="mini-funil-title">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 id="mini-funil-title" className="text-sm font-bold text-foreground">
            Funil do mês
          </h2>
          <Link href="/funil" className="text-sm font-bold text-brand hover:underline">
            Ver funil completo
          </Link>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-stretch gap-2">
          {funnel.map((stage, i) => (
            <div key={stage.label} className="contents">
              {i > 0 && (
                <div
                  className="flex items-center justify-center gap-1 text-xs font-bold text-muted sm:flex-col sm:justify-center sm:px-1"
                  aria-label={`Conversão ${pct(stage.value, funnel[i - 1].value)}`}
                >
                  <span>{pct(stage.value, funnel[i - 1].value)}</span>
                  <ArrowRight size={16} aria-hidden="true" className="rotate-90 sm:rotate-0" />
                </div>
              )}
              <div className="flex-1 rounded-2xl bg-surface-hover px-4 py-3 text-center">
                <p className="text-2xl font-extrabold text-foreground">
                  {stage.value.toLocaleString("pt-BR")}
                </p>
                <p className="text-xs text-muted">{stage.label}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Gráfico + palavras-chave + atividade */}
      <div className="grid grid-cols-1 lg:grid-cols-6 gap-4 sm:gap-6">
        <section className="lg:col-span-3 card p-4 sm:p-6" aria-labelledby="chart-title">
          <h2 id="chart-title" className="text-sm font-bold text-foreground mb-4">
            DMs por dia: últimos 7 dias
          </h2>
          {chartData.every((d) => d.count === 0) ? (
            <EmptyState
              icon={<Send size={20} aria-hidden="true" />}
              text="Nenhuma DM enviada nos últimos 7 dias. Crie uma campanha para começar."
              ctaLabel="Nova campanha"
              ctaHref="/campaigns/new"
            />
          ) : (
            <div className="h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke={GRID_COLOR} vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: AXIS_TEXT, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fill: AXIS_TEXT, fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(15,76,156,0.06)" }} />
                  <Bar dataKey="count" fill={BRAND} radius={[6, 6, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="lg:col-span-1 card p-4 sm:p-6" aria-labelledby="kw-title">
          <h2 id="kw-title" className="text-sm font-bold text-foreground mb-4">
            Principais palavras-chave
          </h2>
          {stats?.topKeywords.length === 0 ? (
            <EmptyState
              icon={<Tag size={20} aria-hidden="true" />}
              text="Nenhuma palavra-chave correspondida ainda."
            />
          ) : (
            <ul className="flex flex-wrap gap-2">
              {stats?.topKeywords.map((k) => (
                <li key={k.keyword}>
                  <span className="badge badge-accent">
                    {k.keyword}
                    <span className="ml-1 opacity-80">{k.count}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="lg:col-span-2 card p-4 sm:p-6" aria-labelledby="activity-title">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h2 id="activity-title" className="text-sm font-bold text-foreground">
              Atividade recente
            </h2>
            <Link href="/logs" className="text-sm font-bold text-brand hover:underline">
              Ver tudo
            </Link>
          </div>
          {stats?.recentLogs.length === 0 ? (
            <EmptyState
              icon={<Inbox size={20} aria-hidden="true" />}
              text="Nenhuma atividade ainda. Assim que alguém comentar, aparece aqui."
              ctaLabel="Criar campanha"
              ctaHref="/campaigns/new"
            />
          ) : (
            <ul className="space-y-2 max-h-72 overflow-y-auto">
              {stats?.recentLogs.map((log) => {
                const name = log.commenterName ?? "desconhecido";
                return (
                  <li
                    key={log.id}
                    className="flex items-center gap-3 rounded-2xl border border-border px-3 py-2 min-h-[56px] hover:bg-surface-hover"
                  >
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand font-extrabold uppercase"
                      aria-hidden="true"
                    >
                      {name.charAt(0)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold text-foreground truncate">@{name}</p>
                      <p className="text-xs text-muted truncate">{log.commentText}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-0.5">
                      <StatusBadge status={log.status} />
                      <span className="text-[11px] text-muted whitespace-nowrap">
                        {relativeTimePtBr(log.createdAt)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
