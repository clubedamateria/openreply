"use client";

/**
 * Instagram Overview Page
 *
 * Aggregate reach/engagement across your recent posts, plus a per-post table.
 * Views / reach / saved / shares come from Instagram media insights (requires
 * the insights permission); likes and comments are always available.
 */

import { useEffect, useState } from "react";
import {
  Eye,
  Users,
  Heart,
  MessageCircle,
  Bookmark,
  Share2,
  AtSign,
  ImageOff,
  AlertTriangle,
  UserRound,
} from "lucide-react";
import AccountSelect from "@/components/account-select";
import StatCard from "@/components/stat-card";
import FollowerChart from "@/components/follower-chart";
import type { OverviewResponse } from "@/app/api/instagram/overview/route";

function formatNumber(n: number | null): string {
  if (n === null) return "n/d";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("pt-BR");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { month: "short", day: "numeric" });
}

const COUNT_OPTIONS = [
  { value: "25", label: "Últimos 25" },
  { value: "50", label: "Últimos 50" },
  { value: "100", label: "Últimos 100" },
  { value: "all", label: "Todo o período" },
];

const METRIC_COLUMNS: Array<{ label: string; Icon: typeof Eye }> = [
  { label: "Visualizações", Icon: Eye },
  { label: "Alcance", Icon: Users },
  { label: "Curtidas", Icon: Heart },
  { label: "Comentários", Icon: MessageCircle },
  { label: "Salvos", Icon: Bookmark },
  { label: "Compartilhamentos", Icon: Share2 },
];

