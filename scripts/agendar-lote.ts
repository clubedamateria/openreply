/**
 * agendar-lote — schedule a batch of Instagram posts without touching the
 * panel UI, for the "render a folder of quiz videos, schedule them all"
 * workflow (reels-quiz-ingles and similar).
 *
 * Two ways to describe what to schedule:
 *   --pasta <dir> --inicio AAAA-MM-DD --horarios 12:00,19:00 [--por-dia N] --conta <username> [--tipo REELS|IMAGE]
 *     Every *.mp4/*.jpg/*.jpeg in the folder (sorted by name, files ending in
 *     "-gabarito" excluded — those are quiz answer keys, not posts) gets one
 *     slot in the grid built from --inicio/--horarios/--por-dia. --horarios
 *     accepts "9:00" as well as "09:00".
 *   --csv arquivo,data,hora,conta,tipo
 *     One row per post. `arquivo` may list several paths separated by `;`
 *     for a CAROUSEL row. Paths are resolved relative to the CSV file.
 *     `data` accepts AAAA-MM-DD or DD/MM/AAAA.
 *
 * PNG is never accepted (the Content Publishing API only takes JPEG for
 * images) — this is checked before any upload starts.
 *
 * Either way, the caption for `<nome>.<ext>` comes from a sibling
 * `<nome>-legenda.txt`, if present.
 *
 * Run with: npx tsx scripts/agendar-lote.ts --pasta ./renders --conta minha_conta \
 *   --inicio 2026-10-01 --horarios 12:00,19:00 [--dry-run]
 *
 * Reads PAINEL_URL and SCHEDULER_API_TOKEN from the environment (e.g.
 * `set -a; . deploy/.env.prod; set +a`). --dry-run needs neither: it only
 * prints the grid.
 *
 * Fase 4 — `--destinos instagram,tiktok,youtube` (default `instagram`) fans
 * the SAME upload out into one `POST /api/scheduled-posts` per destination.
 * `--conta` stays required either way (it resolves the workspace even for a
 * TikTok/YouTube-only run). TikTok needs `--tiktok-privacidade` (one of
 * PUBLIC_TO_EVERYONE/MUTUAL_FOLLOW_FRIENDS/FOLLOWER_OF_CREATOR/SELF_ONLY, no
 * default) and `--tiktok-consentimento` (a bare flag, or exactly `sim` — any
 * other value aborts before anything uploads, explaining why). Rodada 5,
 * achado 5: `--tiktok-comentarios`/`--tiktok-dueto`/`--tiktok-costura` are
 * each `sim|nao`, REQUIRED (no default — TikTok's own API forbids one),
 * replacing the old `--tiktok-sem-dueto`/`--tiktok-sem-costura` opt-outs.
 * YouTube needs `--youtube-infantil sim|nao` (no default — COPPA); the title
 * comes from a sibling `<nome>-titulo.txt` if present, else the caption's
 * first line cut to 100 chars; `--youtube-visibilidade` defaults to
 * `public`. Both destinations require every planned file to be `--tipo
 * REELS` (single video) — checked before any upload starts, same as the
 * rest of validatePlansOrThrow.
 */

import { createHash } from "node:crypto";
import fs, { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "@/lib/utils/csv";
import { buildScheduleGrid } from "@/lib/scheduled-posts/schedule-grid";
import { saoPauloToUtcIso } from "@/lib/scheduled-posts/timezone";
import { getSchedulerApiToken } from "@/lib/env";

const GABARITO_SUFFIX = "-gabarito";
const MAX_CAPTION_LENGTH = 2200;
const MAX_HASHTAGS = 30;
// A few minutes of slack for clock skew/upload time — mirrors the API's own
// tolerance (lib/scheduled-posts/schema.ts).
const MAX_PAST_SLACK_MS = 5 * 60 * 1000;

type MediaType = "REELS" | "IMAGE" | "CAROUSEL";
type Platform = "INSTAGRAM" | "TIKTOK" | "YOUTUBE";

const TIKTOK_PRIVACY_LEVELS = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;
const MAX_YOUTUBE_TITLE_LENGTH = 100;

interface PostPlan {
  conta: string;
  mediaType: MediaType;
  /** Absolute paths, in carousel order (a single entry for REELS/IMAGE). */
  files: string[];
  caption: string;
  scheduledForUtcIso: string;
}

// --- Small argv parser (no dependency: neither commander nor yargs is
// already in package.json, and the flag set here is small and flat). -------

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function requireString(args: Args, key: string): string | null {
  const value = args[key];
  return typeof value === "string" ? value : null;
}

// --- Fase 4: destinations (Instagram/TikTok/YouTube via Zernio) ---------------

function parseDestinos(args: Args): Platform[] {
  const raw = requireString(args, "destinos") ?? "instagram";
  const mapped = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s): Platform => {
      if (s === "instagram") return "INSTAGRAM";
      if (s === "tiktok") return "TIKTOK";
      if (s === "youtube") return "YOUTUBE";
      throw new Error(`--destinos inválido: "${s}" (use instagram, tiktok e/ou youtube)`);
    });
  return [...new Set(mapped)];
}

