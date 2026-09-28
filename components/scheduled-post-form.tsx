"use client";

/**
 * New Scheduled Post form
 *
 * Account, type, file(s), caption, local date/time, "show on feed". Files
 * stream straight from the browser to the VM's disk (`POST
 * /api/scheduled-posts/upload`, session-authenticated) — then the row is
 * created with `POST /api/scheduled-posts`.
 *
 * Fase 4: TikTok and YouTube Shorts join Instagram as destination
 * checkboxes. One shared upload (same files, same date/time) fans out into
 * one `POST /api/scheduled-posts` per checked destination — see
 * docs/2026-09-27-agendados-comentarios.md, "Fase 4".
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clapperboard,
  ImagePlus,
  Camera,
  Layers,
  Loader2,
  Music2,
  UploadCloud,
  SquarePlay,
} from "lucide-react";
import type { AccountOption } from "@/components/account-select";
import { saoPauloToUtcIso } from "@/lib/scheduled-posts/timezone";
// Type-only import: erased at build time, so it never pulls
// lib/zernio/client.ts's runtime code (and its server-only-adjacent
// dependencies) into this client bundle.
import type { TikTokCreatorInfo } from "@/lib/zernio/client";

type MediaType = "REELS" | "IMAGE" | "CAROUSEL";
type Platform = "INSTAGRAM" | "TIKTOK" | "YOUTUBE";

// Mirrors lib/scheduled-posts/schema.ts's TIKTOK_PRIVACY_LEVELS/
// YOUTUBE_VISIBILITIES/MAX_YOUTUBE_TITLE_LENGTH — duplicated here (rather
// than imported) because that module also pulls in lib/scheduled-posts/
// paths.ts, which uses node:crypto and cannot be bundled client-side.
const TIKTOK_PRIVACY_LEVELS: { value: string; label: string }[] = [
  { value: "PUBLIC_TO_EVERYONE", label: "Público (todos)" },
  { value: "MUTUAL_FOLLOW_FRIENDS", label: "Amigos (seguem um ao outro)" },
  { value: "FOLLOWER_OF_CREATOR", label: "Seguidores" },
  { value: "SELF_ONLY", label: "Só eu" },
];
const YOUTUBE_VISIBILITIES: { value: string; label: string }[] = [
  { value: "public", label: "Público" },
  { value: "unlisted", label: "Não listado" },
  { value: "private", label: "Privado" },
];
const MAX_YOUTUBE_TITLE_LENGTH = 100;

// Only video/mp4 and image/jpeg are ever accepted server-side — the
// Content Publishing API does not take PNG for images at all, so it is left
// out of `accept` (and rejected again, with a clear message, in validate()).
const MEDIA_TYPE_OPTIONS: { value: MediaType; label: string; icon: typeof Clapperboard; accept: string; hint: string }[] = [
  { value: "REELS", label: "Reels", icon: Clapperboard, accept: "video/mp4", hint: "1 vídeo (.mp4)" },
  { value: "IMAGE", label: "Imagem", icon: ImagePlus, accept: "image/jpeg", hint: "1 imagem (.jpg) — o Instagram não aceita PNG" },
  { value: "CAROUSEL", label: "Carrossel", icon: Layers, accept: "image/jpeg,video/mp4", hint: "2 a 10 arquivos (.jpg/.mp4)" },
];

function isPng(file: File): boolean {
  return file.type === "image/png" || /\.png$/i.test(file.name);
}

function firstCaptionLine(caption: string): string {
  return caption.split("\n")[0]?.trim().slice(0, MAX_YOUTUBE_TITLE_LENGTH) ?? "";
}

async function uploadFile(file: File): Promise<{ path: string; url: string }> {
  const res = await fetch("/api/scheduled-posts/upload", {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    throw new Error(json?.error ?? `Falha ao enviar ${file.name}`);
  }
  return { path: json.data.path, url: json.data.url };
}

export default function ScheduledPostForm() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [instagramAccountId, setInstagramAccountId] = useState("");
  const [mediaType, setMediaType] = useState<MediaType>("REELS");
  const [files, setFiles] = useState<File[]>([]);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("12:00");
  const [shareToFeed, setShareToFeed] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partialSuccess, setPartialSuccess] = useState<string[]>([]);

  // Fase 4: destination checkboxes. TikTok/YouTube start disabled until
  // /api/scheduled-posts/destinations confirms the env is configured for
  // them — never assumed available.
  const [destinations, setDestinations] = useState<Record<Platform, boolean>>({
    INSTAGRAM: true,
    TIKTOK: false,
    YOUTUBE: false,
  });
  const [enabledDestinations, setEnabledDestinations] = useState({ tiktok: false, youtube: false });

  const [tiktokPrivacy, setTiktokPrivacy] = useState(""); // no default, on purpose
  // Rodada 5, achado 5: TikTok forbids a default value on these — they start
  // UNCHECKED, the operator must explicitly turn each one on.
  const [tiktokAllowComment, setTiktokAllowComment] = useState(false);
  const [tiktokAllowDuet, setTiktokAllowDuet] = useState(false);
  const [tiktokAllowStitch, setTiktokAllowStitch] = useState(false);
  const [tiktokConsent, setTiktokConsent] = useState(false);
  // Rodada 5, achado 5: whatever the creator already turned off in the
  // TikTok app itself (GET /accounts/{id}/tiktok/creator-info) — `null`
  // means "couldn't fetch it, offer all three normally".
  const [tiktokCreatorInfo, setTiktokCreatorInfo] = useState<TikTokCreatorInfo | null>(null);

  const [youtubeTitle, setYoutubeTitle] = useState("");
  const [youtubeTitleTouched, setYoutubeTitleTouched] = useState(false);
  const [youtubeVisibility, setYoutubeVisibility] = useState("public");
  const [youtubeMadeForKids, setYoutubeMadeForKids] = useState<"" | "sim" | "nao">(""); // no default, on purpose

  useEffect(() => {
    fetch("/api/instagram/accounts")
      .then((r) => r.json())
      .then((res) => {
        if (res.success) {
          setAccounts(res.data.instagramAccounts);
          setInstagramAccountId((prev) => prev || res.data.selectedInstagramAccountId || "");
        }
      });
    fetch("/api/scheduled-posts/destinations")
      .then((r) => r.json())
      .then((res) => {
        if (res.success) setEnabledDestinations(res.data);
      });
    fetch("/api/scheduled-posts/tiktok-creator-info")
      .then((r) => r.json())
      .then((res) => {
        if (res.success && res.data) setTiktokCreatorInfo(res.data);
      });
  }, []);

  // Rodada 5, achado 5: force back to false (never silently re-enable) any
  // toggle the creator already turned off in the TikTok app — an
  // `enabled: false` there means Zernio/TikTok would reject a `true` anyway.
  useEffect(() => {
    if (!tiktokCreatorInfo) return;
    const s = tiktokCreatorInfo.postingLimits.interactionSettings;
    if (s.allow_comment.enabled === false) setTiktokAllowComment(false);
    if (s.allow_duet.enabled === false) setTiktokAllowDuet(false);
    if (s.allow_stitch.enabled === false) setTiktokAllowStitch(false);
  }, [tiktokCreatorInfo]);

  const tiktokCommentLocked = tiktokCreatorInfo?.postingLimits.interactionSettings.allow_comment.enabled === false;
  const tiktokDuetLocked = tiktokCreatorInfo?.postingLimits.interactionSettings.allow_duet.enabled === false;
  const tiktokStitchLocked = tiktokCreatorInfo?.postingLimits.interactionSettings.allow_stitch.enabled === false;

  // A TikTok/YouTube-only video and the shared upload with Instagram must be
  // the very same file set — REELS is the only mediaType either accepts, so
  // checking either one locks the type picker to REELS.
  const needsVideoOnly = destinations.TIKTOK || destinations.YOUTUBE;

  const selectedOption = MEDIA_TYPE_OPTIONS.find((o) => o.value === mediaType)!;
  const hashtagCount = (caption.match(/#[^\s#]+/g) ?? []).length;
  const effectiveYoutubeTitle = youtubeTitleTouched ? youtubeTitle : firstCaptionLine(caption);
  const anyDestinationSelected = destinations.INSTAGRAM || destinations.TIKTOK || destinations.YOUTUBE;

  function handleMediaTypeChange(next: MediaType) {
    if (needsVideoOnly && next !== "REELS") return;
    setMediaType(next);
    setFiles([]);
    setCoverFile(null);
  }

  function toggleDestination(platform: Platform, checked: boolean) {
    setDestinations((prev) => {
      const next = { ...prev, [platform]: checked };
      return next;
    });
    if ((platform === "TIKTOK" || platform === "YOUTUBE") && checked && mediaType !== "REELS") {
      setMediaType("REELS");
      setFiles([]);
      setCoverFile(null);
    }
  }

  function validate(): string | null {
    if (!instagramAccountId) return "Escolha uma conta (mesmo publicando só no TikTok/YouTube, ela decide o workspace)";
    if (!anyDestinationSelected) return "Marque pelo menos um destino";
    if (mediaType === "CAROUSEL") {
      if (files.length < 2 || files.length > 10) return "Carrossel precisa de 2 a 10 arquivos";
    } else if (files.length !== 1) {
      return "Escolha 1 arquivo";
    }
    const pngFile = [...files, ...(coverFile ? [coverFile] : [])].find(isPng);
    if (pngFile) {
      return `"${pngFile.name}" é PNG — o Instagram (Content Publishing API) só aceita JPEG para imagens`;
    }
    if (needsVideoOnly && mediaType !== "REELS") return "TikTok e YouTube Shorts só aceitam vídeo";
    if (!date || !time) return "Escolha a data e a hora";
    if (!caption.trim()) return "Escreva a legenda";
    if (caption.length > 2200) return "Legenda acima de 2.200 caracteres";
    if (hashtagCount > 30) return "No máximo 30 hashtags";
    const scheduledFor = saoPauloToUtcIso(date, time);
    if (new Date(scheduledFor).getTime() < Date.now() - 5 * 60_000) {
      return "Escolha uma data/hora que não esteja mais de 5 minutos no passado";
    }
    if (destinations.TIKTOK) {
      if (!tiktokPrivacy) return "TikTok: escolha a privacidade";
      if (!tiktokConsent) return 'TikTok: confirme "revisei o conteúdo e concordo com a Music Usage Confirmation"';
    }
    if (destinations.YOUTUBE) {
      if (!effectiveYoutubeTitle.trim()) return "YouTube: escreva o título";
      if (effectiveYoutubeTitle.length > MAX_YOUTUBE_TITLE_LENGTH) return `YouTube: título acima de ${MAX_YOUTUBE_TITLE_LENGTH} caracteres`;
      if (youtubeMadeForKids === "") return '​YouTube: responda "Feito para crianças?"';
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError(null);
    setPartialSuccess([]);

    try {
      const storagePaths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        setProgress(`Enviando arquivo ${i + 1} de ${files.length}...`);
        const uploaded = await uploadFile(files[i]);
        storagePaths.push(uploaded.path);
      }

      let coverPath: string | undefined;
      if (coverFile && destinations.INSTAGRAM) {
        setProgress("Enviando capa...");
        const uploaded = await uploadFile(coverFile);
        coverPath = uploaded.path;
      }

      const scheduledFor = saoPauloToUtcIso(date, time);
      const platformsToSubmit = (["INSTAGRAM", "TIKTOK", "YOUTUBE"] as const).filter((p) => destinations[p]);

      const succeeded: string[] = [];
      const failed: string[] = [];
      for (const platform of platformsToSubmit) {
        setProgress(`Agendando (${platform === "INSTAGRAM" ? "Instagram" : platform === "TIKTOK" ? "TikTok" : "YouTube Shorts"})...`);
        const res = await fetch("/api/scheduled-posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instagramAccountId,
            platform,
            mediaType,
            storagePaths,
            ...(platform === "INSTAGRAM" ? { coverPath } : {}),
            caption,
            shareToFeed,
            scheduledFor,
            ...(platform === "TIKTOK"
              ? {
                  tiktokSettings: {
                    privacyLevel: tiktokPrivacy,
                    allowComment: tiktokAllowComment,
                    allowDuet: tiktokAllowDuet,
                    allowStitch: tiktokAllowStitch,
                    consentGiven: tiktokConsent,
                  },
                }
              : {}),
            ...(platform === "YOUTUBE"
              ? {
                  youtubeSettings: {
                    title: effectiveYoutubeTitle,
                    visibility: youtubeVisibility,
                    madeForKids: youtubeMadeForKids === "sim",
                  },
                }
              : {}),
          }),
        });
        const json = await res.json();
        const label = platform === "INSTAGRAM" ? "Instagram" : platform === "TIKTOK" ? "TikTok" : "YouTube Shorts";
        if (!res.ok || !json.success) {
          failed.push(`${label}: ${json.error ?? "falha ao agendar"}`);
        } else {
          succeeded.push(label);
        }
      }

      if (failed.length === 0) {
        router.push("/agendados");
        return;
      }

      setPartialSuccess(succeeded);
      setError(
        succeeded.length > 0
          ? `Agendado em ${succeeded.join(", ")}. Falhou: ${failed.join("; ")}`
          : `Falhou: ${failed.join("; ")}`
      );
      setSubmitting(false);
      setProgress(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao agendar o post");
      setSubmitting(false);
      setProgress(null);
    }
  }

  return (
    <div className="max-w-2xl space-y-6 stagger">
      <button
        type="button"
        onClick={() => router.push("/agendados")}
        className="btn btn-ghost btn-sm"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        Voltar
      </button>

      <div className="flex items-center gap-3">
        <span className="icon-tile bg-brand-soft text-brand" aria-hidden="true">
          <CalendarClock size={20} />
        </span>
        <h1 className="text-2xl font-extrabold text-brand">Novo post agendado</h1>
      </div>

      <form onSubmit={handleSubmit} className="card space-y-5 p-5 sm:p-6">
        <div>
          <label htmlFor="account" className="label">
            Conta
          </label>
          <select
            id="account"
            value={instagramAccountId}
            onChange={(e) => setInstagramAccountId(e.target.value)}
            className="field"
          >
            <option value="" disabled>
              Escolha a conta
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.username}
              </option>
            ))}
          </select>
        </div>

        <div>
          <span className="label mb-2 block">Destinos</span>
          <div className="grid grid-cols-3 gap-2">
            <label
              className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-[10px] border px-3 py-3 text-sm font-semibold transition-colors ${
                destinations.INSTAGRAM ? "border-brand bg-brand-soft text-brand" : "border-border text-muted hover:bg-surface-hover"
              }`}
            >
              <input
                type="checkbox"
                checked={destinations.INSTAGRAM}
                onChange={(e) => toggleDestination("INSTAGRAM", e.target.checked)}
                className="sr-only"
              />
              <Camera size={20} aria-hidden="true" />
              Instagram
            </label>
            <label
              className={`flex flex-col items-center gap-1.5 rounded-[10px] border px-3 py-3 text-sm font-semibold transition-colors ${
                !enabledDestinations.tiktok
                  ? "cursor-not-allowed border-border text-muted opacity-50"
                  : destinations.TIKTOK
                    ? "cursor-pointer border-brand bg-brand-soft text-brand"
                    : "cursor-pointer border-border text-muted hover:bg-surface-hover"
              }`}
            >
              <input
                type="checkbox"
                checked={destinations.TIKTOK}
                disabled={!enabledDestinations.tiktok}
                onChange={(e) => toggleDestination("TIKTOK", e.target.checked)}
                className="sr-only"
              />
              <Music2 size={20} aria-hidden="true" />
              TikTok
            </label>
            <label
              className={`flex flex-col items-center gap-1.5 rounded-[10px] border px-3 py-3 text-sm font-semibold transition-colors ${
                !enabledDestinations.youtube
                  ? "cursor-not-allowed border-border text-muted opacity-50"
                  : destinations.YOUTUBE
                    ? "cursor-pointer border-brand bg-brand-soft text-brand"
                    : "cursor-pointer border-border text-muted hover:bg-surface-hover"
              }`}
            >
              <input
                type="checkbox"
                checked={destinations.YOUTUBE}
                disabled={!enabledDestinations.youtube}
                onChange={(e) => toggleDestination("YOUTUBE", e.target.checked)}
                className="sr-only"
              />
              <SquarePlay size={20} aria-hidden="true" />
              YouTube Shorts
            </label>
          </div>
          {needsVideoOnly && (
            <p className="helper mt-2">TikTok e YouTube Shorts só aceitam vídeo — o tipo de post ficou travado em Reels.</p>
          )}
        </div>

        <div>
          <span className="label mb-2 block">Tipo de post</span>
          <div className="grid grid-cols-3 gap-2">
            {MEDIA_TYPE_OPTIONS.map((option) => {
              const Icon = option.icon;
              const active = option.value === mediaType;
              const disabled = needsVideoOnly && option.value !== "REELS";
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => handleMediaTypeChange(option.value)}
                  className={`flex flex-col items-center gap-1.5 rounded-[10px] border px-3 py-3 text-sm font-semibold transition-colors ${
                    disabled
                      ? "cursor-not-allowed border-border text-muted opacity-50"
                      : active
                        ? "border-brand bg-brand-soft text-brand"
                        : "border-border text-muted hover:bg-surface-hover"
                  }`}
                >
                  <Icon size={20} aria-hidden="true" />
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label htmlFor="files" className="label">
            Arquivo{mediaType === "CAROUSEL" ? "s" : ""}
          </label>
          <label
            htmlFor="files"
            className="field flex cursor-pointer items-center gap-2 text-muted"
          >
            <UploadCloud size={18} aria-hidden="true" />
            {files.length === 0
              ? selectedOption.hint
              : files.map((f) => f.name).join(", ")}
          </label>
          <input
            id="files"
            type="file"
            multiple={mediaType === "CAROUSEL"}
            accept={selectedOption.accept}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="sr-only"
          />
        </div>

        {mediaType === "REELS" && destinations.INSTAGRAM && (
          <div>
            <label htmlFor="cover" className="label">
              Capa (opcional, só Instagram)
            </label>
            <label
              htmlFor="cover"
              className="field flex cursor-pointer items-center gap-2 text-muted"
            >
              <ImagePlus size={18} aria-hidden="true" />
              {coverFile ? coverFile.name : "Sem capa: o Instagram escolhe um quadro"}
            </label>
            <input
              id="cover"
              type="file"
              accept="image/jpeg"
              onChange={(e) => setCoverFile(e.target.files?.[0] ?? null)}
              className="sr-only"
            />
          </div>
        )}

        <div>
          <label htmlFor="caption" className="label">
            Legenda
          </label>
          <textarea
            id="caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={5}
            className="field resize-none"
            placeholder="Escreva a legenda..."
          />
          <p className="helper">
            {caption.length}/2.200 caracteres · {hashtagCount}/30 hashtags
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="date" className="label">
              Data
            </label>
            <input
              id="date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="field"
            />
          </div>
          <div>
            <label htmlFor="time" className="label">
              Hora (horário de Brasília)
            </label>
            <input
              id="time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="field"
            />
          </div>
        </div>

        {destinations.INSTAGRAM && (
          <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <input
              type="checkbox"
              checked={shareToFeed}
              onChange={(e) => setShareToFeed(e.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            Instagram: mostrar também no feed
          </label>
        )}

        {destinations.TIKTOK && (
          <div className="space-y-3 rounded-[10px] border border-border p-4">
            <p className="flex items-center gap-2 text-sm font-bold text-foreground">
              <Music2 size={16} aria-hidden="true" />
              TikTok
            </p>
            <div>
              <label htmlFor="tiktok-privacy" className="label">
                Privacidade
              </label>
              <select
                id="tiktok-privacy"
                value={tiktokPrivacy}
                onChange={(e) => setTiktokPrivacy(e.target.value)}
                className="field"
              >
                <option value="" disabled>
                  Escolha a privacidade
                </option>
                {TIKTOK_PRIVACY_LEVELS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {tiktokPrivacy && tiktokPrivacy !== "PUBLIC_TO_EVERYONE" && (
                <p className="helper mt-1 flex items-center gap-1 text-warning">
                  <AlertCircle size={12} aria-hidden="true" />
                  Uma conta Business do TikTok só publica com privacidade Pública — outra opção pode falhar.
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-4">
              <label className={`flex items-center gap-2 text-sm font-semibold ${tiktokCommentLocked ? "text-muted" : "text-foreground"}`}>
                <input
                  type="checkbox"
                  checked={tiktokAllowComment}
                  disabled={tiktokCommentLocked}
                  onChange={(e) => setTiktokAllowComment(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                Permitir comentários
              </label>
              <label className={`flex items-center gap-2 text-sm font-semibold ${tiktokDuetLocked ? "text-muted" : "text-foreground"}`}>
                <input
                  type="checkbox"
                  checked={tiktokAllowDuet}
                  disabled={tiktokDuetLocked}
                  onChange={(e) => setTiktokAllowDuet(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                Permitir dueto
              </label>
              <label className={`flex items-center gap-2 text-sm font-semibold ${tiktokStitchLocked ? "text-muted" : "text-foreground"}`}>
                <input
                  type="checkbox"
                  checked={tiktokAllowStitch}
                  disabled={tiktokStitchLocked}
                  onChange={(e) => setTiktokAllowStitch(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                Permitir costura
              </label>
            </div>
            {(tiktokCommentLocked || tiktokDuetLocked || tiktokStitchLocked) && (
              <p className="helper flex items-center gap-1 text-warning">
                <AlertCircle size={12} aria-hidden="true" />
                Desabilitado(s) porque a conta já desligou isso no app do TikTok.
              </p>
            )}
            <label className="flex items-start gap-2 text-sm font-semibold text-foreground">
              <input
                type="checkbox"
                checked={tiktokConsent}
                onChange={(e) => setTiktokConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-border"
              />
              Confirmo que revisei o conteúdo e concordo com a Music Usage Confirmation do TikTok
            </label>
          </div>
        )}

        {destinations.YOUTUBE && (
          <div className="space-y-3 rounded-[10px] border border-border p-4">
            <p className="flex items-center gap-2 text-sm font-bold text-foreground">
              <SquarePlay size={16} aria-hidden="true" />
              YouTube Shorts
            </p>
            <div>
              <label htmlFor="youtube-title" className="label">
                Título
              </label>
              <input
                id="youtube-title"
                type="text"
                value={effectiveYoutubeTitle}
                onChange={(e) => {
                  setYoutubeTitleTouched(true);
                  setYoutubeTitle(e.target.value);
                }}
                maxLength={MAX_YOUTUBE_TITLE_LENGTH}
                className="field"
                placeholder="1ª linha da legenda por padrão"
              />
              <p className="helper">{effectiveYoutubeTitle.length}/{MAX_YOUTUBE_TITLE_LENGTH} caracteres</p>
            </div>
            <div>
              <label htmlFor="youtube-visibility" className="label">
                Visibilidade
              </label>
              <select
                id="youtube-visibility"
                value={youtubeVisibility}
                onChange={(e) => setYoutubeVisibility(e.target.value)}
                className="field"
              >
                {YOUTUBE_VISIBILITIES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span className="label mb-2 block">Feito para crianças?</span>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <input
                    type="radio"
                    name="youtube-made-for-kids"
                    checked={youtubeMadeForKids === "sim"}
                    onChange={() => setYoutubeMadeForKids("sim")}
                    className="h-4 w-4 border-border"
                  />
                  Sim
                </label>
                <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <input
                    type="radio"
                    name="youtube-made-for-kids"
                    checked={youtubeMadeForKids === "nao"}
                    onChange={() => setYoutubeMadeForKids("nao")}
                    className="h-4 w-4 border-border"
                  />
                  Não
                </label>
              </div>
            </div>
          </div>
        )}

        {partialSuccess.length > 0 && (
          <p className="flex items-center gap-2 text-sm text-success">
            <CheckCircle2 size={16} aria-hidden="true" />
            Agendado com sucesso em: {partialSuccess.join(", ")}
          </p>
        )}

        {error && (
          <p className="flex items-center gap-2 text-sm text-error">
            <AlertCircle size={16} aria-hidden="true" />
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting} className="btn btn-primary w-full">
          {submitting ? (
            <>
              <Loader2 size={18} aria-hidden="true" className="animate-spin" />
              {progress ?? "Agendando..."}
            </>
          ) : (
            <>
              <CalendarClock size={18} aria-hidden="true" />
              Agendar post
            </>
          )}
        </button>
      </form>
    </div>
  );
}
