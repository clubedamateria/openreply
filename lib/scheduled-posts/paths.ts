import { randomBytes } from "node:crypto";

/**
 * Filenames on the local media disk are flat and content-addressed:
 * `<sha256 primeiros 16 hex>-<id aleatório>.<ext>`. No per-account folder
 * (the old `instagram/<username>/<arquivo>` convention): the hash prefix is
 * what makes content dedup possible, and dropping the original filename
 * entirely closes the path-traversal and same-name-collision issues a
 * literal filename invited.
 *
 * Only `mp4` (video) and `jpg` (image) exist — the Content Publishing API
 * only accepts JPEG images, so PNG is rejected before it ever reaches here.
 */
export const MEDIA_EXTENSIONS = ["mp4", "jpg"] as const;
export type MediaExtension = (typeof MEDIA_EXTENSIONS)[number];

export const MEDIA_FILENAME_REGEX = /^[a-f0-9]{16}-[A-Za-z0-9_-]{6,}\.(mp4|jpg)$/;

export const CONTENT_TYPE_TO_EXTENSION: Record<string, MediaExtension> = {
  "video/mp4": "mp4",
  "image/jpeg": "jpg",
};

export function extensionForContentType(contentType: string | null): MediaExtension | null {
  if (!contentType) return null;
  return CONTENT_TYPE_TO_EXTENSION[contentType.trim().toLowerCase()] ?? null;
}

/** Builds the on-disk filename once the upload's sha256 is known. */
export function mediaFilename(sha256Hex: string, extension: MediaExtension): string {
  const id = randomBytes(6).toString("base64url");
  return `${sha256Hex.slice(0, 16)}-${id}.${extension}`;
}

export function isValidMediaFilename(filename: string): boolean {
  return MEDIA_FILENAME_REGEX.test(filename);
}
