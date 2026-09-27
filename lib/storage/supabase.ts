import { getSupabaseStorageConfig } from "@/lib/env";

/**
 * Supabase Storage over plain `fetch` — no `@supabase/supabase-js` dependency.
 * The scheduled-posts feature only needs three calls (sign an upload, read the
 * public URL, delete objects on cleanup), so the SDK would add a dependency
 * for surface we do not use.
 */

// The bucket is provisioned once outside the app (public, mp4/jpeg/png,
// 50MB/file) — see docs/2026-09-27-agendados-comentarios.md. Not worth an env
// var: every deploy of this feature uses the same bucket name.
export const SOCIAL_BUCKET = "social";

export interface SupabaseStorageConfig {
  url: string;
  serviceRoleKey: string;
}

/** Public URL of an object already uploaded to the (public) `social` bucket. */
export function getPublicStorageUrl(
  path: string,
  config: SupabaseStorageConfig | null = getSupabaseStorageConfig()
): string {
  if (!config) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured");
  return `${config.url}/storage/v1/object/public/${SOCIAL_BUCKET}/${path}`;
}

/**
 * Ask Supabase for a signed upload token for `path`, so the browser can PUT
 * the file directly without the service role key ever reaching the client.
 * Returns the full URL (including the token) the browser should PUT to.
 */
export async function createSignedUploadUrl(
  path: string,
  config: SupabaseStorageConfig | null = getSupabaseStorageConfig()
): Promise<{ path: string; signedUrl: string; token: string }> {
  if (!config) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured");

  const response = await fetch(
    `${config.url}/storage/v1/object/upload/sign/${SOCIAL_BUCKET}/${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
      },
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Supabase Storage signed upload failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { url?: string };
  // The API answers with a relative path carrying the token as a query
  // param, e.g. "/object/upload/sign/social/x.mp4?token=eyJ...". Pull the
  // token out so the caller can build (or the browser can hit) the absolute
  // URL against the exact host it is already using.
  const relative = data.url ?? "";
  const token = new URL(relative, config.url).searchParams.get("token") ?? "";
  if (!token) {
    throw new Error("Supabase Storage did not return an upload token");
  }

  return {
    path,
    token,
    signedUrl: `${config.url}/storage/v1/object/upload/sign/${SOCIAL_BUCKET}/${path}?token=${token}`,
  };
}

/**
 * Upload straight to Storage with the service role key. Used only by the
 * `agendar-lote` CLI, which runs on the operator's machine with the key in
 * its own environment — never from the browser or a request handler.
 */
export async function uploadWithServiceKey(
  path: string,
  body: Buffer,
  contentType: string,
  config: SupabaseStorageConfig | null = getSupabaseStorageConfig()
): Promise<void> {
  if (!config) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured");

  const response = await fetch(
    `${config.url}/storage/v1/object/${SOCIAL_BUCKET}/${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
        "x-upsert": "false",
      },
      body: new Uint8Array(body),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Supabase Storage upload failed (${response.status}): ${errorBody}`);
  }
}

/**
 * Delete objects from the bucket. Best-effort: the cleanup cron calls this
 * for posts published more than 24h ago, and a failure here should not stop
 * the rest of the run (it's just disk on the free Supabase plan, not
 * correctness).
 */
export async function deleteStorageObjects(
  paths: string[],
  config: SupabaseStorageConfig | null = getSupabaseStorageConfig()
): Promise<void> {
  if (!config || paths.length === 0) return;

  const response = await fetch(`${config.url}/storage/v1/object/${SOCIAL_BUCKET}`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.serviceRoleKey}`,
      apikey: config.serviceRoleKey,
    },
    body: JSON.stringify({ prefixes: paths }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Supabase Storage delete failed (${response.status}): ${errorBody}`);
  }
}
