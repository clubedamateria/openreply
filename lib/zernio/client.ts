import {
  MetaApiError,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";

export class ZernioApiError extends MetaApiError {
  constructor(status: number) {
    super(
      status,
      undefined,
      undefined,
      `Zernio request failed (HTTP ${status})`
    );
    this.name = "ZernioApiError";
  }
}

export class ZernioDeliveryUnconfirmedError extends ZernioApiError {
  constructor() {
    super(502);
    this.name = "ZernioDeliveryUnconfirmedError";
    this.message =
      "Message delivery is unconfirmed. Inspect the Instagram inbox before retrying.";
  }
}

export async function zernioRequest<T>({
  apiKey,
  path,
  method = "GET",
  body,
  idempotencyKey,
}: {
  apiKey: string;
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
}): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("Invalid Zernio API path");
  const response = await fetch(`https://zernio.com/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new ZernioApiError(502);
  });
  // Responses can contain platform credentials. Only the HTTP classification is
  // safe to persist in job errors or return to the browser.
  if (!response.ok) {
    const message = `Zernio request failed (HTTP ${response.status})`;
    if (response.status === 429) throw new RateLimitError(message);
    if (response.status === 401) throw new TokenExpiredError(message);
    throw new ZernioApiError(response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json().catch(() => {
    throw new ZernioApiError(502);
  }) as Promise<T>;
}

// --- Fase 4: publicar em TikTok/YouTube Shorts via Zernio -------------------
//
// A different use case from ZernioConnection above (that one is the
// Instagram-inbox webhook integration, managed from Configurações — untouched
// here): this is `lib/scheduled-posts/engine.ts` publishing a ScheduledPost
// row whose `platform` is TIKTOK or YOUTUBE, the same way it publishes
// Instagram rows through the Meta Graph API.

export type ZernioPlatformName = "tiktok" | "youtube";

/** One TikTok/YouTube account, as returned by `GET /accounts` — not used at
 * publish time (the account id for each platform comes from
 * `getZernioAccountIdForPlatform`, env-configured), kept here since it is
 * part of the same API surface and useful for an operator poking at the API
 * by hand. */
export interface ZernioAccount {
  _id: string;
  platform: ZernioPlatformName;
  username: string;
  displayName?: string;
  profileId?: string;
  isActive: boolean;
}

export interface ZernioPostPlatformResult {
  platform: ZernioPlatformName;
  status: string; // "published" | "failed" | "processing" | ... (not a closed enum in the docs)
  platformPostId: string | null;
  platformPostUrl: string | null;
  errorMessage: string | null;
  publishedAt?: string | null;
}

export interface ZernioPost {
  _id: string;
  status: string;
  platforms: ZernioPostPlatformResult[];
  /** Present on `POST`/`GET /posts/{id}` responses; assumed present on
   * `GET /posts` (list) items too for `reconcileZernioByList` in
   * lib/scheduled-posts/engine.ts to match against — not verified against
   * the real API (see listZernioPosts below), so every reader treats a
   * missing field as "can't match", never as an empty string/list. */
  content?: string;
  mediaItems?: { type?: string; url?: string }[];
  createdAt?: string;
}

export interface TikTokSettingsPayload {
  privacy_level: string;
  allow_comment: boolean;
  allow_duet: boolean;
  allow_stitch: boolean;
  content_preview_confirmed: boolean;
  express_consent_given: boolean;
}

export interface YoutubePlatformSpecificData {
  title: string;
  visibility: "public" | "unlisted" | "private";
  madeForKids: boolean;
}

/**
 * `POST /posts`. Verified for real against TikTok on 2026-09-27 (see
 * docs/2026-09-27-agendados-comentarios.md, "Fase 4") with a top-level
 * `tiktokSettings` key alongside `platforms`; YouTube's shape below instead
 * follows https://docs.zernio.com/platforms/youtube literally
 * (`platforms[0].platformSpecificData`) since it was never round-tripped
 * against the real API — confirm the first time a YouTube post actually
 * goes out.
 *
 * `idempotencyKey` should be stable across retries of the *same* attempt
 * (Zernio replays the original response for a repeat within its 24h/
 * per-credential window instead of creating a second post) but must change
 * between genuinely separate attempts (a human-confirmed retry after
 * `checkRetrySafety` ruled out the old attempt) — callers derive it from
 * `${scheduledPostId}:${attempts}`.
 */
export async function createZernioPost(
  apiKey: string,
  params: {
    content: string;
    mediaUrl: string;
    platform: ZernioPlatformName;
    accountId: string;
    tiktokSettings?: TikTokSettingsPayload;
    youtubeSpecificData?: YoutubePlatformSpecificData;
  },
  idempotencyKey: string
): Promise<ZernioPost> {
  const platformEntry: Record<string, unknown> = {
    platform: params.platform,
    accountId: params.accountId,
  };
  if (params.youtubeSpecificData) {
    platformEntry.platformSpecificData = params.youtubeSpecificData;
  }

  const body: Record<string, unknown> = {
    content: params.content,
    mediaItems: [{ type: "video", url: params.mediaUrl }],
    platforms: [platformEntry],
    publishNow: true,
  };
  if (params.tiktokSettings) body.tiktokSettings = params.tiktokSettings;

  const { post } = await zernioRequest<{ post: ZernioPost }>({
    apiKey,
    path: "/posts",
    method: "POST",
    body,
    idempotencyKey,
  });
  return post;
}

/** `GET /posts/{id}` — polled once `zernioPostId` is known, until the
 * platform's own status resolves to `published`/`failed`. */
export async function getZernioPost(apiKey: string, postId: string): Promise<ZernioPost> {
  const { post } = await zernioRequest<{ post: ZernioPost }>({
    apiKey,
    path: `/posts/${encodeURIComponent(postId)}`,
  });
  return post;
}

/**
 * `GET /posts?accountId=...` — used only to reconcile a post whose own
 * `POST /posts` response was lost (network error/timeout/5xx), so there is
 * no `zernioPostId` to poll directly. Not verified against the real API (the
 * docs only confirm a filter "exists", not its exact shape) — callers must
 * treat a failure here (including a 404, if the endpoint turns out not to
 * support this filter at all) as "could not reconcile this tick", never as
 * proof the post doesn't exist.
 */
export async function listZernioPosts(
  apiKey: string,
  params: { accountId: string; limit?: number }
): Promise<ZernioPost[]> {
  const query = new URLSearchParams({ accountId: params.accountId });
  if (params.limit) query.set("limit", String(params.limit));
  const result = await zernioRequest<{ posts: ZernioPost[] } | ZernioPost[]>({
    apiKey,
    path: `/posts?${query.toString()}`,
  });
  return Array.isArray(result) ? result : result.posts;
}