export default function OverviewPage() {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [count, setCount] = useState("50");

  useEffect(() => {
    const params = new URLSearchParams();
    if (selectedAccountId !== "all") {
      params.set("instagramAccountId", selectedAccountId);
    }
    params.set("count", count);

    fetch(`/api/instagram/overview?${params}`)
      .then((r) => r.json())
      .then((res) => {
        if (res.success) {
          setData(res.data);
          setError(null);
        } else {
          setError(res.error ?? "Falha ao carregar a visão geral");
        }
      })
      .catch(() => setError("Falha ao carregar a visão geral"))
      .finally(() => setLoading(false));
  }, [selectedAccountId, count]);

  function handleAccountChange(accountId: string) {
    setLoading(true);
    setSelectedAccountId(accountId);
  }

  function handleCountChange(next: string) {
    setLoading(true);
    setCount(next);
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="skeleton h-14 w-72 rounded-2xl" />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="skeleton h-28 rounded-2xl" />
          ))}
        </div>
        <div className="skeleton h-64 rounded-2xl" />
        <div className="skeleton h-80 rounded-2xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card flex flex-col items-center gap-3 p-8 text-center">
        <span className="icon-tile bg-error-soft text-error" aria-hidden="true">
          <AlertTriangle size={22} />
        </span>
        <p className="text-sm text-error">{error}</p>
        {error.includes("connect") && (
          <a href="/api/instagram/connect" className="btn btn-primary mt-2">
            <AtSign size={18} aria-hidden="true" />
            Conectar Instagram
          </a>
        )}
      </div>
    );
  }

  if (!data) return null;

  const { totals, posts, accounts, insightsAvailable, followers, followerHistory } =
    data;

  return (
    <div className="space-y-6 stagger">
      {data.limitations?.map((note) => (
        <p key={note} className="text-sm text-muted">
          {note}
        </p>
      ))}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold text-brand">Visão geral</h1>
          <p className="mt-1 text-sm text-muted">
            {data.provider !== "ZERNIO" && data.requestedCount === "all" ? "Todo o período" : "Recentes"}:{" "}
            {totals.posts} post{totals.posts === 1 ? "" : "s"} de @
            {data.account.username}
            {data.truncated ? ` (limitado a ${totals.posts})` : ""}
          </p>
          {followers !== null && (
            // Kept out of the tile row below: that row sums the selected posts,
            // whereas this is a current account-level total.
            <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-muted">
              <UserRound size={16} aria-hidden="true" />
              {followers.toLocaleString("pt-BR")} seguidores
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div>
            <label htmlFor="overview-count" className="label">
              Período
            </label>
            <select
              id="overview-count"
              value={count}
              onChange={(e) => handleCountChange(e.target.value)}
              className="field w-auto min-w-40"
            >
              {COUNT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {accounts.length > 1 && (
            <AccountSelect
              accounts={accounts.map((a) => ({
                id: a.id,
                username: a.username,
                instagramId: a.id,
              }))}
              value={selectedAccountId}
              onChange={handleAccountChange}
            />
          )}
        </div>
      </div>

      {!insightsAvailable && (
        <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="flex items-start gap-3">
            <span className="icon-tile bg-warning-soft text-warning" aria-hidden="true">
              <AlertTriangle size={20} />
            </span>
            <div>
              <p className="text-sm font-bold text-foreground">
                Visualizações, alcance, salvos e compartilhamentos precisam da permissão de insights.
              </p>
              <p className="mt-1 text-sm text-muted">
                Reconecte sua conta para concedê-la. Enquanto isso, curtidas e
                comentários são exibidos.
              </p>
            </div>
          </div>
          <a href="/api/instagram/connect" className="btn btn-primary shrink-0">
            <AtSign size={18} aria-hidden="true" />
            Reconectar Instagram
          </a>
        </div>
      )}

      {/* Aggregate totals */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6">
        <StatCard label="Visualizações" value={formatNumber(totals.views)} icon={<Eye size={20} />} tone="brand" />
        <StatCard label="Alcance" value={formatNumber(totals.reach)} icon={<Users size={20} />} tone="info" />
        <StatCard label="Curtidas" value={formatNumber(totals.likes)} icon={<Heart size={20} />} tone="accent" />
        <StatCard label="Comentários" value={formatNumber(totals.comments)} icon={<MessageCircle size={20} />} tone="sun" />
        <StatCard label="Salvos" value={formatNumber(totals.saved)} icon={<Bookmark size={20} />} tone="success" />
        <StatCard label="Compartilhamentos" value={formatNumber(totals.shares)} icon={<Share2 size={20} />} tone="brand" />
      </div>

      {/* Follower trend: account-level, independent of the post range */}
      <FollowerChart data={followerHistory} followers={followers} />

      {/* Per-post table */}
      <div className="card p-4 sm:p-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="icon-tile bg-brand-soft text-brand" aria-hidden="true">
            <AtSign size={20} />
          </span>
          <h2 className="text-base font-extrabold text-foreground">Posts</h2>
        </div>
        {posts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <span className="icon-tile bg-sun-soft text-warning" aria-hidden="true">
              <ImageOff size={22} />
            </span>
            <p className="text-sm text-muted">Nenhum post encontrado</p>
            <a href="/api/instagram/connect" className="btn btn-secondary">
              <AtSign size={18} aria-hidden="true" />
              Reconectar conta
            </a>
          </div>
        ) : (
          // Eight metric columns can't compress into a phone; let the table keep
          // its natural width and scroll inside the card instead.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 pr-4 font-bold">Post</th>
                  {METRIC_COLUMNS.map(({ label, Icon }) => (
                    <th key={label} className="px-3 py-2 text-right font-bold">
                      <span className="inline-flex items-center gap-1.5">
                        <Icon size={14} aria-hidden="true" />
                        {label}
                      </span>
                    </th>
                  ))}
                  <th className="py-2 pl-3 text-right font-bold">Data</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-border last:border-0 hover:bg-surface-hover"
                  >
                    <td className="max-w-xs py-3 pr-4">
                      {p.permalink ? (
                        <a
                          href={p.permalink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate font-semibold text-brand hover:underline"
                        >
                          {p.caption || `Post ${p.mediaType}`}
                        </a>
                      ) : (
                        <span className="block truncate text-foreground">
                          {p.caption || `Post ${p.mediaType}`}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right text-muted">
                      {formatNumber(p.views)}
                    </td>
                    <td className="px-3 py-3 text-right text-muted">
                      {formatNumber(p.reach)}
                    </td>
                    <td className="px-3 py-3 text-right text-muted">
                      {formatNumber(p.likes)}
                    </td>
                    <td className="px-3 py-3 text-right text-muted">
                      {formatNumber(p.comments)}
                    </td>
                    <td className="px-3 py-3 text-right text-muted">
                      {formatNumber(p.saved)}
                    </td>
                    <td className="px-3 py-3 text-right text-muted">
                      {formatNumber(p.shares)}
                    </td>
                    <td className="py-3 pl-3 text-right text-muted">
                      {formatDate(p.timestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