/** `--tiktok-comentarios`/`--tiktok-dueto`/`--tiktok-costura` are each
 * required and take exactly `sim`/`nao` — Rodada 5, achado 5: TikTok's own
 * Content Posting API forbids a default value on these, so there is no safe
 * fallback to assume when the flag is missing or misspelled. */
function requireSimNaoFlag(args: Args, key: string, reason: string): boolean {
  const value = requireString(args, key);
  if (value !== "sim" && value !== "nao") {
    throw new Error(`--${key} é obrigatório para --destinos com tiktok (use "sim" ou "nao") — ${reason}`);
  }
  return value === "sim";
}

/** Rodada 5, achado 6: `--tiktok-consentimento` used to accept ANY truthy
 * value (including the string `"nao"`, since parseArgs only turns a flag
 * into `true` when it has no following value) as consent — a copy-pasted
 * `--tiktok-consentimento nao` would silently be read as "yes, I consent".
 * Now only the bare flag or exactly `"sim"` counts; anything else aborts. */
function hasTiktokConsent(args: Args): boolean {
  const value = args["tiktok-consentimento"];
  return value === true || value === "sim";
}

function buildTiktokSettings(args: Args): {
  privacyLevel: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  consentGiven: boolean;
} {
  const privacidade = requireString(args, "tiktok-privacidade")?.toUpperCase();
  if (!privacidade || !(TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(privacidade)) {
    throw new Error(
      `--tiktok-privacidade é obrigatório para --destinos com tiktok e deve ser um de: ${TIKTOK_PRIVACY_LEVELS.join(", ")}`
    );
  }
  if (args["tiktok-consentimento"] !== undefined && !hasTiktokConsent(args)) {
    throw new Error(
      `--tiktok-consentimento só aceita a flag sozinha ou "sim" (recebido "${String(args["tiktok-consentimento"])}") — nada além disso conta como consentimento`
    );
  }
  if (!hasTiktokConsent(args)) {
    throw new Error(
      '--tiktok-consentimento é obrigatório para --destinos com tiktok — confirma que revisou o conteúdo e concorda com a Music Usage Confirmation do TikTok'
    );
  }
  return {
    privacyLevel: privacidade,
    allowComment: requireSimNaoFlag(args, "tiktok-comentarios", "TikTok não permite valor padrão para comentários"),
    allowDuet: requireSimNaoFlag(args, "tiktok-dueto", "TikTok não permite valor padrão para dueto"),
    allowStitch: requireSimNaoFlag(args, "tiktok-costura", "TikTok não permite valor padrão para costura"),
    consentGiven: true,
  };
}

/** `<nome>-titulo.txt` if present, else the caption's own first line, cut to
 * MAX_YOUTUBE_TITLE_LENGTH — mirrors components/scheduled-post-form.tsx's
 * default for the same field in the panel. */
function youtubeTitleFor(mediaPath: string, caption: string): string {
  const dir = path.dirname(mediaPath);
  const base = path.basename(mediaPath, path.extname(mediaPath));
  const titlePath = path.join(dir, `${base}-titulo.txt`);
  if (fs.existsSync(titlePath)) {
    return fs.readFileSync(titlePath, "utf8").trim().slice(0, MAX_YOUTUBE_TITLE_LENGTH);
  }
  return (caption.split("\n")[0] ?? "").trim().slice(0, MAX_YOUTUBE_TITLE_LENGTH);
}

function validateYoutubeInfantilArgOrThrow(args: Args): "sim" | "nao" {
  const value = requireString(args, "youtube-infantil");
  if (value !== "sim" && value !== "nao") {
    throw new Error('--youtube-infantil é obrigatório para --destinos com youtube (use "sim" ou "nao")');
  }
  return value;
}

function buildYoutubeSettings(args: Args, mediaPath: string, caption: string): {
  title: string;
  visibility: string;
  madeForKids: boolean;
} {
  const visibilidade = requireString(args, "youtube-visibilidade") ?? "public";
  const infantil = validateYoutubeInfantilArgOrThrow(args);
  const title = youtubeTitleFor(mediaPath, caption);
  if (!title) {
    throw new Error(
      `${path.basename(mediaPath)}: YouTube precisa de título — crie ${path.basename(mediaPath, path.extname(mediaPath))}-titulo.txt ou escreva uma legenda`
    );
  }
  return { title, visibility: visibilidade, madeForKids: infantil === "sim" };
}

/** Everything about `--destinos` checkable before any upload starts —
 * mirrors validatePlansOrThrow's own "whole batch first" philosophy. */
function validateDestinosOrThrow(args: Args, plans: PostPlan[], destinos: Platform[]): void {
  const errors: string[] = [];

  if (destinos.includes("TIKTOK")) {
    try {
      buildTiktokSettings(args);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (destinos.includes("YOUTUBE")) {
    try {
      validateYoutubeInfantilArgOrThrow(args);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    for (const plan of plans) {
      if (!youtubeTitleFor(plan.files[0], plan.caption)) {
        errors.push(
          `${path.basename(plan.files[0])}: YouTube precisa de título — crie um -titulo.txt ou escreva uma legenda`
        );
      }
    }
  }
  if (destinos.includes("TIKTOK") || destinos.includes("YOUTUBE")) {
    for (const plan of plans) {
      if (plan.mediaType !== "REELS") {
        const label = plan.files.map((f) => path.basename(f)).join(", ");
        errors.push(`${label}: TikTok e YouTube Shorts só aceitam vídeo (--tipo REELS)`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Validação de --destinos falhou, nada foi enviado:\n  - ${errors.join("\n  - ")}`);
  }
}

// --- File discovery ----------------------------------------------------------

/** Content-Type for a media file, or throws for anything the Content
 * Publishing API can't take — PNG explicitly, since it's the one people
 * actually try (JPEG is a much more surprising rejection to hit mid-batch). */
function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp4":
      return "video/mp4";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      throw new Error(
        `${path.basename(filePath)}: PNG não é aceito pelo Instagram (Content Publishing API) — converta para JPEG`
      );
    default:
      throw new Error(`Extensão não suportada: ${filePath}`);
  }
}

const MEDIA_EXTENSIONS_FOR_LISTING = [".mp4", ".jpg", ".jpeg", ".png"];

function readCaption(mediaPath: string): string {
  const dir = path.dirname(mediaPath);
  const base = path.basename(mediaPath, path.extname(mediaPath));
  const legendaPath = path.join(dir, `${base}-legenda.txt`);
  if (fs.existsSync(legendaPath)) {
    return fs.readFileSync(legendaPath, "utf8").trim();
  }
  console.warn(`[agendar-lote] sem legenda para ${path.basename(mediaPath)}, usando legenda vazia`);
  return "";
}

function listFolderFiles(pasta: string): string[] {
  return fs
    .readdirSync(pasta)
    .filter((name) => MEDIA_EXTENSIONS_FOR_LISTING.includes(path.extname(name).toLowerCase()))
    // *-gabarito.jpg is the quiz answer key, not a post.
    .filter((name) => !path.basename(name, path.extname(name)).endsWith(GABARITO_SUFFIX))
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .map((name) => path.join(pasta, name));
}

function planFromFolder(args: Args, conta: string): PostPlan[] {
  const pasta = requireString(args, "pasta");
  if (!pasta) throw new Error("--pasta é obrigatório neste modo");

  const mediaType = (requireString(args, "tipo") ?? "REELS").toUpperCase() as MediaType;
  if (mediaType === "CAROUSEL") {
    throw new Error(
      "--tipo CAROUSEL não é suportado no modo --pasta (cada arquivo vira um post); use --csv com arquivo1;arquivo2 para carrossel"
    );
  }
  if (mediaType !== "REELS" && mediaType !== "IMAGE") {
    throw new Error(`--tipo inválido: ${mediaType}`);
  }

  const files = listFolderFiles(pasta);
  if (files.length === 0) throw new Error(`Nenhum arquivo de mídia encontrado em ${pasta}`);

  const inicio = requireString(args, "inicio");
  const horariosArg = requireString(args, "horarios");
  if (!inicio || !horariosArg) {
    throw new Error("O modo --pasta exige --inicio e --horarios (ou use --csv)");
  }
  // Accepts "9:00" as well as "09:00" — buildScheduleGrid/saoPauloToUtcIso
  // parse each half with Number(), so a missing leading zero is already fine.
  const horarios = horariosArg.split(",").map((h) => h.trim());
  const porDiaArg = requireString(args, "por-dia");
  const porDia = porDiaArg ? Number(porDiaArg) : undefined;

  const grid = buildScheduleGrid({ itemCount: files.length, startDate: inicio, horarios, porDia });

  return grid.map((slot) => ({
    conta,
    mediaType,
    files: [files[slot.index]],
    caption: readCaption(files[slot.index]),
    scheduledForUtcIso: slot.scheduledForUtcIso,
  }));
}

/** Accepts AAAA-MM-DD (already ISO) or DD/MM/AAAA. */
function normalizeCsvDate(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (br) {
    const [, day, month, year] = br;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  throw new Error(`Data inválida: "${raw}" (use AAAA-MM-DD ou DD/MM/AAAA)`);
}

function planFromCsv(csvPath: string, defaultConta: string | null): PostPlan[] {
  const text = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsv(text);
  const baseDir = path.dirname(csvPath);

  return rows.map((row, i) => {
    const conta = row.conta?.trim() || defaultConta;
    if (!conta) throw new Error(`Linha ${i + 2} do CSV sem coluna "conta" e sem --conta`);
    if (!row.arquivo) throw new Error(`Linha ${i + 2} do CSV sem coluna "arquivo"`);
    if (!row.data || !row.hora) throw new Error(`Linha ${i + 2} do CSV sem "data"/"hora"`);

    const files = row.arquivo.split(";").map((f) => path.resolve(baseDir, f.trim()));
    const mediaType = (row.tipo?.trim() || "REELS").toUpperCase() as MediaType;
    const date = normalizeCsvDate(row.data);

    return {
      conta,
      mediaType,
      files,
      caption: readCaption(files[0]),
      scheduledForUtcIso: saoPauloToUtcIso(date, row.hora.trim()),
    };
  });
}

// --- Pre-flight validation (before any upload) --------------------------------

function countHashtags(caption: string): number {
  return (caption.match(/#[^\s#]+/g) ?? []).length;
}

/**
 * Everything checkable without touching the network: caption limits, file
 * types, and whether the slot is already in the past. Runs over the WHOLE
 * batch before a single byte is uploaded — a mistake on item 40 of 50 must
 * not leave the first 39 half-scheduled.
 */
function validatePlansOrThrow(plans: PostPlan[], now: number): void {
  const errors: string[] = [];
  for (const plan of plans) {
    const label = plan.files.map((f) => path.basename(f)).join(", ");

    if (plan.caption.length > MAX_CAPTION_LENGTH) {
      errors.push(`${label}: legenda com ${plan.caption.length} caracteres (máx. ${MAX_CAPTION_LENGTH})`);
    }
    if (countHashtags(plan.caption) > MAX_HASHTAGS) {
      errors.push(`${label}: mais de ${MAX_HASHTAGS} hashtags`);
    }
    if (plan.mediaType === "CAROUSEL" && (plan.files.length < 2 || plan.files.length > 10)) {
      errors.push(`${label}: carrossel precisa de 2 a 10 arquivos (tem ${plan.files.length})`);
    }
    if (plan.mediaType !== "CAROUSEL" && plan.files.length !== 1) {
      errors.push(`${label}: ${plan.mediaType} precisa de exatamente 1 arquivo`);
    }
    try {
      for (const file of plan.files) contentTypeFor(file);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    if (new Date(plan.scheduledForUtcIso).getTime() < now - MAX_PAST_SLACK_MS) {
      errors.push(`${label}: horário ${plan.scheduledForUtcIso} já passou`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Validação falhou, nada foi enviado:\n  - ${errors.join("\n  - ")}`);
  }
}

// --- Content hashing (permanent dedup, bloqueador 3) --------------------------

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function hashSetKey(hashes: string[]): string {
  return [...hashes].sort().join(",");
}

// --- API calls ----------------------------------------------------------------

/**
 * Existing (non-CANCELED) content-hash sets already scheduled for `conta`,
 * per destination platform (Fase 4: dedup on the server is scoped per
 * platform+account now — the same file can legitimately be scheduled on
 * Instagram AND still need scheduling on TikTok). Unlike the old path-based
 * check, this is never silently empty on failure — a broken GET here means
 * we genuinely don't know what's already scheduled, so the caller must
 * abort rather than risk re-uploading and re-scheduling duplicates.
 */
async function fetchExistingHashKeys(
  paineluUrl: string,
  token: string,
  conta: string
): Promise<Record<Platform, Set<string>>> {
  const res = await fetch(
    `${paineluUrl}/api/scheduled-posts?username=${encodeURIComponent(conta)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    throw new Error(
      `Falha ao consultar posts já agendados de @${conta} (${json?.error ?? `HTTP ${res.status}`}) — abortando, não é seguro continuar sem saber o que já está agendado`
    );
  }

  const byPlatform: Record<Platform, Set<string>> = {
    INSTAGRAM: new Set(),
    TIKTOK: new Set(),
    YOUTUBE: new Set(),
  };
  for (const post of json.data as { contentHash?: string[]; platform?: Platform }[]) {
    const platform = post.platform ?? "INSTAGRAM"; // older rows predate Fase 4's column
    if (post.contentHash && post.contentHash.length > 0) {
      byPlatform[platform].add(hashSetKey(post.contentHash));
    }
  }
  return byPlatform;
}

async function uploadFile(
  paineluUrl: string,
  token: string,
  filePath: string,
  contentType: string
): Promise<string> {
  const res = await fetch(`${paineluUrl}/api/scheduled-posts/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body: fs.readFileSync(filePath),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    throw new Error(json?.error ?? `Falha ao enviar ${path.basename(filePath)} (HTTP ${res.status})`);
  }
  return json.data.path as string;
}

async function schedulePost(
  paineluUrl: string,
  token: string,
  plan: PostPlan,
  storagePaths: string[],
  platform: Platform,
  args: Args
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${paineluUrl}/api/scheduled-posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      username: plan.conta,
      platform,
      mediaType: plan.mediaType,
      storagePaths,
      caption: plan.caption,
      scheduledFor: plan.scheduledForUtcIso,
      ...(platform === "TIKTOK" ? { tiktokSettings: buildTiktokSettings(args) } : {}),
      ...(platform === "YOUTUBE"
        ? { youtubeSettings: buildYoutubeSettings(args, plan.files[0], plan.caption) }
        : {}),
    }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    return { ok: false, error: json?.error ?? `HTTP ${res.status}` };
  }
  return { ok: true };
}

// --- Main -----------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(args["dry-run"]);

  const paineluUrl = process.env.PAINEL_URL;
  const schedulerToken = getSchedulerApiToken();

  if (!dryRun) {
    if (!paineluUrl) throw new Error("Defina PAINEL_URL no ambiente");
    if (!schedulerToken) throw new Error("Defina SCHEDULER_API_TOKEN no ambiente");
  }

  const csvPath = requireString(args, "csv");
  const conta = requireString(args, "conta");
  const destinos = parseDestinos(args);

  const plans = csvPath ? planFromCsv(csvPath, conta) : planFromFolder(args, conta ?? "");
  if (plans.length === 0) {
    console.log("[agendar-lote] nada para agendar");
    return;
  }

  // Bloqueador D: caption/type/time are all checked BEFORE any upload, and a
  // slot already in the past aborts the whole run rather than failing
  // halfway through. Fase 4: --destinos' own requirements (privacidade,
  // consentimento, infantil, vídeo-only) are checked the same way.
  validatePlansOrThrow(plans, Date.now());
  validateDestinosOrThrow(args, plans, destinos);

  console.log(
    `[agendar-lote] ${plans.length} post(s) na grade, destinos: ${destinos.join(", ")}${dryRun ? " (dry-run)" : ""}`
  );

  const existingHashesByConta = new Map<string, Record<Platform, Set<string>>>();
  if (!dryRun) {
    for (const c of new Set(plans.map((p) => p.conta))) {
      existingHashesByConta.set(c, await fetchExistingHashKeys(paineluUrl!, schedulerToken!, c));
    }
  }

  let scheduled = 0;
  let skipped = 0;
  let failed = 0;

  for (const plan of plans) {
    const when = new Date(plan.scheduledForUtcIso).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    const fileNames = plan.files.map((f) => path.basename(f)).join(", ");

    if (dryRun) {
      console.log(
        `[agendar-lote] (dry-run) ${plan.mediaType} @${plan.conta} em ${when} — ${fileNames} — destinos: ${destinos.join(", ")}`
      );
      scheduled += 1;
      continue;
    }

    try {
      const localHashes = plan.files.map(sha256File);
      const hashKey = hashSetKey(localHashes);
      // Fase 4: dedup is per (conta, platform) now — a file already
      // scheduled on Instagram still needs scheduling on TikTok/YouTube, so
      // each destination is skipped independently, not the whole plan.
      const existingForConta = existingHashesByConta.get(plan.conta);
      const toSchedule = destinos.filter((platform) => !existingForConta?.[platform]?.has(hashKey));
      if (toSchedule.length === 0) {
        console.log(`[agendar-lote] pulando (mesmo conteúdo já agendado em todos os destinos): ${fileNames}`);
        skipped += 1;
        continue;
      }

      console.log(
        `[agendar-lote] ${plan.mediaType} @${plan.conta} em ${when} — ${fileNames} — destinos: ${toSchedule.join(", ")}`
      );

      const storagePaths: string[] = [];
      for (const file of plan.files) {
        // Rodada 3, achado 9: the upload endpoint caps at 100MB and a slow
        // connection can hit the reverse proxy's own timeout well before
        // that — warn instead of finding out from a failed upload.
        const sizeMb = fs.statSync(file).size / (1024 * 1024);
        if (sizeMb > 100) {
          console.warn(
            `[agendar-lote] aviso: ${path.basename(file)} tem ${sizeMb.toFixed(0)}MB — acima de 100MB pode estourar o limite do upload ou o timeout numa conexão lenta.`
          );
        }
        storagePaths.push(await uploadFile(paineluUrl!, schedulerToken!, file, contentTypeFor(file)));
      }

      let anyFailedThisPlan = false;
      for (const platform of toSchedule) {
        const result = await schedulePost(paineluUrl!, schedulerToken!, plan, storagePaths, platform, args);
        if (!result.ok) {
          console.error(`[agendar-lote] falhou (${fileNames}, ${platform}): ${result.error}`);
          anyFailedThisPlan = true;
        } else {
          console.log(`[agendar-lote]   -> ${platform} agendado`);
        }
      }
      if (anyFailedThisPlan) {
        failed += 1;
      } else {
        scheduled += 1;
      }
    } catch (err) {
      // Per-item failure: log and move on to the next item — never abort
      // the whole batch over one bad file/upload.
      console.error(`[agendar-lote] falhou (${fileNames}): ${err instanceof Error ? err.message : err}`);
      failed += 1;
    }
  }

  console.log(
    `[agendar-lote] concluído: ${scheduled} agendado(s), ${skipped} pulado(s), ${failed} falhou(aram)`
  );
}

// Only auto-run when invoked directly (`npx tsx scripts/agendar-lote.ts ...`),
// never when a test imports this module to exercise the pure helpers below or
// `main()` itself with mocked fetch/env — an unguarded top-level call would
// otherwise fire on every `import()` and read real argv/env.
//
// Rodada 5, achado 11: comparing `import.meta.url` to a hand-built
// `file://${process.argv[1]}` string stays silent when the script is called
// through a symlink (`argv[1]` is the symlink's own path, which never equals
// the real module URL Node resolves for `import.meta.url`) — resolving both
// sides to their real, canonical path makes the guard match either way.
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error("[agendar-lote]", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

export {
  main,
  parseArgs,
  parseDestinos,
  buildTiktokSettings,
  youtubeTitleFor,
  validateYoutubeInfantilArgOrThrow,
  buildYoutubeSettings,
  validateDestinosOrThrow,
  validatePlansOrThrow,
};
export type { Args, Platform, PostPlan };
