import { z } from "zod";

// Instagram's own limits (Content Publishing API): captions are capped at
// 2,200 characters and 30 hashtags.
const MAX_CAPTION_LENGTH = 2200;
const MAX_HASHTAGS = 30;

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

/**
 * Body of `POST /api/scheduled-posts`. Two callers share this route:
 * - the panel ("Novo post"), authenticated by session, which sends
 *   `instagramAccountId` scoped to the caller's workspace;
 * - the `agendar-lote` CLI, authenticated by `SCHEDULER_API_TOKEN`, which has
 *   no session/workspace and instead sends `username` — the route resolves
 *   the account (and therefore the workspace) from it.
 *
 * `storagePaths` are bucket paths, not public URLs: the route derives the
 * public `mediaUrls` itself (see lib/storage/supabase.ts), so a caller can
 * only ever schedule a post pointing at our own bucket.
 */
export const createScheduledPostSchema = z
  .object({
    mediaType: scheduledPostMediaTypeSchema,
    storagePaths: z.array(z.string().min(1)).min(1).max(10),
    // REELS only: an optional still frame for the cover.
    coverPath: z.string().min(1).optional(),
    caption: captionSchema,
    shareToFeed: z.boolean().optional().default(true),
    // ISO 8601 UTC — callers convert from America/Sao_Paulo before sending.
    scheduledFor: z.string().datetime({
      message: "scheduledFor inválido (use ISO 8601 em UTC)",
    }),
    instagramAccountId: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
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
  });

export type CreateScheduledPostInput = z.infer<typeof createScheduledPostSchema>;

/** Body of `PATCH /api/scheduled-posts/[id]` — the panel's row actions. */
export const scheduledPostActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("publish-now") }),
  z.object({
    action: z.literal("reschedule"),
    scheduledFor: z.string().datetime({ message: "scheduledFor inválido" }),
  }),
]);

export type ScheduledPostAction = z.infer<typeof scheduledPostActionSchema>;
