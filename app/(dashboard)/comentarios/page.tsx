"use client";

/**
 * Página Comentários
 *
 * O que o público mais escreve nos comentários (palavras, expressões e
 * emojis), o desempenho das palavras-chave de cada campanha e os
 * comentários mais recentes com link para o post.
 */

import { useEffect, useState } from "react";
import AccountSelect from "@/components/account-select";
import type { CommentsResponse } from "@/app/api/instagram/comments/route";

const DAYS_OPTIONS = [
  { value: "7", label: "Últimos 7 dias" },
  { value: "30", label: "Últimos 30 dias" },
  { value: "90", label: "Últimos 90 dias" },
];

function formatNumber(n: number): string {
  return n.toLocaleString("pt-BR");
}

function formatPercent(rate: number | null): string {
  if (rate === null) return "—";
  return `${Math.round(rate * 100)}%`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function BarList({
  items,
  emptyLabel,
}: {
  items: { label: string; count: number }[];
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted py-6 text-center">{emptyLabel}</p>;
  }
  const max = items[0].count;
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-3">
          <span
            className="w-28 shrink-0 truncate text-sm text-foreground"
            title={item.label}
          >
            {item.label}
          </span>
          <div className="flex-1 h-2 rounded bg-surface-hover overflow-hidden">
            <div
              className="h-full bg-accent"
              style={{ width: `${max > 0 ? (item.count / max) * 100 : 0}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right text-xs text-muted">
            {item.count}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function ComentariosPage() {
  const [data, setData] = useState<CommentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState("30");
  const [accountId, setAccountId] = useState("all");

  useEffect(() => {
    const params = new URLSearchParams({ days });
    if (accountId !== "all") params.set("instagramAccountId", accountId);

    fetch(`/api/instagram/comments?${params}`)
      .then((r) => r.json())
      .then((res) => {
        if (res.success) {
          setData(res.data);
          setError(null);
        } else {
          setError(res.error ?? "Falha ao carregar os comentários");
        }
      })
      .catch(() => setError("Falha ao carregar os comentários"))
      .finally(() => setLoading(false));
  }, [days, accountId]);

  function handleDaysChange(next: string) {
    setLoading(true);
    setDays(next);
  }

  function handleAccountChange(next: string) {
    setLoading(true);
    setAccountId(next);
  }

  if (loading && !data) {
    return (
      <div className="space-y-6">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="panel rounded p-6 h-32 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel rounded p-8 text-center">
        <p className="text-sm text-error">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Comentários</h1>
          <p className="text-sm text-muted mt-1">
            {formatNumber(data.totalComments)} comentário
            {data.totalComments === 1 ? "" : "s"} no período
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <label className="flex flex-col gap-2 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Período
            </span>
            <select
              value={days}
              onChange={(e) => handleDaysChange(e.target.value)}
              className="border-0 bg-transparent py-2 pr-1 text-sm text-foreground outline-none"
            >
              {DAYS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {data.accounts.length > 1 && (
            <AccountSelect
              accounts={data.accounts.map((a) => ({
                id: a.id,
                username: a.username,
                instagramId: a.id,
              }))}
              value={accountId}
              onChange={handleAccountChange}
              label="Conta do Instagram"
              includeAll
            />
          )}
        </div>
      </div>

      {/* 1. O que o público mais escreve */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="panel rounded p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-foreground mb-4">
            Palavras mais escritas
          </h2>
          <BarList
            items={data.wordStats.topWords}
            emptyLabel="Nenhuma palavra encontrada no período"
          />
        </div>
        <div className="panel rounded p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-foreground mb-4">
            Expressões mais escritas
          </h2>
          <BarList
            items={data.wordStats.topBigrams}
            emptyLabel="Nenhuma expressão encontrada no período"
          />
        </div>
        <div className="panel rounded p-4 sm:p-6">
          <h2 className="text-sm font-semibold text-foreground mb-4">
            Emojis mais usados
          </h2>
          <BarList
            items={data.wordStats.topEmojis}
            emptyLabel="Nenhum emoji encontrado no período"
          />
        </div>
      </div>

      {/* 2. Desempenho das palavras-chave por campanha */}
      <div className="panel rounded p-4 sm:p-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">
          Desempenho das palavras-chave por campanha
        </h2>
        {data.campaigns.length === 0 ? (
          <p className="text-sm text-muted py-6 text-center">
            Nenhuma campanha com comentários no período
          </p>
        ) : (
          <div className="space-y-6">
            {data.campaigns.map((campaign) => (
              <div
                key={campaign.automationId}
                className="border border-border rounded p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                  <h3 className="text-sm font-medium text-foreground">
                    {campaign.automationName}
                  </h3>
                  <div className="flex flex-wrap gap-4 text-xs text-muted">
                    <span>
                      {formatNumber(campaign.totalMatchedComments)} comentários batidos
                    </span>
                    <span>{formatNumber(campaign.totalDmsSent)} DMs enviadas</span>
                    <span>{formatNumber(campaign.totalClicks)} cliques</span>
                    <span>
                      {formatPercent(campaign.dmToClickRate)} DM → clique
                    </span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 border-b border-border">
                        <th className="py-2 pr-4 font-medium">Palavra-chave</th>
                        <th className="py-2 px-3 font-medium text-right">
                          Comentários batidos
                        </th>
                        <th className="py-2 pl-3 font-medium text-right">
                          DMs enviadas
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {campaign.keywords.map((row) => (
                        <tr
                          key={row.keyword}
                          className="border-b border-border last:border-0"
                        >
                          <td className="py-2 pr-4 text-foreground">
                            {row.keyword}
                          </td>
                          <td className="py-2 px-3 text-right text-muted">
                            {formatNumber(row.matchedComments)}
                          </td>
                          <td className="py-2 pl-3 text-right text-muted">
                            {formatNumber(row.dmsSent)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3. Comentários recentes */}
      <div className="panel rounded p-4 sm:p-6">
        <h2 className="text-sm font-semibold text-foreground mb-4">
          Comentários recentes
        </h2>
        {data.recentComments.length === 0 ? (
          <p className="text-sm text-muted py-6 text-center">
            Nenhum comentário no período
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {data.recentComments.map((comment) => (
              <li key={comment.id} className="py-3 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-foreground">
                    @{comment.username ?? comment.accountUsername}
                  </span>
                  <span className="text-xs text-muted whitespace-nowrap">
                    {formatDate(comment.commentedAt)}
                  </span>
                </div>
                <p className="text-sm text-muted">{comment.text}</p>
                {comment.permalink && (
                  <a
                    href={comment.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-accent hover:underline w-fit"
                  >
                    Ver post
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
