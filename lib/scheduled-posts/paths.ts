/**
 * Bucket path convention for agendados: `instagram/<username>/<arquivo>`,
 * shared by the panel upload route, the `agendar-lote` CLI and the cleanup
 * step. Deterministic on purpose — the CLI relies on it to tell whether a
 * given local file has already been scheduled (same path = same upload)
 * instead of tracking a separate "already sent" list.
 */

export function sanitizeUsernameForPath(username: string): string {
  return username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
}

export function sanitizeFilenameForPath(filename: string): string {
  return filename.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function storagePathFor(username: string, filename: string): string {
  return `instagram/${sanitizeUsernameForPath(username)}/${sanitizeFilenameForPath(filename)}`;
}
