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
// this runs on has 1GB of RAM total and a modest upstream connection — 100MB
// already covers a 90s Reel at 1080p, and Rodada 3 (achado 9) lowered this
// from 200MB after a slow upload of a file near that old ceiling was
// observed hitting the reverse proxy's own ~300s timeout (408) before the
// stream ever finished. See docs/setup.md for the operational note.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Enough bytes to see both magic numbers this route cares about: JPEG's
// 3-byte signature (`FF D8 FF`) and MP4's `ftyp` box type, which starts at
// byte offset 4.
const MAGIC_CHECK_BYTES = 12;

/** Rodada 3, achado 8: the declared `content-type` header is just a claim —
 * checking the file's own magic bytes catches a mislabeled upload (by
 * accident or otherwise) before it is ever handed to Meta, where it would
 * fail hours later with a far more confusing error. */
function magicBytesMatch(buf: Buffer, extension: "mp4" | "jpg"): boolean {
  if (extension === "jpg") {
    return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  return buf.length >= 8 && buf.subarray(4, 8).toString("ascii") === "ftyp";
}

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
  const extensionOrNull = extensionForContentType(contentType);
  if (!extensionOrNull) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Tipo de arquivo não aceito. Só video/mp4 e image/jpeg — o Instagram (Content Publishing API) não aceita PNG.",
      },
      { status: 415 }
    );
  }
  // Narrowed to a fresh binding: TS does not carry the null-check above
  // through into the async generator closure below, which references the
  // outer scope rather than being evaluated in place.
  const extension: "mp4" | "jpg" = extensionOrNull;

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { success: false, error: "Arquivo maior que 100MB" },
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
  let magicMismatch = false;
  let magicChecked = false;
  let magicBuffer = Buffer.alloc(0);

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

      if (!magicChecked) {
        magicBuffer = Buffer.concat([magicBuffer, chunk]);
        if (magicBuffer.length >= MAGIC_CHECK_BYTES) {
          magicChecked = true;
          if (!magicBytesMatch(magicBuffer, extension)) {
            magicMismatch = true;
            throw new Error("magic-bytes-mismatch");
          }
        }
      }

      yield chunk;
    }
    if (!magicChecked) {
      // The whole file was smaller than what it takes to even check — too
      // small to be a real video/image either way.
      magicMismatch = true;
      throw new Error("magic-bytes-mismatch");
    }
  }

  try {
    await pipeline(nodeSource, hashAndLimit, createWriteStream(tmpPath));
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    if (tooLarge) {
      return NextResponse.json(
        { success: false, error: "Arquivo maior que 100MB" },
        { status: 413 }
      );
    }
    if (magicMismatch) {
      return NextResponse.json(
        {
          success: false,
          error:
            "O conteúdo do arquivo não bate com o tipo declarado — confira se não é outro formato com a extensão trocada.",
        },
        { status: 415 }
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
