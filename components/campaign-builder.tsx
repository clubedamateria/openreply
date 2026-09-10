"use client";

/**
 * Campaign Builder
 *
 * Two-pane campaign editor: a control panel on the left and a live phone
 * preview on the right. Used for both creating and editing a campaign.
 *
 * Turn 1 wires the fully-functional pieces: trigger scope (specific / any /
 * next post), match mode (specific words / any word), the opening + reveal DM
 * text, public reply, and the tracked link. Button-driven delivery and the
 * follow / email / follow-up steps arrive in later turns.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  FileSpreadsheet,
  Image,
  KeyRound,
  Link2,
  MessageCircle,
  MessageSquareHeart,
  Pause,
  Pencil,
  Play,
  SearchX,
  Send,
  SkipForward,
  UserPlus,
  X,
  Plus,
  type LucideIcon,
} from "lucide-react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import PostPicker from "@/components/post-picker";
import CampaignPreview, { type PreviewTab } from "@/components/campaign-preview";
import { readCache, writeCache } from "@/lib/client-cache";
import {
  IMPORT_QUEUE_KEY,
  IMPORT_ACCOUNT_KEY,
  type ImportRow,
} from "@/lib/import-queue";

type TriggerScope = "specific" | "any" | "next";
type MatchMode = "specific" | "any";

interface LoadedCampaign {
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
  trackedLinks?: { destinationUrl: string; label?: string | null }[];
}

interface CampaignBuilderProps {
  mode: "new" | "edit";
  campaignId?: string;
}

function SectionCard({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card space-y-4 p-4 sm:p-5">
      <header className="flex items-center gap-3">
        <span className="icon-tile bg-brand-soft text-brand">
          <Icon size={20} aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-extrabold text-foreground">{title}</h2>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

function Radio({
  checked,
  onSelect,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={`flex min-h-[44px] w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left text-sm transition-colors ${
        checked
          ? "border-brand bg-brand-soft font-bold text-brand"
          : "border-border text-foreground hover:border-border-hover hover:bg-surface-hover"
      }`}
    >
      <span
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${
          checked ? "border-brand" : "border-border-hover"
        }`}
      >
        {checked && <span className="h-2.5 w-2.5 rounded-full bg-brand" />}
      </span>
      <span className="flex-1">{children}</span>
    </button>
  );
}

function Toggle({
  on,
  onToggle,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className="-m-2 inline-flex shrink-0 items-center p-2"
    >
      <span
        className={`relative h-7 w-12 rounded-full transition-colors ${
          on ? "bg-accent" : "bg-border-hover"
        }`}
      >
        <span
          className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${
            on ? "left-6" : "left-1"
          }`}
        />
      </span>
    </button>
  );
}

function ToggleRow({
  on,
  onToggle,
  children,
}: {
  on: boolean;
  onToggle: () => void;
  children: string;
}) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3 rounded-[10px] border border-border px-3 py-2">
      <span className="text-sm text-foreground">{children}</span>
      <Toggle on={on} onToggle={onToggle} label={children} />
    </div>
  );
}

function FieldError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1.5 text-xs text-error">
      {message}
    </p>
  );
}

export default function CampaignBuilder({ mode, campaignId }: CampaignBuilderProps) {
  const router = useRouter();

  const [loading, setLoading] = useState(mode === "edit");
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");

  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);

  const [triggerScope, setTriggerScope] = useState<TriggerScope>("specific");
  const [postId, setPostId] = useState<string | null>(null);
  const [postUrl, setPostUrl] = useState<string | null>(null);
  const [postThumb, setPostThumb] = useState<string | null>(null);
  const [postCaption, setPostCaption] = useState("");

  // Post IDs already tied to another automation on this account, so the picker
  // can flag them and the user knows not to double-assign. Maps postId ->
  // the campaign name using it (for the tooltip).
  const [usedPosts, setUsedPosts] = useState<Record<string, string>>({});

  const [matchMode, setMatchMode] = useState<MatchMode>("specific");
  const [keywordText, setKeywordText] = useState("");
  const [dmTriggerEnabled, setDmTriggerEnabled] = useState(false);

  const [publicReplyEnabled, setPublicReplyEnabled] = useState(false);
  const [publicReplyMessages, setPublicReplyMessages] = useState<string[]>([""]);

  const [openingDmEnabled, setOpeningDmEnabled] = useState(false);
  const [openingDmMessage, setOpeningDmMessage] = useState("");
  const [openingDmButtonLabel, setOpeningDmButtonLabel] = useState("");

  const [dmMessage, setDmMessage] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [trackedDestinationUrl, setTrackedDestinationUrl] = useState("");
  const [linkButtonLabel, setLinkButtonLabel] = useState("Abrir link");
  const [secondLinkOpen, setSecondLinkOpen] = useState(false);
  const [secondaryDestinationUrl, setSecondaryDestinationUrl] = useState("");
  const [secondaryButtonLabel, setSecondaryButtonLabel] = useState("Abrir link");
  const [requireFollow, setRequireFollow] = useState(false);
  const [followPromptMessage, setFollowPromptMessage] = useState("");
  const [followPromptButtonLabel, setFollowPromptButtonLabel] =
    useState("já estou seguindo");
  const [followUpEnabled, setFollowUpEnabled] = useState(false);
  const [followUpMessage, setFollowUpMessage] = useState("");
  const [followUpDelayMinutes, setFollowUpDelayMinutes] = useState(0);

  const [previewTab, setPreviewTab] = useState<PreviewTab>("dm");

  // CSV import queue. When present, each save advances to the next row instead
  // of returning to the campaigns list.
  const [importQueue, setImportQueue] = useState<ImportRow[] | null>(null);
  const [importTotal, setImportTotal] = useState(0);

  const keywords = useMemo(
    () =>
      keywordText
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    [keywordText]
  );

  // Fetch the connected account's real avatar for the preview (cache-first so
  // it shows instantly on a return visit instead of a blank circle).
  useEffect(() => {
    if (!selectedAccountId) return;
    let cancelled = false;
    const cacheKey = `ig-avatar:${selectedAccountId}`;
    const cached = readCache<string | null>(cacheKey, 30 * 60 * 1000);
    // Hydrating state from cache is a legitimate effect use here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cached.data !== null) setAvatarUrl(cached.data);

    const params = new URLSearchParams({ instagramAccountId: selectedAccountId });
    fetch(`/api/instagram/profile?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const url = d.success ? d.data.profilePictureUrl ?? null : null;
        setAvatarUrl(url);
        writeCache(cacheKey, url);
      })
      .catch(() => {
        if (!cancelled && cached.data === null) setAvatarUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAccountId]);

  // Load accounts (both modes need them for the preview username + selector).
  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.success) return;
        const next: AccountOption[] = payload.data.instagramAccounts ?? [];
        setAccounts(next);
        setSelectedAccountId(
          (prev) => prev || payload.data.selectedInstagramAccountId || next[0]?.id || ""
        );
      })
      .catch(() => setAccounts([]));
  }, []);

  // Prefill when editing.
  useEffect(() => {
    if (mode !== "edit" || !campaignId) return;
    fetch("/api/automations", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.success) return setNotFound(true);
        const c = (payload.data as LoadedCampaign[]).find((x) => x.id === campaignId);
        if (!c) return setNotFound(true);
        setName(c.name);
        setSelectedAccountId(c.instagramAccountId);
        setTriggerScope(
          c.matchAnyPost ? "any" : c.pendingNextReel ? "next" : "specific"
        );
        setPostId(c.postId);
        setPostUrl(c.postUrl);
        setMatchMode(c.matchAnyWord ? "any" : "specific");
        setKeywordText(c.keywords.join(", "));
        setDmTriggerEnabled(c.dmTriggerEnabled ?? false);
        setPublicReplyEnabled(c.publicReplyEnabled);
        setPublicReplyMessages(
          c.publicReplyMessages?.length
            ? c.publicReplyMessages
            : c.publicReplyMessage
              ? [c.publicReplyMessage]
              : [""]
        );
        setOpeningDmEnabled(c.openingDmEnabled);
        setOpeningDmMessage(c.openingDmMessage ?? "");
        setOpeningDmButtonLabel(c.openingDmButtonLabel ?? "");
        setDmMessage(c.dmMessage);
        setLinkButtonLabel(c.linkButtonLabel ?? "Abrir link");
        setIsActive(c.isActive);
        const link = c.trackedLinks?.[0]?.destinationUrl ?? "";
        setTrackedDestinationUrl(link);
        setLinkOpen(Boolean(link));
        const secondLink = c.trackedLinks?.[1];
        setSecondaryDestinationUrl(secondLink?.destinationUrl ?? "");
        setSecondaryButtonLabel(secondLink?.label ?? "Abrir link");
        setSecondLinkOpen(Boolean(secondLink?.destinationUrl));
        setRequireFollow(c.requireFollow ?? false);
        setFollowPromptMessage(c.followPromptMessage ?? "");
        setFollowPromptButtonLabel(
          c.followPromptButtonLabel ?? "já estou seguindo"
        );
        setFollowUpEnabled(c.followUpEnabled ?? false);
        setFollowUpMessage(c.followUpMessage ?? "");
        setFollowUpDelayMinutes(c.followUpDelayMinutes ?? 0);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [mode, campaignId]);

  // Track which posts on the selected account are already assigned to an
  // automation, so the picker can highlight them. The campaign being edited is
  // excluded — its own post should read as selected, not "taken".
  useEffect(() => {
    if (!selectedAccountId) return;
    let cancelled = false;
    fetch("/api/automations", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload) => {
        if (cancelled || !payload.success) return;
        const map: Record<string, string> = {};
        for (const a of payload.data as LoadedCampaign[]) {
          if (!a.postId) continue;
          if (a.instagramAccountId !== selectedAccountId) continue;
          if (mode === "edit" && a.id === campaignId) continue;
          map[a.postId] = a.name;
        }
        setUsedPosts(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedAccountId, mode, campaignId]);

  // Prefill the editable fields from one queued import row. The reel is left
  // unset so the user picks it per row.
  function prefillFromRow(row: ImportRow) {
    setName(row.name ?? "");
    setTriggerScope("specific");
    setPostId(null);
    setPostUrl(null);
    setPostThumb(null);
    setPostCaption("");
    setMatchMode("specific");
    setKeywordText((row.keywords ?? []).join(", "));
    setDmMessage(row.dmMessage ?? "");
    setPublicReplyEnabled(Boolean(row.publicReply));
    setPublicReplyMessages(row.publicReply ? [row.publicReply] : [""]);
    const hasOpening = Boolean(row.openingDmMessage);
    setOpeningDmEnabled(hasOpening);
    setOpeningDmMessage(row.openingDmMessage ?? "");
    setOpeningDmButtonLabel(
      row.openingDmButtonLabel || (hasOpening ? "Enviar link" : "")
    );
    const link = row.trackedUrl ?? "";
    setTrackedDestinationUrl(link);
    setLinkOpen(Boolean(link));
    setError(null);
  }

  // Pick up a staged CSV import (new mode only) and prefill the first row.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (mode !== "new") return;
    try {
      const raw = window.localStorage.getItem(IMPORT_QUEUE_KEY);
      const acct = window.localStorage.getItem(IMPORT_ACCOUNT_KEY);
      if (!raw) return;
      const queue = JSON.parse(raw) as ImportRow[];
      if (!Array.isArray(queue) || queue.length === 0) return;
      setImportQueue(queue);
      setImportTotal(queue.length);
      if (acct) setSelectedAccountId(acct);
      prefillFromRow(queue[0]);
    } catch {
      // ignore a malformed queue
    }
  }, [mode]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const username =
    accounts.find((a) => a.id === selectedAccountId)?.username ?? "yourbrand";

  function handlePostSelect(
    id: string,
    url?: string,
    thumb?: string,
    caption?: string
  ) {
    setPostId(id);
    setPostUrl(url ?? null);
    setPostThumb(thumb ?? null);
    setPostCaption(caption ?? "");
  }

  function ensureLinkToken() {
    setDmMessage((cur) => (cur.includes("{link}") ? cur : `${cur.trim()} {link}`.trim()));
  }

  async function handleSubmit(activeValue: boolean) {
    setError(null);

    if (!selectedAccountId) return setError("Conecte uma conta do Instagram primeiro.");
    if (triggerScope === "specific" && !postId)
      return setError("Escolha um post ou reel para acionar a campanha.");
    if (matchMode === "specific" && keywords.length === 0)
      return setError("Adicione pelo menos uma palavra-chave ou mude para qualquer palavra.");
    if (!dmMessage.trim()) return setError("Adicione a DM com o link.");
    if (openingDmEnabled && (!openingDmMessage.trim() || !openingDmButtonLabel.trim()))
      return setError("Sua DM de abertura precisa de uma mensagem e um texto de botão.");

    setSaving(true);

    const payload = {
      name: name.trim() || `Campanha de @${username}`,
      instagramAccountId: selectedAccountId,
      postId: triggerScope === "specific" ? postId : null,
      postUrl: triggerScope === "specific" ? postUrl : null,
      matchAnyPost: triggerScope === "any",
      pendingNextReel: triggerScope === "next",
      matchAnyWord: matchMode === "any",
      keywords: matchMode === "any" ? [] : keywords,
      dmTriggerEnabled,
      dmMessage,
      openingDmEnabled,
      openingDmMessage: openingDmEnabled ? openingDmMessage : null,
      openingDmButtonLabel: openingDmEnabled ? openingDmButtonLabel : null,
      publicReplyEnabled,
      publicReplyMessages: publicReplyEnabled
        ? publicReplyMessages.map((m) => m.trim()).filter(Boolean)
        : [],
      trackedDestinationUrl: trackedDestinationUrl.trim() || "",
      linkButtonLabel: linkButtonLabel.trim() || "Abrir link",
      secondaryDestinationUrl: secondaryDestinationUrl.trim() || "",
      secondaryButtonLabel: secondaryButtonLabel.trim() || "Abrir link",
      requireFollow,
      followPromptMessage: requireFollow ? followPromptMessage.trim() : "",
      followPromptButtonLabel: requireFollow
        ? followPromptButtonLabel.trim() || "já estou seguindo"
        : "",
      followUpEnabled,
      followUpMessage: followUpEnabled ? followUpMessage.trim() : "",
      followUpDelayMinutes: followUpEnabled ? followUpDelayMinutes : 0,
      isActive: activeValue,
    };

    try {
      const res =
        mode === "new"
          ? await fetch("/api/automations", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            })
          : await fetch(`/api/automations?id=${campaignId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
      const data = await res.json();
      if (data.success) {
        // The post we just assigned is now in use. Reflect it immediately so
        // the picker flags it on the next imported row — the fetch that builds
        // this map doesn't re-run while the builder stays mounted through the
        // import queue.
        if (triggerScope === "specific" && postId) {
          const assignedPostId = postId;
          setUsedPosts((prev) => ({ ...prev, [assignedPostId]: payload.name }));
        }
        // Importing: advance to the next queued row instead of leaving.
        if (importQueue && importQueue.length > 1) {
          const remaining = importQueue.slice(1);
          try {
            window.localStorage.setItem(
              IMPORT_QUEUE_KEY,
              JSON.stringify(remaining)
            );
          } catch {
            // ignore
          }
          setImportQueue(remaining);
          prefillFromRow(remaining[0]);
          setSaving(false);
          if (typeof window !== "undefined") window.scrollTo({ top: 0 });
          return;
        }
        if (importQueue) {
          try {
            window.localStorage.removeItem(IMPORT_QUEUE_KEY);
            window.localStorage.removeItem(IMPORT_ACCOUNT_KEY);
          } catch {
            // ignore
          }
        }
        // refresh() busts the router cache so the list reflects the save
        // instead of landing on a stale (empty) campaigns page.
        router.push("/campaigns");
        router.refresh();
      } else {
        // Surface the specific field that failed validation instead of a
        // generic "Invalid input".
        const fieldErrors = data.details?.fieldErrors as
          | Record<string, string[]>
          | undefined;
        const firstField = fieldErrors && Object.keys(fieldErrors)[0];
        setError(
          firstField
            ? `${firstField}: ${fieldErrors[firstField][0]}`
            : data.error ?? "Falha ao salvar a campanha"
        );
        if (typeof window !== "undefined")
          window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch {
      setError("Falha ao salvar a campanha");
    } finally {
      setSaving(false);
    }
  }

  // Skip the current imported row without saving a campaign for it, advancing
  // to the next one (or finishing the import if it was the last).
  function skipRow() {
    if (!importQueue) return;
    setError(null);
    if (importQueue.length > 1) {
      const remaining = importQueue.slice(1);
      try {
        window.localStorage.setItem(IMPORT_QUEUE_KEY, JSON.stringify(remaining));
      } catch {
        // ignore
      }
      setImportQueue(remaining);
      prefillFromRow(remaining[0]);
      if (typeof window !== "undefined") window.scrollTo({ top: 0 });
      return;
    }
    // Last row skipped — finish the import.
    try {
      window.localStorage.removeItem(IMPORT_QUEUE_KEY);
      window.localStorage.removeItem(IMPORT_ACCOUNT_KEY);
    } catch {
      // ignore
    }
    router.push("/campaigns");
    router.refresh();
  }

  // Map the single error string onto the field it belongs to so it can render
  // right below that field. Anything else (API errors) goes to the banner.
  const fieldErrors = {
    post: error === "Escolha um post ou reel para acionar a campanha." ? error : null,
    keywords:
      error === "Adicione pelo menos uma palavra-chave ou mude para qualquer palavra."
        ? error
        : null,
    dmMessage: error === "Adicione a DM com o link." ? error : null,
    openingDm:
      error === "Sua DM de abertura precisa de uma mensagem e um texto de botão."
        ? error
        : null,
  };
  const bannerError =
    error && !Object.values(fieldErrors).some(Boolean) ? error : null;

  if (loading) {
    return (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div className="skeleton h-14" />
          <div className="skeleton h-48 rounded-2xl" />
          <div className="skeleton h-64 rounded-2xl" />
          <div className="skeleton h-48 rounded-2xl" />
        </div>
        <div className="skeleton hidden h-[720px] rounded-2xl lg:block" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="card flex flex-col items-center gap-3 p-8 text-center">
        <span className="icon-tile bg-sun-soft text-warning">
          <SearchX size={22} aria-hidden />
        </span>
        <p className="text-sm font-bold text-foreground">Campanha não encontrada.</p>
        <button
          type="button"
          onClick={() => router.push("/campaigns")}
          className="btn btn-primary mt-1"
        >
          <ArrowLeft size={18} aria-hidden />
          Voltar para campanhas
        </button>
      </div>
    );
  }

  const fieldClass = "field";
  const textareaClass = "field resize-none";

  return (
    <div className="space-y-6 pb-24 lg:pb-6">
      {importQueue && (
        <div className="card flex items-start gap-3 border-accent/40 bg-accent-soft p-4 text-sm">
          <span className="icon-tile bg-surface text-accent">
            <FileSpreadsheet size={20} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="font-bold text-foreground">
              Importando {importTotal - importQueue.length + 1} de {importTotal}.
            </p>
            <p className="text-muted">
              Os campos foram preenchidos a partir do seu CSV. Escolha o reel, edite o que
              quiser e salve para carregar o próximo, ou clique em Pular se não quiser este.
            </p>
          </div>
        </div>
      )}

      {/* Page header */}
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {mode === "edit" ? (
          <>
            <h1 className="min-w-0 truncate text-lg font-extrabold text-brand">
              {name || "Campanha sem título"}
            </h1>
            <span className={`badge ${isActive ? "badge-success" : "badge-neutral"}`}>
              {isActive ? (
                <Play size={12} aria-hidden />
              ) : (
                <Pause size={12} aria-hidden />
              )}
              {isActive ? "ATIVA" : "PAUSADA"}
            </span>
          </>
        ) : (
          <h1 className="text-lg font-extrabold text-brand">Nova campanha</h1>
        )}
      </div>

      {bannerError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-[10px] border border-error/30 bg-error-soft p-3 text-sm text-error"
        >
          <AlertCircle size={18} aria-hidden className="mt-0.5 shrink-0" />
          <span>{bannerError}</span>
        </div>
      )}

      {/* min-w-0 on the cells: a grid item defaults to min-width:auto, so a
          long string widens the whole page instead of wrapping. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
        {/* Left: controls */}
        <div className="min-w-0 space-y-5 stagger">
          <SectionCard icon={Pencil} title="Identificação">
            <div>
              <label htmlFor="campaign-name" className="label">
                Nome da campanha{" "}
                <span className="font-normal text-muted">(opcional)</span>
              </label>
              <input
                id="campaign-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ex.: Flashcards de inglês"
                className={fieldClass}
                maxLength={100}
              />
            </div>
            {accounts.length > 1 && (
              <AccountSelect
                accounts={accounts}
                value={selectedAccountId}
                onChange={(id) => {
                  setSelectedAccountId(id);
                  setPostId(null);
                  setPostUrl(null);
                  setPostThumb(null);
                }}
                includeAll={false}
                label="Conta do Instagram"
              />
            )}
          </SectionCard>

          <SectionCard icon={Image} title="Quando alguém comentar em">
            <div role="radiogroup" aria-label="Post que aciona a campanha" className="space-y-2">
              <Radio
                checked={triggerScope === "specific"}
                onSelect={() => setTriggerScope("specific")}
              >
                um post ou reel específico
              </Radio>
              {triggerScope === "specific" && (
                <div>
                  <div className="rounded-[10px] border border-border p-2">
                    <PostPicker
                      selectedPostId={postId}
                      instagramAccountId={selectedAccountId}
                      usedPostIds={usedPosts}
                      onSelect={handlePostSelect}
                    />
                  </div>
                  <FieldError message={fieldErrors.post} />
                </div>
              )}
              <Radio
                checked={triggerScope === "any"}
                onSelect={() => setTriggerScope("any")}
              >
                qualquer post ou reel
              </Radio>
              <Radio
                checked={triggerScope === "next"}
                onSelect={() => setTriggerScope("next")}
              >
                o próximo post ou reel
              </Radio>
            </div>
          </SectionCard>

          <SectionCard icon={KeyRound} title="E esse comentário tiver">
            <div role="radiogroup" aria-label="Palavras que acionam a campanha" className="space-y-2">
              <Radio
                checked={matchMode === "specific"}
                onSelect={() => setMatchMode("specific")}
              >
                uma ou mais palavras específicas
              </Radio>
              {matchMode === "specific" && (
                <div>
                  <label htmlFor="campaign-keywords" className="label">
                    Palavras-chave
                  </label>
                  <input
                    id="campaign-keywords"
                    value={keywordText}
                    onChange={(e) => setKeywordText(e.target.value)}
                    placeholder="Digite uma ou mais palavras"
                    className={fieldClass}
                  />
                  <p className="helper">Use vírgulas para separar as palavras</p>
                  <FieldError message={fieldErrors.keywords} />
                </div>
              )}
              <Radio
                checked={matchMode === "any"}
                onSelect={() => setMatchMode("any")}
              >
                qualquer palavra
              </Radio>
            </div>
            <div>
              <ToggleRow
                on={dmTriggerEnabled}
                onToggle={() => setDmTriggerEnabled(!dmTriggerEnabled)}
              >
                {`também responder quando alguém mandar DM com ${
                  matchMode === "any" ? "qualquer coisa" : "essas palavras"
                }`}
              </ToggleRow>
              {dmTriggerEnabled && (
                <p className="helper">
                  {matchMode === "any"
                    ? "Toda DM para esta conta recebe a resposta abaixo. Use com cuidado."
                    : "Uma DM contendo qualquer uma dessas palavras recebe a mesma resposta, sem precisar comentar."}
                </p>
              )}
            </div>
          </SectionCard>

          <SectionCard icon={MessageCircle} title="Resposta pública no post">
            <ToggleRow
              on={publicReplyEnabled}
              onToggle={() => setPublicReplyEnabled(!publicReplyEnabled)}
            >
              responder aos comentários deles no post
            </ToggleRow>
            {publicReplyEnabled && (
              <div className="space-y-2">
                {publicReplyMessages.map((msg, i) => (
                  <div key={i}>
                    <label htmlFor={`public-reply-${i}`} className="label">
                      Resposta {i + 1}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id={`public-reply-${i}`}
                        value={msg}
                        onChange={(e) =>
                          setPublicReplyMessages((prev) =>
                            prev.map((m, idx) => (idx === i ? e.target.value : m))
                          )
                        }
                        placeholder="Te mandei uma DM! 📩"
                        maxLength={1000}
                        className={fieldClass}
                      />
                      {publicReplyMessages.length > 1 && (
                        <button
                          type="button"
                          onClick={() =>
                            setPublicReplyMessages((prev) =>
                              prev.filter((_, idx) => idx !== i)
                            )
                          }
                          className="btn btn-ghost btn-sm shrink-0 px-2 hover:text-error"
                          aria-label="Remover resposta"
                        >
                          <X size={18} aria-hidden />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {publicReplyMessages.length < 10 && (
                  <button
                    type="button"
                    onClick={() =>
                      setPublicReplyMessages((prev) => [...prev, ""])
                    }
                    className="btn btn-secondary w-full"
                  >
                    <Plus size={18} aria-hidden />
                    Adicionar outra resposta
                  </button>
                )}
                <p className="helper">
                  Uma é escolhida aleatoriamente a cada vez, para as respostas não
                  ficarem idênticas.
                </p>
              </div>
            )}
          </SectionCard>

          <SectionCard icon={Send} title="A pessoa vai receber">
            <div>
              <ToggleRow
                on={openingDmEnabled}
                onToggle={() => setOpeningDmEnabled(!openingDmEnabled)}
              >
                uma DM de abertura
              </ToggleRow>
              {openingDmEnabled && (
                <div className="mt-3 space-y-3">
                  <div>
                    <label htmlFor="opening-dm-message" className="label">
                      Mensagem de abertura
                    </label>
                    <textarea
                      id="opening-dm-message"
                      value={openingDmMessage}
                      onChange={(e) => setOpeningDmMessage(e.target.value)}
                      placeholder="Oi! Que bom ter você aqui 😊"
                      rows={3}
                      className={textareaClass}
                      maxLength={1000}
                    />
                  </div>
                  <div>
                    <label htmlFor="opening-dm-button" className="label">
                      Texto do botão
                    </label>
                    <input
                      id="opening-dm-button"
                      value={openingDmButtonLabel}
                      onChange={(e) => setOpeningDmButtonLabel(e.target.value)}
                      placeholder="Me manda o link"
                      className={fieldClass}
                      maxLength={64}
                    />
                    <FieldError message={fieldErrors.openingDm} />
                  </div>
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard icon={UserPlus} title="Pedido para seguir">
            <div>
              <ToggleRow
                on={requireFollow}
                onToggle={() => setRequireFollow(!requireFollow)}
              >
                um pedido para seguir antes
              </ToggleRow>
              {requireFollow && (
                <div className="mt-3 space-y-3">
                  <div>
                    <label htmlFor="follow-prompt-message" className="label">
                      Mensagem do pedido
                    </label>
                    <textarea
                      id="follow-prompt-message"
                      value={followPromptMessage}
                      onChange={(e) => setFollowPromptMessage(e.target.value)}
                      placeholder="um favor rápido antes de eu enviar seu link. não ganho nada com isso, é de graça. se quiser me apoiar, só não deixe de me seguir depois. toque no botão quando estiver seguindo e eu te envio"
                      rows={3}
                      className={textareaClass}
                      maxLength={1000}
                    />
                  </div>
                  <div>
                    <label htmlFor="follow-prompt-button" className="label">
                      Texto do botão
                    </label>
                    <input
                      id="follow-prompt-button"
                      value={followPromptButtonLabel}
                      onChange={(e) => setFollowPromptButtonLabel(e.target.value)}
                      placeholder="já estou seguindo"
                      className={fieldClass}
                      maxLength={20}
                    />
                    <p className="helper">
                      Enviamos o link só depois que a pessoa toca no botão e o Instagram
                      confirma que ela segue você. Se não der para verificar, enviamos
                      mesmo assim.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard icon={Link2} title="E depois, vai receber">
            <div>
              <label htmlFor="dm-message" className="label">
                uma DM com um link
              </label>
              <textarea
                id="dm-message"
                value={dmMessage}
                onChange={(e) => setDmMessage(e.target.value)}
                placeholder="Escreva uma mensagem"
                rows={3}
                className={textareaClass}
                maxLength={1000}
              />
              <FieldError message={fieldErrors.dmMessage} />
            </div>
            {linkOpen ? (
              <div className="space-y-3">
                <div>
                  <label htmlFor="tracked-url" className="label">
                    Link de destino
                  </label>
                  <input
                    id="tracked-url"
                    value={trackedDestinationUrl}
                    onChange={(e) => setTrackedDestinationUrl(e.target.value)}
                    onBlur={ensureLinkToken}
                    placeholder="https://seulink.com/oferta"
                    className={fieldClass}
                  />
                </div>
                <div>
                  <label htmlFor="link-button-label" className="label">
                    Texto do botão
                  </label>
                  <input
                    id="link-button-label"
                    value={linkButtonLabel}
                    onChange={(e) => setLinkButtonLabel(e.target.value)}
                    placeholder="Texto do botão (ex.: Abrir link)"
                    maxLength={20}
                    className={fieldClass}
                  />
                </div>
                {secondLinkOpen ? (
                  <div className="space-y-3 border-t border-border pt-3">
                    <div>
                      <label htmlFor="secondary-url" className="label">
                        Segundo link
                      </label>
                      <input
                        id="secondary-url"
                        value={secondaryDestinationUrl}
                        onChange={(e) => setSecondaryDestinationUrl(e.target.value)}
                        placeholder="https://seulink.com/segundo"
                        className={fieldClass}
                      />
                    </div>
                    <div>
                      <label htmlFor="secondary-button-label" className="label">
                        Texto do segundo botão
                      </label>
                      <input
                        id="secondary-button-label"
                        value={secondaryButtonLabel}
                        onChange={(e) => setSecondaryButtonLabel(e.target.value)}
                        placeholder="Texto do segundo botão"
                        maxLength={20}
                        className={fieldClass}
                      />
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSecondLinkOpen(true)}
                    className="btn btn-secondary w-full"
                  >
                    <Plus size={18} aria-hidden />
                    Adicionar um segundo link
                  </button>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setLinkOpen(true)}
                className="btn btn-secondary w-full"
              >
                <Plus size={18} aria-hidden />
                Adicionar um link
              </button>
            )}
            <p className="helper">
              {"{link}"} insere o link rastreado; {"{username}"} personaliza.
            </p>
          </SectionCard>

          <SectionCard icon={MessageSquareHeart} title="Agradecimento">
            <div>
              <ToggleRow
                on={followUpEnabled}
                onToggle={() => setFollowUpEnabled(!followUpEnabled)}
              >
                uma mensagem de agradecimento depois
              </ToggleRow>
              {followUpEnabled && (
                <div className="mt-3 space-y-3">
                  <div>
                    <label htmlFor="follow-up-message" className="label">
                      Mensagem de agradecimento
                    </label>
                    <textarea
                      id="follow-up-message"
                      value={followUpMessage}
                      onChange={(e) => setFollowUpMessage(e.target.value)}
                      placeholder="Aliás, só queria agradecer por me seguir, valeu pelo apoio 🙌"
                      rows={3}
                      className={textareaClass}
                      maxLength={1000}
                    />
                  </div>
                  <div>
                    <label htmlFor="follow-up-delay" className="label">
                      Enviar minutos depois do link
                    </label>
                    <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                      <span className="text-xs text-muted">Enviar</span>
                      <input
                        id="follow-up-delay"
                        type="number"
                        min={0}
                        max={1440}
                        value={followUpDelayMinutes}
                        onChange={(e) =>
                          setFollowUpDelayMinutes(
                            Math.max(0, Math.min(1440, Math.floor(Number(e.target.value) || 0)))
                          )
                        }
                        className="field w-24"
                      />
                      <span className="text-xs text-muted">
                        minutos depois do link
                      </span>
                    </div>
                    <p className="helper">
                      {followUpDelayMinutes > 0
                        ? `Enviada ${followUpDelayMinutes} min depois que a pessoa toca no link.`
                        : "Enviada logo depois que a pessoa toca no link."}
                      {" {username}"} personaliza. Máximo de 24 horas, para ficar dentro
                      da janela de mensagens do Instagram.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </SectionCard>
        </div>

        {/* Right: preview */}
        <div className="min-w-0">
          <div className="lg:sticky lg:top-6">
            <CampaignPreview
              tab={previewTab}
              onTabChange={setPreviewTab}
              username={username}
              avatarUrl={avatarUrl}
              postThumb={postThumb}
              caption={postCaption}
              sampleComment={keywords[0] ?? ""}
              dmTriggerEnabled={dmTriggerEnabled}
              publicReplyEnabled={publicReplyEnabled}
              publicReplyMessage={publicReplyMessages.find((m) => m.trim()) ?? ""}
              openingDmEnabled={openingDmEnabled}
              openingDmMessage={openingDmMessage}
              openingDmButtonLabel={openingDmButtonLabel}
              revealMessage={dmMessage}
              hasLink={Boolean(trackedDestinationUrl.trim())}
              linkButtonLabel={linkButtonLabel || "Abrir link"}
              linkUrl={trackedDestinationUrl.trim() || undefined}
              hasSecondLink={
                secondLinkOpen && Boolean(secondaryDestinationUrl.trim())
              }
              secondLinkButtonLabel={secondaryButtonLabel || "Abrir link"}
              requireFollow={requireFollow}
              followPromptMessage={followPromptMessage}
              followPromptButtonLabel={followPromptButtonLabel || "já estou seguindo"}
              followUpEnabled={followUpEnabled}
              followUpMessage={followUpMessage}
              followUpDelayMinutes={followUpDelayMinutes}
            />
          </div>
        </div>
      </div>

      {/* Action bar: sticky at the bottom on mobile, inline card on desktop */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 p-3 backdrop-blur lg:static lg:rounded-2xl lg:border lg:border-border lg:bg-surface lg:p-4 lg:shadow-[var(--shadow-card)]">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-end gap-2">
          {importQueue && (
            <button
              type="button"
              onClick={skipRow}
              disabled={saving}
              className="btn btn-secondary"
            >
              <SkipForward size={18} aria-hidden />
              {importQueue.length > 1 ? "Pular" : "Pular e finalizar"}
            </button>
          )}
          {mode === "edit" &&
            (isActive ? (
              <button
                type="button"
                onClick={() => handleSubmit(false)}
                disabled={saving}
                className="btn btn-secondary"
              >
                <Pause size={18} aria-hidden />
                Pausar
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleSubmit(true)}
                disabled={saving}
                className="btn btn-secondary"
              >
                <Play size={18} aria-hidden />
                Ativar
              </button>
            ))}
          <button
            type="button"
            onClick={() => handleSubmit(mode === "new" ? true : isActive)}
            disabled={saving}
            className="btn btn-primary flex-1 sm:flex-none"
          >
            {mode === "new" ? (
              <Play size={18} aria-hidden />
            ) : (
              <Check size={18} aria-hidden />
            )}
            {saving ? "Salvando…" : mode === "new" ? "Ativar" : "Salvar alterações"}
          </button>
        </div>
      </div>
    </div>
  );
}
