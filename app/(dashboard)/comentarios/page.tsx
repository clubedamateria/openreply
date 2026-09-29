"use client";

/**
 * Página Comentários
 *
 * Perguntas do público, posts mais comentados, do que o público fala
 * (palavras/expressões/emojis), todos os comentários e o desempenho das
 * palavras-chave de cada campanha.
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  HelpCircle,
  Images,
  MessageCircle,
  Users,
} from "lucide-react";
import AccountSelect from "@/components/account-select";
import StatCard from "@/components/stat-card";
import type { CommentsResponse, PostKind } from "@/app/api/instagram/comments/route";
import { matchKeywordOnly } from "@/lib/comments/keyword-only";

type PostSummary = CommentsResponse["posts"][number];
type CommentSummary = CommentsResponse["comments"][number];
type KeywordGroup = CommentsResponse["keywordGroups"][number];

const DAYS_OPTIONS = [
  { value: "7", label: "Últimos 7 dias" },
  { value: "30", label: "Últimos 30 dias" },
  { value: "90", label: "Últimos 90 dias" },
];

// With fewer comments than this, word/expression counts are too thin to read
// as a pattern (a single "Oiii" or "de saber" isn't a topic).
const MIN_COMMENTS_FOR_TOPICS = 20;
const COMMENTS_PAGE_SIZE = 50;

const POST_KIND_LABEL: Record<Exclude<PostKind, null>, string> = {
  AD: "Anúncio",
  REELS: "Reel",
  FEED: "Post",
  STORY: "Story",
};

const POST_KIND_BADGE: Record<Exclude<PostKind, null>, string> = {
  AD: "badge-warning",
  REELS: "badge-info",
  FEED: "badge-neutral",
  STORY: "badge-accent",
};

function formatNumber(n: number): string {
  return n.toLocaleString("pt-BR");
}

function formatPercent(rate: number | null): string {
  if (rate === null) return "sem dados";
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

function keywordGroupKey(group: KeywordGroup): string {
  return `${group.automationName}::${group.keyword}`;
}

function PostBadge({ kind }: { kind: PostKind }) {
  if (!kind) return null;
  return <span className={`badge ${POST_KIND_BADGE[kind]}`}>{POST_KIND_LABEL[kind]}</span>;
}

/** @user, data, texto, contexto do post (badge + trecho da legenda) e link — usado em "Perguntas" e "Todos os comentários". */
function CommentListItem({
  comment,
  post,
}: {
  comment: CommentSummary;
  post: PostSummary | undefined;
}) {
  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-bold text-foreground">
          @{comment.username ?? comment.accountUsername}
        </span>
        <span className="shrink-0 text-xs text-muted">{formatDate(comment.commentedAt)}</span>
      </div>
      <p className="mt-1 text-sm text-foreground">{comment.text}</p>
      {(post?.kind || post?.caption || post?.permalink) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
          <PostBadge kind={post?.kind ?? null} />
          {post?.caption && <span className="max-w-[240px] truncate">{post.caption}</span>}
          {post?.permalink && (
            <a
              href={post.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              Abrir no Instagram
            </a>
          )}
        </div>
      )}
    </li>
  );
}

