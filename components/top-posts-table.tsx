"use client";

/**
 * Tabela "Melhores posts" — ranking ordenável por alcance, salvos,
 * compartilhamentos e comentários. Usa os mesmos posts já carregados pela
 * Overview (nenhuma chamada nova à API).
 */

import { useState } from "react";
import type { OverviewPost } from "@/app/api/instagram/overview/route";

type SortKey = "reach" | "saved" | "shares" | "comments";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "reach", label: "Alcance" },
  { key: "saved", label: "Salvos" },
  { key: "shares", label: "Compartilhamentos" },
  { key: "comments", label: "Comentários" },
];

const TOP_N = 10;

function formatNumber(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export default function TopPostsTable({ posts }: { posts: OverviewPost[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("reach");

  const sorted = [...posts]
    .sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0))
    .slice(0, TOP_N);

  return (
    <div className="panel rounded p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-sm font-semibold text-foreground">Melhores posts</h2>
        <div className="flex flex-wrap gap-2">
          {SORT_OPTIONS.map((option) => (
            <button
              key={option.key}
              onClick={() => setSortKey(option.key)}
              className={`
                px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                ${
                  sortKey === option.key
                    ? "bg-accent/15 text-accent border border-accent/20"
                    : "bg-surface text-muted border border-border hover:border-border-hover hover:text-foreground"
                }
              `}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-muted py-8 text-center">
          Nenhum post encontrado
        </p>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-zinc-500 border-b border-border">
                <th className="py-2 pr-4 font-medium">Post</th>
                <th className="py-2 px-3 font-medium text-right">Alcance</th>
                <th className="py-2 px-3 font-medium text-right">Salvos</th>
                <th className="py-2 px-3 font-medium text-right">
                  Compartilhamentos
                </th>
                <th className="py-2 pl-3 font-medium text-right">
                  Comentários
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((post, i) => (
                <tr
                  key={post.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="py-3 pr-4 max-w-xs">
                    <span className="text-xs text-muted mr-2">#{i + 1}</span>
                    {post.permalink ? (
                      <a
                        href={post.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-foreground hover:text-accent truncate"
                      >
                        {post.caption || `${post.mediaType} post`}
                      </a>
                    ) : (
                      <span className="text-foreground truncate">
                        {post.caption || `${post.mediaType} post`}
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-3 text-right text-muted">
                    {formatNumber(post.reach)}
                  </td>
                  <td className="py-3 px-3 text-right text-muted">
                    {formatNumber(post.saved)}
                  </td>
                  <td className="py-3 px-3 text-right text-muted">
                    {formatNumber(post.shares)}
                  </td>
                  <td className="py-3 pl-3 text-right text-muted">
                    {formatNumber(post.comments)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
