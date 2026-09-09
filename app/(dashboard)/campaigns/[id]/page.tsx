"use client";

/**
 * Campaign Detail
 *
 * Clicking a campaign opens this read-only view: a summary of the automation
 * on the left, and Insights / Preview tabs on the right. Edit and Stop/Resume
 * live in the top bar.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  BarChart3,
  Eye,
  Link as LinkIcon,
  MousePointerClick,
  Pause,
  Pencil,
  Percent,
  Play,
  Send,
  XCircle,
} from "lucide-react";
import CampaignPreview, { type PreviewTab } from "@/components/campaign-preview";

interface Campaign {
  id: string;
  name: string;
  postId: string | null;
  postUrl: string | null;
  pendingNextReel: boolean;
  matchAnyPost: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  dmTriggerEnabled: boolean;
  dmMessage: string;
  openingDmEnabled: boolean;
  openingDmMessage: string | null;
  openingDmButtonLabel: string | null;
  linkButtonLabel: string | null;
  requireFollow: boolean;
  followPromptMessage: string | null;
  followPromptButtonLabel: string | null;
  followUpEnabled: boolean;
  followUpMessage: string | null;
  followUpDelayMinutes: number | null;
  publicReplyEnabled: boolean;
  publicReplyMessage: string | null;
  publicReplyMessages: string[];
  isActive: boolean;
  instagramAccountId: string;
  instagramAccount: { username: string };
  trackedLinks?: {
    destinationUrl: string;
    label?: string | null;
    trackedUrl?: string;
  }[];
  analytics: {
    sent: number;
    skipped: number;
    failed: number;
    clicks: number;
    ctr: number;
  };
}

type Tab = "insights" | "preview";

export default function CampaignDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [postThumb, setPostThumb] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("insights");
  const [previewTab, setPreviewTab] = useState<PreviewTab>("dm");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/automations", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.success) return setNotFound(true);
        const found = (payload.data as Campaign[]).find((c) => c.id === id);
        if (!found) return setNotFound(true);
        setCampaign(found);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!campaign) return;
    const acct = campaign.instagramAccountId;
    fetch(`/api/instagram/profile?instagramAccountId=${acct}`)
      .then((r) => r.json())
      .then((d) =>
        setAvatarUrl(d.success ? d.data.profilePictureUrl ?? null : null)
      )
      .catch(() => setAvatarUrl(null));

    if (campaign.postId) {
      fetch(`/api/instagram/posts?instagramAccountId=${acct}&limit=50`)
        .then((r) => r.json())
        .then((payload) => {
          if (!payload.success) return;
          const hit = (
            payload.data as {
              id: string;
              thumbnail_url?: string;
              media_url?: string;
            }[]
          ).find((p) => p.id === campaign.postId);
          setPostThumb(hit?.thumbnail_url ?? hit?.media_url ?? null);
        })
        .catch(() => setPostThumb(null));
    }
  }, [campaign]);

  async function toggleActive() {
    if (!campaign) return;
    setBusy(true);
    try {
      await fetch(`/api/automations?id=${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !campaign.isActive }),
      });
      setCampaign({ ...campaign, isActive: !campaign.isActive });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_1fr]">
        <div className="space-y-4">
          <div className="skeleton h-4 w-24" />
          <div className="skeleton h-7 w-2/3" />
          <div className="card space-y-3 p-4">
            <div className="skeleton h-4 w-1/2" />
            <div className="skeleton h-14 w-full" />
          </div>
          <div className="card space-y-3 p-4">
            <div className="skeleton h-4 w-1/2" />
            <div className="skeleton h-10 w-full" />
          </div>
        </div>
        <div className="space-y-4">
          <div className="skeleton h-11 w-full" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="card p-4">
                <div className="skeleton mb-3 h-10 w-10" />
                <div className="skeleton h-7 w-16" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (notFound || !campaign) {
    return (
      <div className="card p-8 text-center sm:p-12">
        <div className="icon-tile mx-auto mb-4 bg-sun-soft text-warning">
          <XCircle size={22} aria-hidden="true" />
        </div>
        <p className="text-sm text-muted">Campanha não encontrada.</p>
        <button
          type="button"
          onClick={() => router.push("/campaigns")}
          className="btn btn-secondary mt-4"
        >
          <ArrowLeft size={18} aria-hidden="true" />
          Voltar para campanhas
        </button>
      </div>
    );
  }

  const publicReplies =
    campaign.publicReplyMessages && campaign.publicReplyMessages.length > 0
      ? campaign.publicReplyMessages
      : campaign.publicReplyMessage
        ? [campaign.publicReplyMessage]
        : [];
  const hasLink = Boolean(campaign.trackedLinks?.[0]?.destinationUrl);
  const hasSecondLink = Boolean(campaign.trackedLinks?.[1]?.destinationUrl);

  const trigger = campaign.matchAnyPost
    ? "Qualquer post ou reel"
    : campaign.pendingNextReel
      ? "Seu próximo reel"
      : "Um post ou reel específico";
  const matchText = campaign.matchAnyWord
    ? "Qualquer comentário"
    : campaign.keywords.join(", ") || "Sem palavras-chave";

  const metrics = [
    {
      label: "DMs enviadas",
      value: campaign.analytics.sent,
      icon: Send,
      tile: "bg-brand-soft text-brand",
    },
    {
      label: "Cliques",
      value: campaign.analytics.clicks,
      icon: MousePointerClick,
      tile: "bg-accent-soft text-accent",
    },
    {
      label: "Taxa de cliques",
      value: `${campaign.analytics.ctr}%`,
      icon: Percent,
      tile: "bg-sun-soft text-warning",
    },
    {
      label: "Falhas",
      value: campaign.analytics.failed,
      icon: XCircle,
      tile: "bg-error-soft text-error",
    },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_1fr]">
      {/* Left: config summary */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Link href="/campaigns" className="btn btn-sm btn-ghost -ml-2">
            <ArrowLeft size={16} aria-hidden="true" />
            Campanhas
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-xl font-extrabold text-brand">
            {campaign.name}
          </h1>
          <span
            className={`badge ${
              campaign.isActive ? "badge-success" : "badge-neutral"
            }`}
          >
            {campaign.isActive ? "Ativa" : "Pausada"}
          </span>
        </div>

        <Summary title="Quando alguém comentar em">
          <div className="flex items-center gap-3">
            {postThumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={postThumb}
                alt="Post"
                className="h-14 w-14 rounded-[10px] border border-border object-cover"
              />
            ) : (
              <div className="grid h-14 w-14 place-items-center rounded-[10px] bg-surface-hover text-[10px] font-bold text-muted">
                {campaign.matchAnyPost || campaign.pendingNextReel ? "Qualquer" : "Post"}
              </div>
            )}
            <span className="text-sm text-foreground">{trigger}</span>
          </div>
        </Summary>

        <Summary title="E o comentário contiver">
          <FieldBox>{matchText}</FieldBox>
          {campaign.dmTriggerEnabled && (
            <p className="text-xs text-muted">
              Também responde quando alguém enviar DM com{" "}
              {campaign.matchAnyWord ? "qualquer coisa" : "essas palavras"}.
            </p>
          )}
          {publicReplies.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-muted">Resposta pública abaixo do post</p>
              {publicReplies.map((m, i) => (
                <FieldBox key={i}>{m}</FieldBox>
              ))}
            </div>
          )}
        </Summary>

        {campaign.openingDmEnabled && (
          <Summary title="A pessoa receberá uma DM de abertura">
            <FieldBox>{campaign.openingDmMessage || "Mensagem de abertura"}</FieldBox>
            <FieldBox>{campaign.openingDmButtonLabel || "Botão"}</FieldBox>
          </Summary>
        )}

        {campaign.requireFollow && (
          <Summary title="Precisa seguir antes">
            <FieldBox>
              {campaign.followPromptMessage ||
                "um favor rápido antes de eu enviar seu link: me segue por aqui? toque no botão quando estiver seguindo e eu envio"}
            </FieldBox>
            <FieldBox>
              {campaign.followPromptButtonLabel || "já estou seguindo"}
            </FieldBox>
          </Summary>
        )}

        <Summary title="E então, a pessoa receberá uma DM">
          <FieldBox>{campaign.dmMessage}</FieldBox>
          {hasLink && (
            <FieldBox>{campaign.linkButtonLabel || "Abrir link"}</FieldBox>
          )}
          {hasSecondLink && (
            <FieldBox>
              {campaign.trackedLinks?.[1]?.label || "Abrir link"}
            </FieldBox>
          )}
        </Summary>

        {hasLink && (
          <Summary title="O link exato enviado">
            {campaign.trackedLinks
              ?.filter((link) => link.destinationUrl)
              .map((link, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex items-start gap-2 rounded-[10px] border border-border bg-surface-hover px-3 py-2">
                    <LinkIcon size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-muted" />
                    <p className="select-all break-all font-mono text-xs text-foreground">
                      {link.trackedUrl ?? link.destinationUrl}
                    </p>
                  </div>
                  <p className="text-xs text-muted">
                    {link.label ? `${link.label} · ` : ""}redireciona para{" "}
                    <span className="break-all">{link.destinationUrl}</span>
                  </p>
                </div>
              ))}
          </Summary>
        )}

        {campaign.followUpEnabled && campaign.followUpMessage && (
          <Summary title="Depois, uma mensagem de acompanhamento">
            <FieldBox>{campaign.followUpMessage}</FieldBox>
            <p className="text-xs text-muted">
              {campaign.followUpDelayMinutes && campaign.followUpDelayMinutes > 0
                ? `Enviada ${campaign.followUpDelayMinutes} min depois do link.`
                : "Enviada logo depois do link."}
            </p>
          </Summary>
        )}
      </div>

      {/* Right: top bar + tabs */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-3 border-b border-border pb-3">
          <div role="tablist" aria-label="Seções da campanha" className="flex gap-1">
            <TabButton active={tab === "insights"} onClick={() => setTab("insights")}>
              <BarChart3 size={16} aria-hidden="true" />
              Insights
            </TabButton>
            <TabButton active={tab === "preview"} onClick={() => setTab("preview")}>
              <Eye size={16} aria-hidden="true" />
              Prévia
            </TabButton>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/campaigns/${campaign.id}/edit`}
              className="btn btn-secondary"
            >
              <Pencil size={18} aria-hidden="true" />
              Editar
            </Link>
            <button
              type="button"
              onClick={toggleActive}
              disabled={busy}
              className={`btn ${campaign.isActive ? "btn-danger" : "btn-primary"}`}
            >
              {campaign.isActive ? (
                <Pause size={18} aria-hidden="true" />
              ) : (
                <Play size={18} aria-hidden="true" />
              )}
              {campaign.isActive ? "Parar" : "Retomar"}
            </button>
          </div>
        </div>

        {tab === "insights" && (
          <div className="stagger grid grid-cols-2 gap-4 sm:grid-cols-4">
            {metrics.map((m) => {
              const Icon = m.icon;
              return (
                <div key={m.label} className="card p-4">
                  <div className={`icon-tile mb-3 ${m.tile}`}>
                    <Icon size={20} aria-hidden="true" />
                  </div>
                  <p className="text-2xl font-extrabold text-foreground">
                    {m.value}
                  </p>
                  <p className="mt-0.5 text-xs font-bold uppercase tracking-wide text-muted">
                    {m.label}
                  </p>
                </div>
              );
            })}
          </div>
        )}

        {tab === "preview" && (
          <div className="flex justify-center sm:justify-start">
          <CampaignPreview
            tab={previewTab}
            onTabChange={setPreviewTab}
            username={campaign.instagramAccount.username}
            avatarUrl={avatarUrl}
            postThumb={postThumb}
            caption=""
            sampleComment={campaign.matchAnyWord ? "top!" : campaign.keywords[0] ?? "LINK"}
            dmTriggerEnabled={campaign.dmTriggerEnabled}
            publicReplyEnabled={campaign.publicReplyEnabled}
            publicReplyMessage={publicReplies[0] ?? ""}
            openingDmEnabled={campaign.openingDmEnabled}
            openingDmMessage={campaign.openingDmMessage ?? ""}
            openingDmButtonLabel={campaign.openingDmButtonLabel ?? ""}
            revealMessage={campaign.dmMessage}
            hasLink={hasLink}
            linkButtonLabel={campaign.linkButtonLabel ?? "Abrir link"}
            linkUrl={
              campaign.trackedLinks?.[0]?.trackedUrl ??
              campaign.trackedLinks?.[0]?.destinationUrl
            }
            hasSecondLink={hasSecondLink}
            secondLinkButtonLabel={
              campaign.trackedLinks?.[1]?.label ?? "Abrir link"
            }
            requireFollow={campaign.requireFollow}
            followPromptMessage={campaign.followPromptMessage ?? ""}
            followPromptButtonLabel={
              campaign.followPromptButtonLabel ?? "já estou seguindo"
            }
            followUpEnabled={campaign.followUpEnabled ?? false}
            followUpMessage={campaign.followUpMessage ?? ""}
            followUpDelayMinutes={campaign.followUpDelayMinutes ?? 0}
          />
          </div>
        )}
      </div>
    </div>
  );
}

function Summary({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card space-y-2 p-4">
      <h2 className="text-xs font-bold uppercase tracking-wide text-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}

function FieldBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[10px] border border-border bg-surface-hover px-3 py-2 text-sm text-foreground">
      {children}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex min-h-[44px] items-center gap-2 rounded-[10px] px-3 text-sm font-bold transition-colors ${
        active
          ? "bg-brand-soft text-brand"
          : "text-muted hover:bg-surface-hover hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
