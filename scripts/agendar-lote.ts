/**
 * agendar-lote — schedule a batch of Instagram posts without touching the
 * panel UI, for the "render a folder of quiz videos, schedule them all"
 * workflow (reels-quiz-ingles and similar).
 *
 * Two ways to describe what to schedule:
 *   --pasta <dir> --inicio AAAA-MM-DD --horarios 12:00,19:00 [--por-dia N] --conta <username> [--tipo REELS|IMAGE]
 *     Every *.mp4/*.jpg/*.jpeg/*.png in the folder (sorted by name, files
 *     ending in "-gabarito" excluded — those are quiz answer keys, not
 *     posts) gets one slot in the grid built from --inicio/--horarios/--por-dia.
 *   --csv arquivo,data,hora,conta,tipo
 *     One row per post. `arquivo` may list several paths separated by `;`
 *     for a CAROUSEL row. Paths are resolved relative to the CSV file.
 *
 * Either way, the caption for `<nome>.<ext>` comes from a sibling
 * `<nome>-legenda.txt`, if present.
 *
 * Run with: npx tsx scripts/agendar-lote.ts --pasta ./renders --conta minha_conta \
 *   --inicio 2026-10-01 --horarios 12:00,19:00 [--dry-run]
 *
 * Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SCHEDULER_API_TOKEN and
 * PAINEL_URL from the environment (e.g. `set -a; . deploy/.env.prod; set +a`).
 * --dry-run needs none of them: it only prints the grid.
 */

import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "@/lib/utils/csv";
import { storagePathFor } from "@/lib/scheduled-posts/paths";
import { buildScheduleGrid } from "@/lib/scheduled-posts/schedule-grid";
import { uploadWithServiceKey, type SupabaseStorageConfig } from "@/lib/storage/supabase";
import { getSchedulerApiToken, getSupabaseStorageConfig } from "@/lib/env";

const MEDIA_EXTENSIONS = [".mp4", ".jpg", ".jpeg", ".png"];
const GABARITO_SUFFIX = "-gabarito";
// Brazil dropped DST in 2019, so America/Sao_Paulo is a fixed UTC-3 offset.
const SAO_PAULO_UTC_OFFSET = "-03:00";

type MediaType = "REELS" | "IMAGE" | "CAROUSEL";

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

// --- File discovery ----------------------------------------------------------

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".mp4":
      return "video/mp4";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    default:
      throw new Error(`Extensão não suportada: ${filePath}`);
  }
}

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
    .filter((name) => MEDIA_EXTENSIONS.includes(path.extname(name).toLowerCase()))
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

    return {
      conta,
      mediaType,
      files,
      caption: readCaption(files[0]),
      scheduledForUtcIso: new Date(
        `${row.data.trim()}T${row.hora.trim()}:00${SAO_PAULO_UTC_OFFSET}`
      ).toISOString(),
    };
  });
}

// --- API calls ----------------------------------------------------------------

async function fetchExistingPaths(
  paineluUrl: string,
  token: string,
  conta: string
): Promise<Set<string>> {
  const res = await fetch(
    `${paineluUrl}/api/scheduled-posts?username=${encodeURIComponent(conta)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) return new Set();

  const paths = new Set<string>();
  for (const post of json.data as { storagePaths: string[] }[]) {
    for (const p of post.storagePaths) paths.add(p);
  }
  return paths;
}

async function schedulePost(
  paineluUrl: string,
  token: string,
  plan: PostPlan,
  storagePaths: string[]
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${paineluUrl}/api/scheduled-posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      username: plan.conta,
      mediaType: plan.mediaType,
      storagePaths,
      caption: plan.caption,
      scheduledFor: plan.scheduledForUtcIso,
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
  const storageConfig: SupabaseStorageConfig | null = getSupabaseStorageConfig();

  if (!dryRun) {
    if (!paineluUrl) throw new Error("Defina PAINEL_URL no ambiente");
    if (!schedulerToken) throw new Error("Defina SCHEDULER_API_TOKEN no ambiente");
    if (!storageConfig) throw new Error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente");
  }

  const csvPath = requireString(args, "csv");
  const conta = requireString(args, "conta");

  const plans = csvPath ? planFromCsv(csvPath, conta) : planFromFolder(args, conta ?? "");
  if (plans.length === 0) {
    console.log("[agendar-lote] nada para agendar");
    return;
  }

  console.log(`[agendar-lote] ${plans.length} post(s) na grade${dryRun ? " (dry-run)" : ""}`);

  const existingByConta = new Map<string, Set<string>>();
  if (!dryRun) {
    for (const c of new Set(plans.map((p) => p.conta))) {
      existingByConta.set(c, await fetchExistingPaths(paineluUrl!, schedulerToken!, c));
    }
  }

  let scheduled = 0;
  let skipped = 0;
  let failed = 0;

  for (const plan of plans) {
    const storagePaths = plan.files.map((f) => storagePathFor(plan.conta, path.basename(f)));
    const when = new Date(plan.scheduledForUtcIso).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
    });
    const fileNames = plan.files.map((f) => path.basename(f)).join(", ");

    const alreadyScheduled = storagePaths.some((p) => existingByConta.get(plan.conta)?.has(p));
    if (alreadyScheduled) {
      console.log(`[agendar-lote] pulando (já agendado): ${fileNames}`);
      skipped += 1;
      continue;
    }

    console.log(
      `[agendar-lote] ${dryRun ? "(dry-run) " : ""}${plan.mediaType} @${plan.conta} em ${when} — ${fileNames}`
    );
    if (dryRun) {
      scheduled += 1;
      continue;
    }

    for (let i = 0; i < plan.files.length; i++) {
      const buffer = fs.readFileSync(plan.files[i]);
      await uploadWithServiceKey(storagePaths[i], buffer, contentTypeFor(plan.files[i]), storageConfig!);
    }

    const result = await schedulePost(paineluUrl!, schedulerToken!, plan, storagePaths);
    if (!result.ok) {
      console.error(`[agendar-lote] falhou (${fileNames}): ${result.error}`);
      failed += 1;
      continue;
    }
    scheduled += 1;
  }

  console.log(
    `[agendar-lote] concluído: ${scheduled} agendado(s), ${skipped} pulado(s), ${failed} falhou(aram)`
  );
}

main().catch((err) => {
  console.error("[agendar-lote]", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
