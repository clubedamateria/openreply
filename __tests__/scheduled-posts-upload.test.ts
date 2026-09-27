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

  it("rejects via content-length header before reading the body, when declared over 200MB", async () => {
    const res = await POST(request(Buffer.from("x"), "video/mp4", 201 * 1024 * 1024));
    expect(res.status).toBe(413);
    expect(fs.readdirSync(mediaDir)).toHaveLength(0);
  });

  it("streams a small file to disk, hashes it, and names it by content", async () => {
    const content = Buffer.from("a".repeat(1000));
    const expectedHash = createHash("sha256").update(content).digest("hex");

    const res = await POST(request(content, "video/mp4"));
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
    const res = await POST(request(Buffer.from("fake-jpeg-bytes"), "image/jpeg"));
    const json = await res.json();
    expect(json.data.path).toMatch(/\.jpg$/);
  });

  it("aborts mid-stream and writes nothing when the body exceeds 200MB (no content-length pre-check)", async () => {
    const CHUNK = 10 * 1024 * 1024; // 10MB per chunk
    const chunks = Math.ceil((200 * 1024 * 1024) / CHUNK) + 2; // push past the limit
    let sent = 0;
    const limited = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent >= chunks) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(new Uint8Array(CHUNK));
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
