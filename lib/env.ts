import { z } from "zod";

const HEX_32_BYTE = /^[a-f0-9]{64}$/i;

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

export function requireEnv(name: string): string {
  return readEnv(name);
}

export function getBaseUrl(): string {
  return process.env.NEXTAUTH_URL ?? "http://localhost:3000";
}

export function getEncryptionKeyHex(): string {
  const value = readEnv("ENCRYPTION_KEY");
  if (!HEX_32_BYTE.test(value)) {
    throw new Error("ENCRYPTION_KEY must be a 32-byte hex string");
  }
  return value;
}

// Env vars that must be present before an Instagram OAuth round trip can even
// start. Checked up front so a self-hoster with a half-filled .env gets the
// variable names back instead of an unhandled throw from requireEnv().
const INSTAGRAM_OAUTH_ENV = [
  "INSTAGRAM_APP_ID",
  "INSTAGRAM_APP_SECRET",
  "ENCRYPTION_KEY",
  "NEXTAUTH_SECRET",
] as const;

export function getMissingInstagramOAuthEnv(): string[] {
  return INSTAGRAM_OAUTH_ENV.filter((name) => {
    const value = process.env[name];
    if (!value) return true;
    // A malformed key fails later inside encryptToken, after the user has
    // already round-tripped through Meta — catch the bad format here instead.
    return name === "ENCRYPTION_KEY" && !HEX_32_BYTE.test(value);
  });
}

export function getMetaGraphApiVersion(): string {
  return process.env.META_GRAPH_API_VERSION ?? "v25.0";
}

/**
 * Optional sign-in allowlist.
 *
 * A self-hosted instance on a public domain is open to signup: the email
 * provider creates an account for whoever asks for a magic link, and that
 * account gets its own workspace. ALLOWED_EMAILS closes it to a comma-separated
 * list of addresses. Left unset, sign-in behaves exactly as before, so an
 * existing deployment is unaffected.
 */
export function isEmailAllowedToSignIn(
  email: string | null | undefined
): boolean {
  const allowed = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (allowed.length === 0) return true;
  if (!email) return false;
  return allowed.includes(email.toLowerCase());
}

/**
 * Where uploaded scheduled-post media lives on disk. A Docker volume mounted
 * on `web` (rw, for uploads/cleanup) and on `caddy` (ro, to serve `/media/*`)
 * — see deploy/docker-compose.prod.yml and deploy/Caddyfile. Defaults to
 * `/data/media`, the path the compose file mounts the volume at.
 */
export function getMediaDir(): string {
  return process.env.MEDIA_DIR || "/data/media";
}

/**
 * Public base URL files are served from. Defaults to `NEXTAUTH_URL + /media`
 * (Caddy serves that path straight off the volume); `MEDIA_PUBLIC_BASE_URL`
 * overrides it for a setup that serves media from a different host/CDN.
 */
export function getMediaPublicBaseUrl(): string {
  return process.env.MEDIA_PUBLIC_BASE_URL || `${getBaseUrl()}/media`;
}

/**
 * Bearer token the `agendar-lote` CLI (and any other external caller) presents
 * to `POST /api/scheduled-posts`. Unset means the lote route is closed —
 * requests are rejected rather than silently accepted with no auth.
 */
export function getSchedulerApiToken(): string | null {
  return process.env.SCHEDULER_API_TOKEN || null;
}

/**
 * Resend credentials for the "publication failed" alert email, kept separate
 * from the magic-link RESEND_API_KEY/EMAIL_FROM pair above only in the
 * `from`/`to` address: RESEND_FROM lets the alert use a different sender than
 * login emails, and ALERT_EMAIL_TO is who gets paged. Any missing piece just
 * logs instead of sending — a failed publish must never itself throw.
 */
export function getResendAlertConfig(): {
  apiKey: string;
  from: string;
  to: string;
} | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const to = process.env.ALERT_EMAIL_TO;
  if (!apiKey || !from || !to) return null;
  return { apiKey, from, to };
}

export const serverEnvSchema = z.object({
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(16),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().regex(HEX_32_BYTE),
});

export function validateCoreEnv() {
  return serverEnvSchema.parse(process.env);
}
