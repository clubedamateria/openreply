import { z } from "zod";
import { MEDIA_FILENAME_REGEX } from "@/lib/scheduled-posts/paths";

// Instagram's own limits (Content Publishing API): captions are capped at
// 2,200 characters and 30 hashtags.
const MAX_CAPTION_LENGTH = 2200;
const MAX_HASHTAGS = 30;
// A post cannot be scheduled more than this far in the past — a few minutes
// of slack absorbs clock skew and the time a form submit takes, without
// letting someone silently queue something for "yesterday".
const MAX_PAST_SLACK_MS = 5 * 60 * 1000;

function countHashtags(caption: string): number {
  return (caption.match(/#[^\s#]+/g) ?? []).length;
}

export const scheduledPostMediaTypeSchema = z.enum(["REELS", "IMAGE", "CAROUSEL"]);

/**
 * Fase 4: publish destination. INSTAGRAM (default, unchanged flow) or
 * TIKTOK/YOUTUBE (YouTube Shorts) via Zernio — see
 * lib/scheduled-posts/engine.ts. `instagramAccountId`/`username` stay
 * required for every platform below: even a TIKTOK/YOUTUBE row still needs
 * one to resolve `workspaceId` (app/api/scheduled-posts/route.ts) — the
 * Zernio account itself is resolved server-side from env
 * (`getZernioAccountIdForPlatform`), never from client input.
 */
export const scheduledPostPlatformSchema = z.enum(["INSTAGRAM", "TIKTOK", "YOUTUBE"]);

/** TikTok's own Content Posting API values. A Business account (the only
 * kind Zernio connects) only actually accepts PUBLIC_TO_EVERYONE — the panel
 * still offers all four (so a Creator account works too) but shows a warning
 * (docs.zernio.com/platforms/tiktok). No default: the operator must pick one
 * every time, on purpose. */
export const TIKTOK_PRIVACY_LEVELS = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;

export const tikTokSettingsSchema = z.object({
  privacyLevel: z.enum(TIKTOK_PRIVACY_LEVELS, {
    message: "Escolha a privacidade do TikTok",
  }),
  // Rodada 5, achado 5: TikTok's own Content Posting API documents these
  // three as required with NO default value — a silent default of `true`
  // here would mean the API boundary itself grants comment/duet/stitch
  // permission the creator never explicitly asked for. No `.optional()`, no
  // `.default(...)`: the caller (UI/CLI) must send an explicit boolean.
  allowComment: z.boolean({ message: '"Permitir comentários" é obrigatório' }),
  allowDuet: z.boolean({ message: '"Permitir dueto" é obrigatório' }),
  allowStitch: z.boolean({ message: '"Permitir costura" é obrigatório' }),
  // The one checkbox ("Confirmo que revisei o conteúdo e concordo com a
  // Music Usage Confirmation do TikTok") feeds BOTH
  // content_preview_confirmed and express_consent_given at the Zernio/TikTok
  // API boundary (lib/zernio/client.ts) — TikTok requires both to be an
  // explicit, human confirmation, never a silent default.
  consentGiven: z.boolean().refine((v) => v === true, {
    message:
      'Confirme "revisei o conteúdo e concordo com a Music Usage Confirmation do TikTok" para publicar no TikTok',
  }),
});

export const YOUTUBE_VISIBILITIES = ["public", "unlisted", "private"] as const;
export const MAX_YOUTUBE_TITLE_LENGTH = 100;

export const youtubeSettingsSchema = z.object({
  // No schema-level default: the UI/CLI compute "1ª linha da legenda,
  // cortada em 100 caracteres" themselves before submitting (a cross-field
  // default zod itself can't express cleanly) — see
  // components/scheduled-post-form.tsx and scripts/agendar-lote.ts.
  title: z
    .string()
    .min(1, "Título é obrigatório")
    .max(MAX_YOUTUBE_TITLE_LENGTH, `Título não pode passar de ${MAX_YOUTUBE_TITLE_LENGTH} caracteres`),
  visibility: z.enum(YOUTUBE_VISIBILITIES).optional().default("public"),
  // No `.optional()`/default on purpose — COPPA ("Feito para crianças?") is
  // required on every YouTube upload; there is no safe default to assume.
  madeForKids: z.boolean({ message: '"Feito para crianças?" é obrigatório' }),
});

const captionSchema = z
  .string()
  .max(MAX_CAPTION_LENGTH, `A legenda não pode passar de ${MAX_CAPTION_LENGTH} caracteres`)
  .refine((c) => countHashtags(c) <= MAX_HASHTAGS, {
    message: `A legenda não pode ter mais de ${MAX_HASHTAGS} hashtags`,
  });

// Flat, content-addressed filename — see lib/scheduled-posts/paths.ts. No
// slashes and no `..` are even expressible: the whole string has to match
// `<hash>-<id>.(mp4|jpg)`, which rules out path traversal by construction
// rather than by blocklist.
const mediaFilenameSchema = z
  .string()
  .regex(MEDIA_FILENAME_REGEX, "Caminho de arquivo inválido");

export function isScheduledForTooFarInThePast(scheduledFor: string, now: Date = new Date()): boolean {
  return new Date(scheduledFor).getTime() < now.getTime() - MAX_PAST_SLACK_MS;
}

/**
 * Body of `POST /api/scheduled-posts`. Two callers share this route:
 * - the panel ("Novo post"), authenticated by session, which sends
 *   `instagramAccountId` scoped to the caller's workspace;
 * - the `agendar-lote` CLI, authenticated by `SCHEDULER_API_TOKEN`, which has
 *   no session/workspace and instead sends `username` — the route resolves
 *   the account (and therefore the workspace) from it.
 *
 * `storagePaths` are on-disk filenames, not URLs: the route derives the
 * public `mediaUrls` itself (see lib/storage/media.ts) and checks the file
 * actually exists in `MEDIA_DIR` before creating the row.
 */
export const createScheduledPostSchema = z
  .object({
    mediaType: scheduledPostMediaTypeSchema,
    storagePaths: z.array(mediaFilenameSchema).min(1).max(10),
    // REELS only: an optional still frame for the cover. Instagram-only (see
    // the platform refine below) — TikTok/YouTube via Zernio have no
    // equivalent field in this version.
    coverPath: mediaFilenameSchema.optional(),
    caption: captionSchema,
    shareToFeed: z.boolean().optional().default(true),
    // ISO 8601 UTC — callers convert from America/Sao_Paulo with
    // lib/scheduled-posts/timezone.ts before sending.
    scheduledFor: z.string().datetime({
      message: "scheduledFor inválido (use ISO 8601 em UTC)",
    }),
    instagramAccountId: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    // Fase 4. Required for every platform — even TIKTOK/YOUTUBE still use
    // instagramAccountId/username as the "context account" that resolves
    // workspaceId (app/api/scheduled-posts/route.ts); only an INSTAGRAM row
    // actually stores it as its own `instagramAccountId` column.
    platform: scheduledPostPlatformSchema.optional().default("INSTAGRAM"),
    tiktokSettings: tikTokSettingsSchema.optional(),
    youtubeSettings: youtubeSettingsSchema.optional(),
    // Bypasses the content-hash dedup check (bloqueador 3) for a deliberate
    // re-post of the exact same file.
    force: z.boolean().optional().default(false),
  })
  .refine((d) => Boolean(d.instagramAccountId || d.username), {
    message: "Informe instagramAccountId (painel) ou username (lote)",
    path: ["instagramAccountId"],
  })
  .refine(
    (d) =>
      d.mediaType === "CAROUSEL"
        ? d.storagePaths.length >= 2 && d.storagePaths.length <= 10
        : d.storagePaths.length === 1,
    {
      message: "REELS e IMAGE precisam de exatamente 1 arquivo; CAROUSEL de 2 a 10",
      path: ["storagePaths"],
    }
  )
  .refine((d) => d.mediaType === "REELS" || !d.coverPath, {
    message: "coverPath só se aplica a posts do tipo REELS",
    path: ["coverPath"],
  })
  .refine((d) => d.platform === "INSTAGRAM" || d.mediaType === "REELS", {
    message: "TikTok e YouTube Shorts só aceitam vídeo (mediaType REELS) por enquanto",
    path: ["mediaType"],
  })
  .refine((d) => d.platform === "INSTAGRAM" || !d.coverPath, {
    message: "coverPath só se aplica a posts do Instagram",
    path: ["coverPath"],
  })
  .refine((d) => d.platform !== "TIKTOK" || Boolean(d.tiktokSettings), {
    message: "Informe tiktokSettings (privacidade e consentimento) para publicar no TikTok",
    path: ["tiktokSettings"],
  })
  .refine((d) => d.platform !== "YOUTUBE" || Boolean(d.youtubeSettings), {
    message: "Informe youtubeSettings (título, visibilidade e madeForKids) para publicar no YouTube",
    path: ["youtubeSettings"],
  })
  .refine((d) => !isScheduledForTooFarInThePast(d.scheduledFor), {
    message: "scheduledFor não pode ser mais de 5 minutos no passado",
    path: ["scheduledFor"],
  });

export type CreateScheduledPostInput = z.infer<typeof createScheduledPostSchema>;

/** Body of `PATCH /api/scheduled-posts/[id]` — the panel's row actions.
 *
 * `force` on `retry`/`reschedule` bypasses the outcome-uncertain safety
 * check (Rodada 3, achado 1): a FAILED post whose previous attempt could not
 * be confirmed one way or the other normally refuses to blindly recreate the
 * container until the caller has manually checked Instagram — `force: true`
 * is the "já conferi, publicar de novo" override.
 */
export const scheduledPostActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("retry"), force: z.boolean().optional().default(false) }),
  z.object({ action: z.literal("publish-now") }),
  z.object({
    action: z.literal("reschedule"),
    scheduledFor: z
      .string()
      .datetime({ message: "scheduledFor inválido" })
      .refine((v) => !isScheduledForTooFarInThePast(v), {
        message: "scheduledFor não pode ser mais de 5 minutos no passado",
      }),
    force: z.boolean().optional().default(false),
  }),
]);

export type ScheduledPostAction = z.infer<typeof scheduledPostActionSchema>;
