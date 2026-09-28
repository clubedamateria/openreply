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
    // REELS only: an optional still frame for the cover.
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