export default function ComentariosPage() {
  const [data, setData] = useState<CommentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState("30");
  const [accountId, setAccountId] = useState("all");
  const [commentFilter, setCommentFilter] = useState<"all" | "questions">("all");
  const [visibleCount, setVisibleCount] = useState(COMMENTS_PAGE_SIZE);
  // Which keyword groups the dono chose to reveal ("25 pessoas comentaram
  // 'Clube' · Mostrar") — every group starts hidden.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    const params = new URLSearchParams({ days });
    if (accountId !== "all") params.set("instagramAccountId", accountId);

    fetch(`/api/instagram/comments?${params}`)
      .then((r) => r.json())
      .then((res) => {
        if (res.success) {
          setData(res.data);
          setError(null);
          setCommentFilter("all");
          setVisibleCount(COMMENTS_PAGE_SIZE);
          setExpandedGroups(new Set());
        } else {
          setError(res.error ?? "Falha ao carregar os comentários");
        }
      })
      .catch(() => setError("Falha ao carregar os comentários"))
      .finally(() => setLoading(false));
  }, [days, accountId]);

  const postsByMediaId = useMemo(
    () => new Map((data?.posts ?? []).map((p) => [p.mediaId, p])),
    [data?.posts]
  );

  const questions = useMemo(
    () => (data?.comments ?? []).filter((c) => c.isQuestion).slice(0, 20),
    [data?.comments]
  );

  const topicChips = useMemo(
    () =>
      [...(data?.wordStats.topWords ?? []), ...(data?.wordStats.topBigrams ?? [])].sort(
        (a, b) => b.count - a.count
      ),
    [data?.wordStats]
  );

  // Which group (if any) a keyword-only comment belongs to, so its "Mostrar"
  // toggle can reveal exactly its own comments and no one else's. Reuses the
  // very same matcher the API uses server-side — `group.keyword` is the
  // surface form actually typed, but the matcher folds case/accent on both
  // sides anyway, so passing it back in as "the keyword" to check against
  // still matches correctly.
  const commentGroupKey = useMemo(() => {
    const map = new Map<string, string>();
    const groups = data?.keywordGroups ?? [];
    if (groups.length === 0) return map;
    for (const comment of data?.comments ?? []) {
      if (!comment.isKeywordOnly) continue;
      for (const group of groups) {
        if (matchKeywordOnly(comment.text, [group.keyword])) {
          map.set(comment.id, keywordGroupKey(group));
          break;
        }
      }
    }
    return map;
  }, [data?.comments, data?.keywordGroups]);

  const filteredComments = useMemo(() => {
    const list = data?.comments ?? [];
    const byQuestion = commentFilter === "questions" ? list.filter((c) => c.isQuestion) : list;
    // Keyword-only comments stay out of the list until their group is
    // revealed — a comment that is keyword-only but, for whatever reason,
    // doesn't resolve to any group stays hidden too (safe default).
    return byQuestion.filter((c) => {
      if (!c.isKeywordOnly) return true;
      const key = commentGroupKey.get(c.id);
      return key ? expandedGroups.has(key) : false;
    });
  }, [data?.comments, commentFilter, commentGroupKey, expandedGroups]);

  function toggleKeywordGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setVisibleCount(COMMENTS_PAGE_SIZE);
  }

  function handleDaysChange(next: string) {
    setLoading(true);
    setDays(next);
  }

  function handleAccountChange(next: string) {
    setLoading(true);
    setAccountId(next);
  }

  function handleFilterChange(next: "all" | "questions") {
    setCommentFilter(next);
    setVisibleCount(COMMENTS_PAGE_SIZE);
  }

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="skeleton h-14 w-72 rounded-2xl" />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
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
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6 stagger">
      {/* 1. Cabeçalho */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-extrabold text-brand">Comentários</h1>
          <p className="mt-1 text-sm text-muted">
            O que o público pergunta e comenta nos seus posts.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div>
            <label htmlFor="comentarios-days" className="label">
              Período
            </label>
            <select
              id="comentarios-days"
              value={days}
              onChange={(e) => handleDaysChange(e.target.value)}
              className="field w-auto min-w-40"
            >
              {DAYS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {data.accounts.length > 1 && (
            <AccountSelect
              accounts={data.accounts.map((a) => ({
                id: a.id,
                username: a.username,
                instagramId: a.id,
              }))}
              value={accountId}
              onChange={handleAccountChange}
              includeAll
            />
          )}
        </div>
      </div>

      {/* 2. Linha de 4 números */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Comentários"
          value={formatNumber(data.summary.totalComments)}
          icon={<MessageCircle size={20} />}
          tone="accent"
        />
        <StatCard
          label="Pessoas diferentes"
          value={formatNumber(data.summary.uniquePeople)}
          icon={<Users size={20} />}
          tone="brand"
        />
        <StatCard
          label="Perguntas"
          value={formatNumber(data.summary.questions)}
          icon={<HelpCircle size={20} />}
          tone="sun"
        />
        <StatCard
          label="Posts comentados"
          value={formatNumber(data.summary.postsWithComments)}
          icon={<Images size={20} />}
          tone="info"
        />
      </div>

      {/* 3. Perguntas do público */}
      <div className="card p-4 sm:p-6">
        <h2 className="mb-4 text-sm font-bold text-foreground">Perguntas do público</h2>
        {questions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Nenhuma pergunta no período.</p>
        ) : (
          <ul className="divide-y divide-border">
            {questions.map((comment) => (
              <CommentListItem
                key={comment.id}
                comment={comment}
                post={postsByMediaId.get(comment.mediaId)}
              />
            ))}
          </ul>
        )}
      </div>

      {/* 4. Posts com mais comentários | Do que o público fala */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card p-4 sm:p-6">
          <h2 className="mb-4 text-sm font-bold text-foreground">Posts com mais comentários</h2>
          {data.posts.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">Nenhum post comentado no período.</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.posts.map((post) => (
                <li key={post.mediaId} className="flex items-center gap-3 py-3">
                  {post.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={post.thumbnailUrl}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  ) : (
                    <span
                      className="h-10 w-10 shrink-0 rounded bg-surface-hover"
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <PostBadge kind={post.kind} />
                      <span className="truncate text-sm text-foreground">
                        {post.caption ?? "Sem legenda"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {formatNumber(post.count)} comentário{post.count === 1 ? "" : "s"}
                    </p>
                  </div>
                  {post.permalink && (
                    <a
                      href={post.permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-ghost btn-sm shrink-0"
                    >
                      Ver
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card p-4 sm:p-6">
          <h2 className="mb-4 text-sm font-bold text-foreground">Do que o público fala</h2>
          {data.summary.totalComments - data.summary.keywordOnly < MIN_COMMENTS_FOR_TOPICS && (
            <p className="mb-4 text-xs text-muted">
              Com poucos comentários ainda não dá pra ver padrão. Os temas aparecem a partir de
              20 comentários.
            </p>
          )}
          {topicChips.length === 0 && data.wordStats.topEmojis.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              Nenhum tema com repetição no período.
            </p>
          ) : (
            <div className="space-y-3">
              {topicChips.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {topicChips.map((item) => (
                    <span key={item.label} className="badge badge-neutral">
                      {item.label} · {item.count}
                    </span>
                  ))}
                </div>
              )}
              {data.wordStats.topEmojis.length > 0 && (
                <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                  {data.wordStats.topEmojis.map((item) => (
                    <span key={item.label} className="badge badge-neutral">
                      {item.label} · {item.count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 5. Todos os comentários */}
      <div className="card p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-foreground">Todos os comentários</h2>
          <div
            role="group"
            aria-label="Filtrar comentários"
            className="inline-flex shrink-0 gap-1 rounded-[10px] border border-border bg-surface p-1"
          >
            {(["all", "questions"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => handleFilterChange(f)}
                aria-pressed={commentFilter === f}
                className={`min-h-[36px] rounded-lg px-3 text-sm font-bold transition-colors ${
                  commentFilter === f
                    ? "bg-brand-soft text-brand"
                    : "text-muted hover:bg-surface-hover hover:text-foreground"
                }`}
              >
                {f === "all" ? "Todos" : "Só perguntas"}
              </button>
            ))}
          </div>
        </div>
        {commentFilter === "all" && data.keywordGroups.length > 0 && (
          <div className="mb-4 space-y-1.5">
            {data.keywordGroups.map((group) => {
              const key = keywordGroupKey(group);
              const expanded = expandedGroups.has(key);
              return (
                <p key={key} className="text-xs text-muted">
                  {formatNumber(group.count)} pessoa{group.count === 1 ? "" : "s"}{" "}
                  {group.count === 1 ? "comentou" : "comentaram"} &quot;{group.keyword}&quot; para
                  receber a DM ({group.automationName})
                  {" · "}
                  <button
                    type="button"
                    onClick={() => toggleKeywordGroup(key)}
                    className="font-medium text-accent hover:underline"
                  >
                    {expanded ? "Ocultar" : "Mostrar"}
                  </button>
                </p>
              );
            })}
          </div>
        )}
        {filteredComments.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Nenhum comentário no período.</p>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {filteredComments.slice(0, visibleCount).map((comment) => (
                <CommentListItem
                  key={comment.id}
                  comment={comment}
                  post={postsByMediaId.get(comment.mediaId)}
                />
              ))}
            </ul>
            {visibleCount < filteredComments.length && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() => setVisibleCount((c) => c + COMMENTS_PAGE_SIZE)}
                  className="btn btn-secondary"
                >
                  Ver mais
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 6. Palavras-chave das campanhas */}
      {data.campaigns.length > 0 ? (
        <div className="card p-4 sm:p-6">
          <h2 className="mb-4 text-sm font-bold text-foreground">
            Palavras-chave das campanhas
          </h2>
          <div className="space-y-6">
            {data.campaigns.map((campaign) => (
              <div key={campaign.automationId} className="rounded-lg border border-border p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-sm font-medium text-foreground">
                    {campaign.automationName}
                  </h3>
                  <div className="flex flex-wrap gap-4 text-xs text-muted">
                    <span>{formatNumber(campaign.totalMatchedComments)} comentários batidos</span>
                    <span>{formatNumber(campaign.totalDmsSent)} DMs enviadas</span>
                    <span>{formatNumber(campaign.totalClicks)} cliques</span>
                    <span>{formatPercent(campaign.dmToClickRate)} DM → clique</span>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                        <th className="py-2 pr-4 font-medium">Palavra-chave</th>
                        <th className="py-2 px-3 text-right font-medium">Comentários batidos</th>
                        <th className="py-2 pl-3 text-right font-medium">DMs enviadas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {campaign.keywords.map((row) => (
                        <tr key={row.keyword} className="border-b border-border last:border-0">
                          <td className="py-2 pr-4 text-foreground">{row.keyword}</td>
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
        </div>
      ) : (
        <p className="text-sm text-muted">Nenhuma campanha com comentários no período.</p>
      )}
    </div>
  );
}
