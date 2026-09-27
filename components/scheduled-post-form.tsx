"use client";

/**
 * New Scheduled Post form
 *
 * Account, type, file(s), caption, local date/time, "show on feed". Files
 * upload straight from the browser to Supabase Storage via a signed URL
 * (`/api/scheduled-posts/upload-url`) — the service role key never reaches
 * the client — then the row is created with `POST /api/scheduled-posts`.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  Clapperboard,
  ImagePlus,
  Layers,
  Loader2,
  UploadCloud,
} from "lucide-react";
import type { AccountOption } from "@/components/account-select";

type MediaType = "REELS" | "IMAGE" | "CAROUSEL";

const MEDIA_TYPE_OPTIONS: { value: MediaType; label: string; icon: typeof Clapperboard; accept: string; hint: string }[] = [
  { value: "REELS", label: "Reels", icon: Clapperboard, accept: "video/mp4", hint: "1 vídeo (.mp4)" },
  { value: "IMAGE", label: "Imagem", icon: ImagePlus, accept: "image/jpeg,image/png", hint: "1 imagem (.jpg/.png)" },
  { value: "CAROUSEL", label: "Carrossel", icon: Layers, accept: "image/jpeg,image/png,video/mp4", hint: "2 a 10 arquivos" },
];

// Brazil dropped DST in 2019, so America/Sao_Paulo is a fixed UTC-3 offset —
// safe to hardcode instead of depending on the operator's browser timezone.
const SAO_PAULO_UTC_OFFSET = "-03:00";

function localToUtcIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00${SAO_PAULO_UTC_OFFSET}`).toISOString();
}

async function uploadFile(
  instagramAccountId: string,
  file: File
): Promise<{ path: string; publicUrl: string }> {
  const signRes = await fetch("/api/scheduled-posts/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instagramAccountId, filename: file.name }),
  });
  const signJson = await signRes.json();
  if (!signRes.ok || !signJson.success) {
    throw new Error(signJson.error ?? "Falha ao preparar o upload");
  }

  const putRes = await fetch(signJson.data.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!putRes.ok) {
    throw new Error(`Falha ao enviar ${file.name} para o Supabase`);
  }

  return { path: signJson.data.path, publicUrl: signJson.data.publicUrl };
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

  useEffect(() => {
    fetch("/api/instagram/accounts")
      .then((r) => r.json())
      .then((res) => {
        if (res.success) {
          setAccounts(res.data.instagramAccounts);
          setInstagramAccountId((prev) => prev || res.data.selectedInstagramAccountId || "");
        }
      });
  }, []);

  const selectedOption = MEDIA_TYPE_OPTIONS.find((o) => o.value === mediaType)!;
  const hashtagCount = (caption.match(/#[^\s#]+/g) ?? []).length;

  function handleMediaTypeChange(next: MediaType) {
    setMediaType(next);
    setFiles([]);
    setCoverFile(null);
  }

  function validate(): string | null {
    if (!instagramAccountId) return "Escolha uma conta";
    if (mediaType === "CAROUSEL") {
      if (files.length < 2 || files.length > 10) return "Carrossel precisa de 2 a 10 arquivos";
    } else if (files.length !== 1) {
      return "Escolha 1 arquivo";
    }
    if (!date || !time) return "Escolha a data e a hora";
    if (!caption.trim()) return "Escreva a legenda";
    if (caption.length > 2200) return "Legenda acima de 2.200 caracteres";
    if (hashtagCount > 30) return "No máximo 30 hashtags";
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

    try {
      const storagePaths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        setProgress(`Enviando arquivo ${i + 1} de ${files.length}...`);
        const uploaded = await uploadFile(instagramAccountId, files[i]);
        storagePaths.push(uploaded.path);
      }

      let coverPath: string | undefined;
      if (coverFile) {
        setProgress("Enviando capa...");
        const uploaded = await uploadFile(instagramAccountId, coverFile);
        coverPath = uploaded.path;
      }

      setProgress("Agendando...");
      const res = await fetch("/api/scheduled-posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instagramAccountId,
          mediaType,
          storagePaths,
          coverPath,
          caption,
          shareToFeed,
          scheduledFor: localToUtcIso(date, time),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Falha ao agendar o post");
      }

      router.push("/agendados");
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
          <span className="label mb-2 block">Tipo de post</span>
          <div className="grid grid-cols-3 gap-2">
            {MEDIA_TYPE_OPTIONS.map((option) => {
              const Icon = option.icon;
              const active = option.value === mediaType;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleMediaTypeChange(option.value)}
                  className={`flex flex-col items-center gap-1.5 rounded-[10px] border px-3 py-3 text-sm font-semibold transition-colors ${
                    active
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

        {mediaType === "REELS" && (
          <div>
            <label htmlFor="cover" className="label">
              Capa (opcional)
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
              accept="image/jpeg,image/png"
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

        <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <input
            type="checkbox"
            checked={shareToFeed}
            onChange={(e) => setShareToFeed(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          Mostrar também no feed
        </label>

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
