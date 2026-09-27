import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { getMediaDir, getMediaPublicBaseUrl } from "@/lib/env";

/**
 * Scheduled-post media on the VM's own disk (a Docker volume shared with
 * Caddy — see deploy/docker-compose.prod.yml), replacing the earlier
 * Supabase Storage design. No external service, no service-role key: the
 * upload route streams straight to `MEDIA_DIR`, Caddy serves it back out
 * under `/media/*`.
 *
 * Filenames are flat (`<sha256 primeiros 16>-<id>.<ext>`, no per-account
 * folder) — see lib/scheduled-posts/paths.ts for the naming/validation
 * regex. That is also what makes content-based dedup (Fatia 1, bloqueador 3)
 * possible: the same file uploaded twice hashes to the same prefix.
 */

export function resolveMediaPath(filename: string): string {
  return path.join(getMediaDir(), filename);
}

export function getMediaPublicUrl(filename: string): string {
  return `${getMediaPublicBaseUrl()}/${filename}`;
}

export async function mediaFileExists(filename: string): Promise<boolean> {
  try {
    await fs.access(resolveMediaPath(filename));
    return true;
  } catch {
    return false;
  }
}

/**
 * Full sha256 (hex) of a file already on disk, computed server-side — the
 * permanent-dedup key (bloqueador 3) is never taken from client input, only
 * from the actual bytes at rest. The filename's own hash prefix (see
 * lib/scheduled-posts/paths.ts) is only 16 hex chars (64 bits): good enough
 * to make collisions between unrelated uploads astronomically unlikely, but
 * dedup correctness re-hashes the whole file rather than trusting it.
 */
export async function hashMediaFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(resolveMediaPath(filename));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * Delete files by name, best-effort: a file already gone (ENOENT) is not an
 * error — cleanup running twice, or a file the operator removed by hand,
 * must not block the rest of a cron tick.
 */
export async function deleteMediaFiles(filenames: string[]): Promise<void> {
  await Promise.all(
    filenames.map(async (filename) => {
      try {
        await fs.unlink(resolveMediaPath(filename));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    })
  );
}

export interface MediaFileStat {
  filename: string;
  mtimeMs: number;
}

/** All files currently on disk, for the orphan-cleanup sweep. */
export async function listMediaFiles(): Promise<MediaFileStat[]> {
  const dir = getMediaDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const stats = await Promise.all(
    entries
      // Uploads in flight write to a `.tmp-*` name before the atomic rename;
      // never treat one of those as an orphan mid-upload.
      .filter((name) => !name.startsWith(".tmp-"))
      .map(async (filename) => {
        try {
          const stat = await fs.stat(path.join(dir, filename));
          return { filename, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
  );

  return stats.filter((s): s is MediaFileStat => s !== null);
}
