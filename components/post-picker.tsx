"use client";

/* eslint-disable @next/next/no-img-element */

/**
 * Post Picker
 *
 * Grid of Instagram post thumbnails, selectable.
 * Fetches from /api/instagram/posts.
 */

import { useEffect, useState } from "react";
import { Check, ImageOff, Search } from "lucide-react";
import { readCache, writeCache } from "@/lib/client-cache";

const PAGE_SIZE = 60;

interface InstagramPost {
  id: string;
  caption?: string;
  media_type: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp: string;
}

interface PostPickerProps {
  selectedPostId: string | null;
  instagramAccountId?: string | null;
  /** postId -> name of the campaign already using it. Flagged in the grid. */
  usedPostIds?: Record<string, string>;
  onSelect: (
    postId: string,
    postUrl?: string,
    thumbUrl?: string,
    caption?: string
  ) => void;
}

export default function PostPicker({
  selectedPostId,
  instagramAccountId,
  usedPostIds,
  onSelect,
}: PostPickerProps) {
  const [limitations, setLimitations] = useState<string[]>([]);
  const [posts, setPosts] = useState<InstagramPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // The post currently hovered — its video (if it's a reel) plays a preview.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // The grid loads the whole library (all=true). On accounts with hundreds of
  // posts, rendering every tile at once is enough to make mobile Safari drop
  // the page, so they are revealed in batches.
  const [shown, setShown] = useState(PAGE_SIZE);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (instagramAccountId) {
      params.set("instagramAccountId", instagramAccountId);
    }
    // Load the full library so older posts/reels are selectable, not just the
    // most recent page.
    params.set("all", "true");

    // Show the cached library instantly (stale-while-revalidate), then refresh.
    const cacheKey = `ig-posts:${instagramAccountId ?? "default"}`;
    const cached = readCache<InstagramPost[]>(cacheKey, 15 * 60 * 1000);
    // Hydrating state from cache is a legitimate effect use here.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (cached.data) {
      setPosts(cached.data);
      setLoading(false);
    }
    /* eslint-enable react-hooks/set-state-in-effect */

    fetch(`/api/instagram/posts${params.size ? `?${params}` : ""}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success) {
          setPosts(data.data);
          setLimitations(data.limitations ?? []);
          writeCache(cacheKey, data.data);
        } else if (!cached.data) {
          setError(data.error ?? "Falha ao carregar os posts");
        }
      })
      .catch(() => {
        if (!cancelled && !cached.data) setError("Falha ao carregar os posts");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [instagramAccountId]);

  if (loading) {
    return (
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2" aria-busy="true">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="skeleton aspect-square rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <span className="icon-tile bg-error-soft text-error">
          <ImageOff size={20} aria-hidden="true" />
        </span>
        <p className="text-sm font-bold text-foreground">{error}</p>
        <p className="text-xs text-muted">Conecte sua conta do Instagram primeiro</p>
      </div>
    );
  }

  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <span className="icon-tile bg-sun-soft text-warning">
          <ImageOff size={20} aria-hidden="true" />
        </span>
        <p className="text-sm text-muted">Nenhum post encontrado</p>
      </div>
    );
  }

  const matching = query.trim()
    ? posts.filter((p) =>
        (p.caption ?? "").toLowerCase().includes(query.trim().toLowerCase())
      )
    : posts;

  const visible = matching.slice(0, shown);
  const remaining = matching.length - visible.length;

  return (
    <div className="space-y-3">
      {limitations.map(note => <p key={note} className="helper">{note}</p>)}
      <div className="flex items-center gap-2">
        <label htmlFor="post-picker-search" className="sr-only">
          Buscar posts pela legenda
        </label>
        <div className="relative flex-1">
          <Search
            size={18}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            id="post-picker-search"
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // Back to one batch on every new search. Without this, a grid
              // expanded under an earlier query stays expanded once it is
              // cleared, which is the case this whole change exists to avoid.
              setShown(PAGE_SIZE);
            }}
            placeholder="Buscar seus posts pela legenda…"
            className="field pl-10"
          />
        </div>
        <span className="badge badge-neutral shrink-0">{posts.length} posts</span>
      </div>
      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          Nenhum post corresponde a &ldquo;{query}&rdquo;
        </p>
      ) : (
        <>
          {usedPostIds && Object.keys(usedPostIds).length > 0 && (
            <p className="flex items-center gap-1.5 px-1 text-xs text-muted">
              <span className="inline-block h-2.5 w-2.5 rounded-sm border-2 border-warning" aria-hidden="true" />
              Já em uso
            </p>
          )}
          {/* auto-rows-min + content-start keep each row at its natural height.
              Without them the rows share out max-h-64 instead of scrolling, and
              the square thumbnails flatten into strips. */}
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-64 auto-rows-min content-start overflow-y-auto p-1">
            {visible.map((post) => {
              const isSelected = selectedPostId === post.id;
              const usedByName = usedPostIds?.[post.id];
              const isUsed = Boolean(usedByName) && !isSelected;
              const thumb = post.thumbnail_url ?? post.media_url;
              const isVideo = post.media_type === "VIDEO";
              const showVideo =
                isVideo && hoveredId === post.id && Boolean(post.media_url);
              return (
          <button
            key={post.id}
            type="button"
            onClick={() => onSelect(post.id, post.permalink, thumb, post.caption)}
            onMouseEnter={() => setHoveredId(post.id)}
            onMouseLeave={() =>
              setHoveredId((cur) => (cur === post.id ? null : cur))
            }
            aria-pressed={isSelected}
            title={isUsed ? `Já usado em "${usedByName}"` : undefined}
            className={`
              relative aspect-square overflow-hidden rounded-xl bg-surface-hover
              transition-[transform,box-shadow,border-color] duration-150 ease-out
              hover:-translate-y-0.5 hover:shadow-[var(--shadow-card-hover)]
              ${
                isSelected
                  ? "ring-2 ring-accent ring-offset-2 ring-offset-surface"
                  : isUsed
                    ? "border-2 border-warning/60 hover:border-warning"
                    : "border border-border hover:border-border-hover"
              }
            `}
          >
            {thumb ? (
              <img
                src={thumb}
                alt={post.caption?.slice(0, 50) ?? "Post do Instagram"}
                loading="lazy"
                decoding="async"
                className={`w-full h-full object-cover ${isUsed ? "opacity-75" : ""}`}
              />
            ) : (
              <div className="w-full h-full bg-surface-hover flex flex-col items-center justify-center gap-1 text-muted">
                <ImageOff size={18} aria-hidden="true" />
                <span className="text-xs">Sem imagem</span>
              </div>
            )}
            {showVideo && (
              <video
                src={post.media_url}
                poster={thumb}
                autoPlay
                muted
                loop
                playsInline
                preload="none"
                className={`absolute inset-0 h-full w-full object-cover ${
                  isUsed ? "opacity-60" : ""
                }`}
              />
            )}
            {isSelected && (
              <>
                <span
                  className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent text-white shadow"
                  aria-hidden="true"
                >
                  <Check size={14} strokeWidth={3} />
                </span>
                <span className="absolute bottom-0 inset-x-0 bg-accent py-1 text-center text-xs font-bold text-white">
                  Selecionado
                </span>
              </>
            )}
          </button>
              );
            })}
          </div>
          {remaining > 0 && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE_SIZE)}
              className="btn btn-secondary w-full"
            >
              Mostrar mais {Math.min(PAGE_SIZE, remaining)}
            </button>
          )}
        </>
      )}
    </div>
  );
}
