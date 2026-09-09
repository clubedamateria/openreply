"use client";

/**
 * Campaigns List Page
 *
 * Shows all campaigns as cards with toggle and delete.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  Copy,
  CopyPlus,
  ExternalLink,
  AtSign,
  Link as LinkIcon,
  Megaphone,
  MoreHorizontal,
  MousePointerClick,
  Play,
  Plus,
  Search,
  Send,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import { readCache, writeCache } from "@/lib/client-cache";

interface Campaign {
  id: string;
  name: string;
  goal: string | null;
  postId: string | null;
  postUrl: string | null;
  pendingNextReel: boolean;
  matchAnyPost: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  dmMessage: string;
  openingDmEnabled: boolean;
  openingDmMessage: string | null;
  openingDmButtonLabel: string | null;
  publicReplyEnabled: boolean;
  publicReplyMessage: string | null;
  publicReplyMessages: string[];
  requireFollow: boolean;
  followPromptMessage: string | null;
  followPromptButtonLabel: string | null;
  isActive: boolean;
  wholeWordMatch: boolean;
  instagramAccountId: string;
  instagramAccount: {
    username: string;
    instagramId: string;
  };
  reportShareSlug: string | null;
  reportShareEnabled: boolean;
  reportUrl: string | null;
  createdAt: string;
  _count: { dmLogs: number };
  trackedLinks: Array<{
    id: string;
    slug: string;
    label: string | null;
    destinationUrl: string;
    trackedUrl: string;
    _count: { clicks: number };
  }>;
  analytics: {
    sent: number;
    skipped: number;
    failed: number;
    clicks: number;
    ctr: number;
    topKeywords: { keyword: string; count: number }[];
  };
}

export default function CampaignsPage() {
  const router = useRouter();
  const [automations, setAutomations] = useState<Campaign[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [loading, setLoading] = useState(true);
  // postId -> current thumbnail URL, fetched live (Instagram URLs expire, so
  // they are never stored on the campaign).
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  // postId -> video URL for reels, so a campaign thumbnail can play on click.
  const [videos, setVideos] = useState<Record<string, string>>({});
  // The reel currently playing in the lightbox (null when closed).
  const [playingVideo, setPlayingVideo] = useState<{
    url: string;
    postUrl: string | null;
  } | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused">(
    "all"
  );

  const fetchAutomations = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (selectedAccountId !== "all") {
        params.set("instagramAccountId", selectedAccountId);
      }
      const res = await fetch(
        `/api/automations${params.size ? `?${params}` : ""}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      if (data.success) setAutomations(data.data);
    } catch (err) {
      console.error("Failed to fetch campaigns:", err);
    } finally {
      setLoading(false);
    }
  }, [selectedAccountId]);

  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((res) => res.json())
      .then((payload) => {
        if (payload.success) setAccounts(payload.data.instagramAccounts ?? []);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchAutomations();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchAutomations]);

  // Fetch fresh post thumbnails (and reel video URLs) for the accounts in view
  // and map them by postId. Cache-first so they show instantly on a return
  // visit. Instagram URLs expire, so they are never stored on the campaign.
  useEffect(() => {
    if (automations.length === 0) return;
    let cancelled = false;
    const accountIds = Array.from(
      new Set(automations.map((a) => a.instagramAccountId))
    ).sort();
    const cacheKey = `ig-media:${accountIds.join(",")}`;

    const cached = readCache<{
      thumbs: Record<string, string>;
      videos: Record<string, string>;
    }>(cacheKey, 15 * 60 * 1000);
    // Hydrating state from cache is a legitimate effect use here.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (cached.data) {
      setThumbnails(cached.data.thumbs);
      setVideos(cached.data.videos);
    }
    /* eslint-enable react-hooks/set-state-in-effect */

    Promise.all(
      accountIds.map((accountId) =>
        fetch(`/api/instagram/posts?instagramAccountId=${accountId}&limit=50`)
          .then((res) => res.json())
          .then((payload) =>
            payload.success
              ? (payload.data as {
                  id: string;
                  media_type?: string;
                  media_url?: string;
                  thumbnail_url?: string;
                }[])
              : []
          )
          .catch(() => [])
      )
    ).then((lists) => {
      if (cancelled) return;
      const thumbs: Record<string, string> = {};
      const vids: Record<string, string> = {};
      for (const list of lists) {
        for (const media of list) {
          const url = media.thumbnail_url ?? media.media_url;
          if (url) thumbs[media.id] = url;
          if (media.media_type === "VIDEO" && media.media_url) {
            vids[media.id] = media.media_url;
          }
        }
      }
      setThumbnails(thumbs);
      setVideos(vids);
      writeCache(cacheKey, { thumbs, videos: vids });
    });

    return () => {
      cancelled = true;
    };
  }, [automations]);

  // Close the reel lightbox on Escape.
  useEffect(() => {
    if (!playingVideo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlayingVideo(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playingVideo]);

  function handleAccountChange(accountId: string) {
    setLoading(true);
    setSelectedAccountId(accountId);
  }

  async function toggleActive(id: string, isActive: boolean) {
    try {
      await fetch(`/api/automations?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !isActive }),
      });
      setAutomations((prev) =>
        prev.map((a) => (a.id === id ? { ...a, isActive: !isActive } : a))
      );
    } catch (err) {
      console.error("Failed to toggle:", err);
    }
  }

  async function copyReelUrl(auto: Campaign) {
    setMenuOpenId(null);
    if (!auto.postUrl) return;
    try {
      await navigator.clipboard.writeText(auto.postUrl);
      setCopiedId(auto.id);
      window.setTimeout(
        () => setCopiedId((cur) => (cur === auto.id ? null : cur)),
        1500
      );
    } catch (err) {
      console.error("Failed to copy reel URL:", err);
    }
  }

  async function deleteAutomation(id: string) {
    if (!confirm("Excluir esta campanha? Essa ação não pode ser desfeita.")) return;
    try {
      await fetch(`/api/automations?id=${id}`, { method: "DELETE" });
      setAutomations((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      console.error("Failed to delete:", err);
    }
  }

  // The copy is made server-side from the stored campaign, so settings this
  // list never loads (the DM trigger, the follow-up, the link button label)
  // still come along.
  async function duplicateAutomation(id: string) {
    setMenuOpenId(null);
    try {
      const res = await fetch(`/api/automations/duplicate?id=${id}`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.success) void fetchAutomations();
      else console.error("Duplicate failed:", data.error);
    } catch (err) {
      console.error("Failed to duplicate:", err);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="skeleton h-5 w-32" />
          <div className="flex gap-3">
            <div className="skeleton h-11 w-28" />
            <div className="skeleton h-11 w-40" />
          </div>
        </div>
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="card p-4">
              <div className="flex gap-4">
                <div className="skeleton h-14 w-14 shrink-0" />
                <div className="flex-1 space-y-3">
                  <div className="skeleton h-4 w-1/3" />
                  <div className="skeleton h-3 w-2/3" />
                  <div className="skeleton h-3 w-1/2" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const query = search.trim().toLowerCase();
  const filtered = automations.filter((a) => {
    if (statusFilter === "active" && !a.isActive) return false;
    if (statusFilter === "paused" && a.isActive) return false;
    if (!query) return true;
    return (
      a.name.toLowerCase().includes(query) ||
      a.keywords.some((k) => k.toLowerCase().includes(query)) ||
      a.dmMessage.toLowerCase().includes(query)
    );
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-extrabold text-brand">Campanhas</h1>
          <p className="mt-1 text-sm text-muted">
            {filtered.length}
            {filtered.length !== automations.length
              ? ` de ${automations.length}`
              : ""}{" "}
            campanha{automations.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {accounts.length > 1 && (
            <AccountSelect
              accounts={accounts}
              value={selectedAccountId}
              onChange={handleAccountChange}
            />
          )}
          <Link
            href="/campaigns/import"
            className="btn btn-secondary flex-1 sm:flex-none"
          >
            <Upload size={18} aria-hidden="true" />
            Importar
          </Link>
          <Link
            href="/campaigns/new"
            className="btn btn-primary flex-1 sm:flex-none"
          >
            <Plus size={18} aria-hidden="true" />
            Nova campanha
          </Link>
        </div>
      </div>

      {/* Search + status filter */}
      {automations.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full">
            <Search
              size={18}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Buscar campanhas"
              placeholder="Buscar por nome, palavra-chave ou mensagem"
              className="field pl-10"
            />
          </div>
          <div
            role="group"
            aria-label="Filtrar por status"
            className="inline-flex shrink-0 gap-1 rounded-[10px] border border-border bg-surface p-1"
          >
            {(["all", "active", "paused"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                aria-pressed={statusFilter === s}
                className={`min-h-[36px] rounded-lg px-3 text-sm font-bold transition-colors ${
                  statusFilter === s
                    ? "bg-brand-soft text-brand"
                    : "text-muted hover:bg-surface-hover hover:text-foreground"
                }`}
              >
                {s === "all" ? "Todas" : s === "active" ? "Ativas" : "Pausadas"}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {automations.length === 0 && (
        <div className="card p-8 text-center sm:p-12">
          <div className="icon-tile mx-auto mb-4 bg-sun-soft text-warning">
            <Megaphone size={22} aria-hidden="true" />
          </div>
          <h3 className="mb-2 text-lg font-extrabold text-foreground">
            Nenhuma campanha ainda
          </h3>
          <p className="mx-auto mb-6 max-w-sm text-sm text-muted">
            Crie sua primeira campanha e transforme comentários de um post ou
            reel em DMs automáticas.
          </p>
          <Link href="/campaigns/new" className="btn btn-brand">
            <Plus size={18} aria-hidden="true" />
            Criar campanha
          </Link>
        </div>
      )}

      {/* No matches for the current filter */}
      {automations.length > 0 && filtered.length === 0 && (
        <div className="card p-8 text-center">
          <div className="icon-tile mx-auto mb-3 bg-sun-soft text-warning">
            <Search size={20} aria-hidden="true" />
          </div>
          <p className="text-sm text-muted">
            Nenhuma campanha corresponde à sua busca.
          </p>
        </div>
      )}

      {/* Campaign cards */}
      <div className="stagger space-y-3">
        {filtered.map((auto) => {
          const videoUrl = auto.postId ? videos[auto.postId] : undefined;
          return (
          <div
            key={auto.id}
            onClick={() => router.push(`/campaigns/${auto.id}`)}
            className="card card-hover cursor-pointer p-4 sm:p-5"
          >
            {/* Wraps rather than compressing: on a phone the action buttons drop
                to their own line instead of squeezing the campaign summary. */}
            <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
              {auto.postId && thumbnails[auto.postId] && (
                videoUrl ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPlayingVideo({ url: videoUrl, postUrl: auto.postUrl });
                    }}
                    aria-label="Reproduzir prévia do reel"
                    className="relative shrink-0"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={thumbnails[auto.postId]}
                      alt="Reel da campanha"
                      className="h-14 w-14 rounded-[10px] border border-border object-cover hover:border-border-hover"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                    <span className="pointer-events-none absolute inset-0 grid place-items-center text-white">
                      <Play size={18} aria-hidden="true" fill="currentColor" />
                    </span>
                  </button>
                ) : (
                  <a
                    href={auto.postUrl ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={thumbnails[auto.postId]}
                      alt="Post da campanha"
                      className="h-14 w-14 rounded-[10px] border border-border object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  </a>
                )
              )}
              <div className="min-w-[12rem] flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-base font-extrabold text-foreground">
                    {auto.name}
                  </h3>
                  <span className="badge badge-neutral">
                    <AtSign size={12} aria-hidden="true" />
                    {auto.instagramAccount.username}
                  </span>
                  <span
                    className={`badge ${
                      auto.isActive ? "badge-success" : "badge-neutral"
                    }`}
                  >
                    {auto.isActive ? "Ativa" : "Pausada"}
                  </span>
                  {auto.pendingNextReel && (
                    <span className="badge badge-warning">
                      Aguardando o próximo reel
                    </span>
                  )}
                  {auto.requireFollow && (
                    <span className="badge badge-info">Exige seguir</span>
                  )}
                  {auto.trackedLinks.length >= 2 && (
                    <span className="badge badge-info">2 links</span>
                  )}
                </div>

                {/* Keywords */}
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {auto.keywords.map((kw) => (
                    <span key={kw} className="badge badge-accent">
                      {kw}
                    </span>
                  ))}
                </div>

                {/* DM preview */}
                <p className="truncate text-sm text-muted">&ldquo;{auto.dmMessage}&rdquo;</p>

                {/* Tracked link sent */}
                {auto.trackedLinks[0]?.trackedUrl && (
                  <p className="mt-2 flex items-center gap-1.5 truncate font-mono text-xs text-muted">
                    <LinkIcon size={12} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">{auto.trackedLinks[0].trackedUrl}</span>
                  </p>
                )}

                {/* Stats */}
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
                  <span className="inline-flex items-center gap-1.5 font-bold text-foreground">
                    <Send size={14} aria-hidden="true" className="text-brand" />
                    {auto.analytics.sent} DMs enviadas
                  </span>
                  <span className="inline-flex items-center gap-1.5 font-bold text-foreground">
                    <MousePointerClick size={14} aria-hidden="true" className="text-accent" />
                    {auto.analytics.clicks} cliques
                  </span>
                  <span className="font-bold text-foreground">
                    {auto.analytics.ctr}% CTR
                  </span>
                  <span>{auto._count.dmLogs} execuções</span>
                  <span>{auto.analytics.skipped} ignoradas</span>
                  <span>{auto.analytics.failed} falhas</span>
                </div>

                {auto.analytics.topKeywords.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {auto.analytics.topKeywords.map((keyword) => (
                      <span
                        key={keyword.keyword}
                        className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-muted"
                      >
                        {keyword.keyword}: {keyword.count}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Actions */}
              <div
                className="ml-auto flex items-center gap-2"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Copy reel URL */}
                {auto.postUrl && (
                  <button
                    type="button"
                    onClick={() => void copyReelUrl(auto)}
                    className="btn btn-sm btn-secondary shrink-0"
                  >
                    {copiedId === auto.id ? (
                      <Check size={16} aria-hidden="true" className="text-success" />
                    ) : (
                      <Copy size={16} aria-hidden="true" />
                    )}
                    {copiedId === auto.id ? "Copiado!" : "Copiar URL"}
                  </button>
                )}
                {/* Toggle */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={auto.isActive}
                  aria-label={auto.isActive ? "Pausar campanha" : "Ativar campanha"}
                  onClick={() => toggleActive(auto.id, auto.isActive)}
                  className="relative grid h-9 w-14 shrink-0 place-items-center"
                >
                  <span
                    className={`relative block h-6 w-11 rounded-full transition-colors ${
                      auto.isActive ? "bg-success" : "bg-border-hover"
                    }`}
                  >
                    <span
                      className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                        auto.isActive ? "left-6" : "left-1"
                      }`}
                    />
                  </span>
                </button>

                {/* Kebab menu */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() =>
                      setMenuOpenId((cur) => (cur === auto.id ? null : auto.id))
                    }
                    aria-label="Mais ações"
                    aria-expanded={menuOpenId === auto.id}
                    className="btn btn-sm btn-ghost px-2"
                  >
                    <MoreHorizontal size={18} aria-hidden="true" />
                  </button>
                  {menuOpenId === auto.id && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => setMenuOpenId(null)}
                      />
                      <div className="card absolute right-0 z-20 mt-1 w-40 overflow-hidden p-1">
                        <button
                          type="button"
                          onClick={() => void duplicateAutomation(auto.id)}
                          className="flex min-h-[40px] w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-bold text-foreground hover:bg-surface-hover"
                        >
                          <CopyPlus size={16} aria-hidden="true" />
                          Duplicar
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMenuOpenId(null);
                            void deleteAutomation(auto.id);
                          }}
                          className="flex min-h-[40px] w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-bold text-error hover:bg-error-soft"
                        >
                          <Trash2 size={16} aria-hidden="true" />
                          Excluir
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
          );
        })}
      </div>

      {/* Reel lightbox */}
      {playingVideo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPlayingVideo(null)}
        >
          <div
            className="relative flex max-w-full flex-col items-end gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-sm">
              {playingVideo.postUrl && (
                <a
                  href={playingVideo.postUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-sm text-white hover:bg-white/10"
                >
                  <ExternalLink size={16} aria-hidden="true" />
                  Abrir no Instagram
                </a>
              )}
              <button
                type="button"
                onClick={() => setPlayingVideo(null)}
                className="btn btn-sm text-white hover:bg-white/10"
              >
                <X size={16} aria-hidden="true" />
                Fechar
              </button>
            </div>
            <video
              src={playingVideo.url}
              controls
              autoPlay
              loop
              playsInline
              className="max-h-[80vh] max-w-full rounded-2xl"
            />
          </div>
        </div>
      )}
    </div>
  );
}
