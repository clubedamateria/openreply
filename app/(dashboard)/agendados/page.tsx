"use client";

/**
 * Agendados (Scheduled Posts)
 *
 * Posts queued for Instagram, grouped by day (America/Sao_Paulo). Uploaded
 * ahead of time to the VM's local disk (MEDIA_DIR), published by the
 * `publish-scheduled` cron so the Mac does not need to stay on. See
 * docs/2026-09-27-agendados-comentarios.md.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Ban,
  CalendarClock,
  Clapperboard,
  ExternalLink,
  ImagePlus,
  Layers,
  Plus,
  RotateCcw,
  Rocket,
} from "lucide-react";
import AccountSelect from "@/components/account-select";
import ScheduledPostStatusBadge from "@/components/scheduled-post-status-badge";
import { saoPauloToUtcIso } from "@/lib/scheduled-posts/timezone";
import type { ScheduledPostListItem } from "@/app/api/scheduled-posts/route";

const MEDIA_TYPE_ICON = { REELS: Clapperboard, IMAGE: ImagePlus, CAROUSEL: Layers };

function dayKey(iso: string): string {
  // en-CA gives YYYY-MM-DD, which sorts correctly as a plain string.
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function formatDayLabel(key: string): string {
  // Noon is just an anchor safely inside the same calendar day regardless of
  // the exact offset — but computed with the real offset (not a hardcoded
  // "-03:00") like every other date in this file, for consistency.
  return new Date(saoPauloToUtcIso(key, "12:00")).toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AgendadosPage() {
  const [accounts, setAccounts] = useState<{ id: string; username: string; instagramId: string }[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [posts, setPosts] = useState<ScheduledPostListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [rescheduleValue, setRescheduleValue] = useState("");

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (selectedAccountId !== "all") params.set("instagramAccountId", selectedAccountId);

    fetch(`/api/scheduled-posts?${params}`)
      .then((r) => r.json())
      .then((res) => {
        if (res.success) {
          setPosts(res.data);
          setError(null);
        } else {
          setError(res.error ?? "Falha ao carregar os agendados");
        }
      })
      .catch(() => setError("Falha ao carregar os agendados"));
  }, [selectedAccountId]);

  useEffect(() => {
    fetch("/api/instagram/accounts")
      .then((r) => r.json())
      .then((res) => {
        if (res.success) setAccounts(res.data.instagramAccounts);
      });
  }, []);

  useEffect(() => {
    load();
    // Live-ish: a post being prepared/published changes status within
    // minutes, worth refreshing without a manual reload.
    const interval = setInterval(load, 20_000);
    return () => clearInterval(interval);
  }, [load]);

  async function runAction(id: string, body: object) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/scheduled-posts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error ?? "Ação falhou");
        return;
      }
      load();
    } finally {
      setBusyId(null);
      setReschedulingId(null);
    }
  }

  if (error && !posts) {
    return (
      <div className="card flex flex-col items-center gap-3 p-8 text-center">
        <span className="icon-tile bg-error-soft text-error" aria-hidden="true">
          <AlertTriangle size={22} />
        </span>
        <p className="text-sm text-error">{error}</p>
      </div>
    );
  }

  if (!posts) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-14 w-72 rounded-2xl" />
        {[...Array(3)].map((_, i) => (
          <div key={i} className="skeleton h-24 rounded-2xl" />
        ))}
      </div>
    );
  }

  const groups = new Map<string, ScheduledPostListItem[]>();
  for (const post of posts) {
    const key = dayKey(post.scheduledFor);
    const list = groups.get(key) ?? [];
    list.push(post);
    groups.set(key, list);
  }
  const sortedDays = Array.from(groups.keys()).sort();

  return (
    <div className="space-y-6 stagger">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-brand">Agendados</h1>
          <p className="mt-1 text-sm text-muted">
            {posts.length} post{posts.length === 1 ? "" : "s"} agendado
            {posts.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {accounts.length > 1 && (
            <AccountSelect
              accounts={accounts.map((a) => ({ id: a.id, username: a.username, instagramId: a.instagramId }))}
              value={selectedAccountId}
              onChange={setSelectedAccountId}
            />
          )}
          <Link href="/agendados/novo" className="btn btn-primary">
            <Plus size={18} aria-hidden="true" />
            Novo post
          </Link>
        </div>
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      {posts.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-8 text-center">
          <span className="icon-tile bg-brand-soft text-brand" aria-hidden="true">
            <CalendarClock size={22} />
          </span>
          <p className="text-sm text-muted">Nenhum post agendado ainda</p>
          <Link href="/agendados/novo" className="btn btn-primary">
            <Plus size={18} aria-hidden="true" />
            Novo post
          </Link>
        </div>
      ) : (
        sortedDays.map((day) => (
          <div key={day} className="space-y-3">
            <h2 className="text-sm font-extrabold uppercase tracking-wide text-muted">
              {formatDayLabel(day)}
            </h2>
            <div className="space-y-3">
              {groups.get(day)!.map((post) => {
                const MediaIcon = MEDIA_TYPE_ICON[post.mediaType];
                const isBusy = busyId === post.id;
                return (
                  <div key={post.id} className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
                    <div className="flex shrink-0 items-center gap-3 sm:w-40">
                      {post.mediaType === "REELS" ? (
                        <video
                          src={post.mediaUrls[0]}
                          poster={post.coverUrl ?? undefined}
                          preload="metadata"
                          muted
                          className="h-16 w-16 rounded-[10px] object-cover"
                        />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element -- served from MEDIA_DIR, not worth next/image config for a fixed 64px tile
                        <img
                          src={post.mediaUrls[0]}
                          alt=""
                          className="h-16 w-16 rounded-[10px] object-cover"
                        />
                      )}
                      <span className="icon-tile bg-brand-soft text-brand shrink-0" aria-hidden="true">
                        <MediaIcon size={16} />
                      </span>
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-bold text-foreground">{formatTime(post.scheduledFor)}</span>
                        <span className="text-sm text-muted">@{post.instagramAccount.username}</span>
                        <ScheduledPostStatusBadge status={post.status} />
                        {post.source === "LOTE" && <span className="badge badge-neutral">Lote</span>}
                      </div>
                      <p className="mt-1 truncate text-sm text-muted">{post.caption}</p>
                      {post.status === "FAILED" && post.errorMessage && (
                        <p className="mt-1 text-xs text-error">{post.errorMessage}</p>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {post.permalink && (
                        <a
                          href={post.permalink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="btn btn-secondary btn-sm"
                        >
                          <ExternalLink size={14} aria-hidden="true" />
                          Ver post
                        </a>
                      )}
                      {post.status === "SCHEDULED" && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => runAction(post.id, { action: "publish-now" })}
                          className="btn btn-secondary btn-sm"
                        >
                          <Rocket size={14} aria-hidden="true" />
                          Publicar agora
                        </button>
                      )}
                      {post.status === "FAILED" && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => runAction(post.id, { action: "retry" })}
                          className="btn btn-secondary btn-sm"
                        >
                          <RotateCcw size={14} aria-hidden="true" />
                          Tentar de novo
                        </button>
                      )}
                      {(post.status === "SCHEDULED" || post.status === "FAILED") &&
                        (reschedulingId === post.id ? (
                          <span className="inline-flex items-center gap-1.5">
                            <input
                              type="datetime-local"
                              value={rescheduleValue}
                              onChange={(e) => setRescheduleValue(e.target.value)}
                              className="field w-auto"
                            />
                            <button
                              type="button"
                              disabled={isBusy || !rescheduleValue}
                              onClick={() => {
                                const [datePart, timePart] = rescheduleValue.split("T");
                                runAction(post.id, {
                                  action: "reschedule",
                                  scheduledFor: saoPauloToUtcIso(datePart, timePart),
                                });
                              }}
                              className="btn btn-primary btn-sm"
                            >
                              Confirmar
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setReschedulingId(post.id);
                              setRescheduleValue("");
                            }}
                            className="btn btn-ghost btn-sm"
                          >
                            <CalendarClock size={14} aria-hidden="true" />
                            Reagendar
                          </button>
                        ))}
                      {["SCHEDULED", "PREPARING", "FAILED"].includes(post.status) && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => runAction(post.id, { action: "cancel" })}
                          className="btn btn-ghost btn-sm text-error"
                        >
                          <Ban size={14} aria-hidden="true" />
                          Cancelar
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
