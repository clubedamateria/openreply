import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let mediaDir: string;

vi.mock("@/lib/env", () => ({
  getMediaDir: () => mediaDir,
  getMediaPublicBaseUrl: () => "http://test.local/media",
}));

const mockResolveActor = vi.fn(
  async (): Promise<{ source: "LOTE" } | null> => ({ source: "LOTE" })
);
vi.mock("@/lib/scheduled-posts/auth", () => ({
  resolveScheduledPostActor: mockResolveActor,
}));

const { POST } = await import("../app/api/scheduled-posts/upload/route");

function request(body: BodyInit, contentType: string | null, contentLength?: number) {
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = contentType;
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  return new NextRequest("http://localhost/api/scheduled-posts/upload", {
    method: "POST",
    headers,
    body,
  });
}

beforeEach(() => {
  mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "agendados-upload-test-"));
  mockResolveActor.mockResolvedValue({ source: "LOTE" });
});

afterEach(() => {
  fs.rmSync(mediaDir, { recursive: true, force: true });
});

describe("POST /api/scheduled-posts/upload", () => {
  it("rejects when the caller isn't authorized", async () => {
    mockResolveActor.mockResolvedValue(null);
    const res = await POST(request(Buffer.from("x"), "video/mp4"));
    expect(res.status).toBe(401);
  });

  it("rejects an unsupported content-type (PNG) with a clear message", async () => {
    const res = await POST(request(Buffer.from("x"), "image/png"));
    expect(res.status).toBe(415);
    const json = await res.json();
    expect(json.error).toMatch(/PNG/);
  });

  it("rejects a missing content-type", async () => {
    const res = await POST(request(Buffer.from("x"), null));
    expect(res.status).toBe(415);
  });

  it("rejects via content-length header before reading the body, when declared over 100MB", async () => {
    const res = await POST(mp4Request(Buffer.from("x"), 101 * 1024 * 1024));
    expect(res.status).toBe(413);
    expect(fs.readdirSync(mediaDir)).toHaveLength(0);
  });

  // A real MP4 starts with a `ftyp` box at byte offset 4 — the exact bytes
  // before/after don't matter for the magic-bytes check, only that offset.
  const FAKE_MP4_HEADER = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const FAKE_JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  function mp4Request(body: BodyInit, contentLength?: number) {
    return request(body, "video/mp4", contentLength);
  }

  it("streams a small file to disk, hashes it, and names it by content", async () => {
    const content = Buffer.concat([FAKE_MP4_HEADER, Buffer.from("a".repeat(1000))]);
    const expectedHash = createHash("sha256").update(content).digest("hex");

    const res = await POST(mp4Request(content));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.sha256).toBe(expectedHash);
    expect(json.data.size).toBe(content.length);
    expect(json.data.path).toMatch(/^[a-f0-9]{16}-[A-Za-z0-9_-]{6,}\.mp4$/);
    expect(json.data.path.startsWith(expectedHash.slice(0, 16))).toBe(true);
    expect(json.data.url).toBe(`http://test.local/media/${json.data.path}`);

    const onDisk = fs.readdirSync(mediaDir);
    expect(onDisk).toEqual([json.data.path]);
    expect(fs.readFileSync(path.join(mediaDir, json.data.path))).toEqual(content);
  });

  it("names a JPEG upload with the .jpg extension", async () => {
    const res = await POST(
      request(Buffer.concat([FAKE_JPEG_HEADER, Buffer.from("fake-jpeg-bytes")]), "image/jpeg")
    );
    const json = await res.json();
    expect(json.data.path).toMatch(/\.jpg$/);
  });

  it("Rodada 3, achado 8: rejects an mp4 upload whose bytes don't start with a real ftyp box", async () => {
    const res = await POST(mp4Request(Buffer.from("not-actually-an-mp4-".repeat(5))));
    expect(res.status).toBe(415);
    expect(fs.readdirSync(mediaDir)).toHaveLength(0);
  });

  it("Rodada 3, achado 8: rejects a jpeg upload whose bytes don't start with FF D8 FF", async () => {
    const res = await POST(request(Buffer.from("not-actually-a-jpeg-"), "image/jpeg"));
    expect(res.status).toBe(415);
    expect(fs.readdirSync(mediaDir)).toHaveLength(0);
  });

  it("Rodada 3, achado 8: rejects a file too short to even check the magic bytes", async () => {
    const res = await POST(mp4Request(Buffer.from("hi")));
    expect(res.status).toBe(415);
    expect(fs.readdirSync(mediaDir)).toHaveLength(0);
  });

  it("aborts mid-stream and writes nothing when the body exceeds 100MB (no content-length pre-check)", async () => {
    const CHUNK = 10 * 1024 * 1024; // 10MB per chunk
    const chunks = Math.ceil((100 * 1024 * 1024) / CHUNK) + 2; // push past the limit
    let sent = 0;
    const limited = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent >= chunks) {
          controller.close();
          return;
        }
        sent += 1;
        // The first chunk carries a valid ftyp header so this test exercises
        // the SIZE limit specifically, not the (separately tested) magic
        // bytes check.
        const chunk = new Uint8Array(CHUNK);
        if (sent === 1) chunk.set(FAKE_MP4_HEADER);
        controller.enqueue(chunk);
      },
    });

    const res = await POST(
      new NextRequest("http://localhost/api/scheduled-posts/upload", {
        method: "POST",
        headers: { "content-type": "video/mp4" },
        duplex: "half",
        body: limited,
      })
    );

    expect(res.status).toBe(413);
    // No .tmp-* or final file should be left behind.
    expect(fs.readdirSync(mediaDir)).toHaveLength(0);
  }, 20_000);
});
