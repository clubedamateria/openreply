import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { getMediaDir } from "@/lib/env";
import { getMediaPublicUrl } from "@/lib/storage/media";
import { extensionForContentType, mediaFilename } from "@/lib/scheduled-posts/paths";
import { resolveScheduledPostActor } from "@/lib/scheduled-posts/auth";

// Needs real fs/crypto/stream access — must never run on the Edge runtime.
export const runtime = "nodejs";

// The Content Publishing API caps video at far more than this, but the VM
// this runs on has 1GB of RAM total — 200MB is a ceiling on how much a
// single bad/huge upload can cost in disk I/O and time, not a Meta limit.
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * Streams a raw file body straight to `MEDIA_DIR`, never buffering it in
 * memory: `Readable.fromWeb` bridges the request's web stream into a Node
 * stream, a pass-through step hashes and size-checks each chunk as it flies
 * by, and `pipeline` writes it to a temp file. Only once the whole stream
 * lands safely is the temp file renamed to its content-addressed final name
 * (`lib/scheduled-posts/paths.ts`) — a partial/aborted upload never becomes a
 * scheduled-post candidate.
 *
 * Only `video/mp4` and `image/jpeg` are accepted: the Content Publishing API
 * does not take PNG for images, so rejecting it here (with a clear message)
 * is better than a confusing failure hours later when the cron tries to
 * publish it.
 */
export async function POST(request: NextRequest) {
  const actor = await resolveScheduledPostActor(request);
  if (!actor) {
    return NextResponse.json({ success: false, error: "Não autorizado" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type");
  const extension = extensionForContentType(contentType);
  if (!extension) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Tipo de arquivo não aceito. Só video/mp4 e image/jpeg — o Instagram (Content Publishing API) não aceita PNG.",
      },
      { status: 415 }
    );
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { success: false, error: "Arquivo maior que 200MB" },
      { status: 413 }
    );
  }

  if (!request.body) {
    return NextResponse.json({ success: false, error: "Corpo vazio" }, { status: 400 });
  }

  const mediaDir = getMediaDir();
  await mkdir(mediaDir, { recursive: true });
  const tmpPath = path.join(mediaDir, `.tmp-${randomBytes(8).toString("hex")}`);

  const hash = createHash("sha256");
  let size = 0;
  let tooLarge = false;

  const nodeSource = Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>);

  async function* hashAndLimit(source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        tooLarge = true;
        // Stops the pipeline immediately — nothing past this point is written.
        throw new Error("upload-too-large");
      }
      hash.update(chunk);
      yield chunk;
    }
  }

  try {
    await pipeline(nodeSource, hashAndLimit, createWriteStream(tmpPath));
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    if (tooLarge) {
      return NextResponse.json(
        { success: false, error: "Arquivo maior que 200MB" },
        { status: 413 }
      );
    }
    console.error("[Agendados] upload falhou:", err);
    return NextResponse.json(
      { success: false, error: "Falha ao gravar o arquivo" },
      { status: 500 }
    );
  }

  const sha256 = hash.digest("hex");
  const filename = mediaFilename(sha256, extension);
  await rename(tmpPath, path.join(mediaDir, filename));

  return NextResponse.json({
    success: true,
    data: { path: filename, url: getMediaPublicUrl(filename), sha256, size },
  });
}
