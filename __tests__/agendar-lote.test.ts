import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseDestinos,
  buildTiktokSettings,
  youtubeTitleFor,
  validateYoutubeInfantilArgOrThrow,
  validateDestinosOrThrow,
  main,
  isMainModule,
  type Args,
  type PostPlan,
} from "../scripts/agendar-lote";

/**
 * Fase 4: `--destinos instagram,tiktok,youtube` on the `agendar-lote` CLI.
 * Pure-function coverage for the flag parsing/validation, plus two
 * integration runs of `main()` itself (dry-run grid, and the per-destination
 * dedup skip) — see docs/2026-09-27-agendados-comentarios.md, "Fase 4".
 */

function args(overrides: Record<string, string | boolean> = {}): Args {
  return overrides;
}

describe("parseDestinos", () => {
  it("defaults to [INSTAGRAM] when --destinos is omitted", () => {
    expect(parseDestinos(args())).toEqual(["INSTAGRAM"]);
  });

  it("parses a comma-separated list, case-insensitively", () => {
    expect(parseDestinos(args({ destinos: "Instagram,TIKTOK,youtube" }))).toEqual([
      "INSTAGRAM",
      "TIKTOK",
      "YOUTUBE",
    ]);
  });

  it("dedupes repeated destinations", () => {
    expect(parseDestinos(args({ destinos: "tiktok,tiktok" }))).toEqual(["TIKTOK"]);
  });

  it("throws on an unknown destination", () => {
    expect(() => parseDestinos(args({ destinos: "facebook" }))).toThrow(/--destinos inválido/);
  });
});

const TIKTOK_INTERACTIONS_SIM = {
  "tiktok-comentarios": "sim",
  "tiktok-dueto": "sim",
  "tiktok-costura": "sim",
} as const;

describe("buildTiktokSettings", () => {
  it("throws when --tiktok-privacidade is missing", () => {
    expect(() =>
      buildTiktokSettings(args({ "tiktok-consentimento": true, ...TIKTOK_INTERACTIONS_SIM }))
    ).toThrow(/--tiktok-privacidade é obrigatório/);
  });

  it("throws when --tiktok-privacidade isn't one of TikTok's own values", () => {
    expect(() =>
      buildTiktokSettings(
        args({ "tiktok-privacidade": "EVERYONE", "tiktok-consentimento": true, ...TIKTOK_INTERACTIONS_SIM })
      )
    ).toThrow(/--tiktok-privacidade/);
  });

  it("throws when --tiktok-consentimento is absent, explaining why", () => {
    expect(() =>
      buildTiktokSettings(args({ "tiktok-privacidade": "PUBLIC_TO_EVERYONE", ...TIKTOK_INTERACTIONS_SIM }))
    ).toThrow(/tiktok-consentimento.*Music Usage Confirmation/);
  });

  it('rodada 5, achado 6: throws when --tiktok-consentimento is exactly "nao" — only the bare flag or "sim" count', () => {
    expect(() =>
      buildTiktokSettings(
        args({
          "tiktok-privacidade": "PUBLIC_TO_EVERYONE",
          "tiktok-consentimento": "nao",
          ...TIKTOK_INTERACTIONS_SIM,
        })
      )
    ).toThrow(/tiktok-consentimento só aceita/);
  });

  it("accepts --tiktok-consentimento as a bare flag", () => {
    const settings = buildTiktokSettings(
      args({ "tiktok-privacidade": "public_to_everyone", "tiktok-consentimento": true, ...TIKTOK_INTERACTIONS_SIM })
    );
    expect(settings.consentGiven).toBe(true);
  });

  it('accepts --tiktok-consentimento exactly "sim"', () => {
    const settings = buildTiktokSettings(
      args({ "tiktok-privacidade": "public_to_everyone", "tiktok-consentimento": "sim", ...TIKTOK_INTERACTIONS_SIM })
    );
    expect(settings.consentGiven).toBe(true);
  });

  it("rodada 5, achado 5: throws when --tiktok-comentarios/--tiktok-dueto/--tiktok-costura are missing — no default allowed", () => {
    expect(() =>
      buildTiktokSettings(args({ "tiktok-privacidade": "PUBLIC_TO_EVERYONE", "tiktok-consentimento": true }))
    ).toThrow(/--tiktok-comentarios é obrigatório/);
  });

  it("builds valid settings from explicit sim/nao flags for every interaction", () => {
    const settings = buildTiktokSettings(
      args({
        "tiktok-privacidade": "public_to_everyone",
        "tiktok-consentimento": true,
        "tiktok-comentarios": "sim",
        "tiktok-dueto": "nao",
        "tiktok-costura": "nao",
      })
    );
    expect(settings).toEqual({
      privacyLevel: "PUBLIC_TO_EVERYONE",
      allowComment: true,
      allowDuet: false,
      allowStitch: false,
      consentGiven: true,
    });
  });
});

describe("isMainModule (rodada 5, achado 11)", () => {
  const REAL_SCRIPT_PATH = path.resolve(process.cwd(), "scripts", "agendar-lote.ts");
  let originalArgv1: string | undefined;

  beforeEach(() => {
    originalArgv1 = process.argv[1];
  });
  afterEach(() => {
    process.argv[1] = originalArgv1 as string;
  });

  it("returns true when argv[1] is the real script path", () => {
    process.argv[1] = REAL_SCRIPT_PATH;
    expect(isMainModule()).toBe(true);
  });

  it("returns true when argv[1] is a SYMLINK to the real script path — the old `import.meta.url === file://${argv[1]}` comparison stayed silent here, since argv[1] is the symlink's own path, never equal to the real module URL Node resolves", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agendar-lote-symlink-"));
    const symlinkPath = path.join(tmpDir, "agendar-lote-link.ts");
    fs.symlinkSync(REAL_SCRIPT_PATH, symlinkPath);
    try {
      process.argv[1] = symlinkPath;
      expect(isMainModule()).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns false for an unrelated path", () => {
    process.argv[1] = "/tmp/not-the-script.ts";
    expect(isMainModule()).toBe(false);
  });

  it("returns false (never throws) when argv[1] doesn't exist on disk at all", () => {
    process.argv[1] = "/tmp/agendar-lote-does-not-exist-xyz.ts";
    expect(isMainModule()).toBe(false);
  });
});

describe("validateYoutubeInfantilArgOrThrow", () => {
  it("throws when --youtube-infantil is missing", () => {
    expect(() => validateYoutubeInfantilArgOrThrow(args())).toThrow(/--youtube-infantil é obrigatório/);
  });

  it("throws on a value other than sim/nao", () => {
    expect(() => validateYoutubeInfantilArgOrThrow(args({ "youtube-infantil": "talvez" }))).toThrow();
  });

  it.each(["sim", "nao"] as const)("accepts %s", (value) => {
    expect(validateYoutubeInfantilArgOrThrow(args({ "youtube-infantil": value }))).toBe(value);
  });
});

describe("youtubeTitleFor", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agendar-lote-yt-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prefers a sibling <nome>-titulo.txt over the caption", () => {
    const mediaPath = path.join(tmpDir, "video1.mp4");
    fs.writeFileSync(mediaPath, "x");
    fs.writeFileSync(path.join(tmpDir, "video1-titulo.txt"), "  Título dedicado do YouTube  \n");

    expect(youtubeTitleFor(mediaPath, "Legenda qualquer")).toBe("Título dedicado do YouTube");
  });

  it("falls back to the caption's first line when no sidecar file exists", () => {
    const mediaPath = path.join(tmpDir, "video2.mp4");
    fs.writeFileSync(mediaPath, "x");

    expect(youtubeTitleFor(mediaPath, "Primeira linha\nSegunda linha")).toBe("Primeira linha");
  });

  it("cuts the fallback title at 100 characters", () => {
    const mediaPath = path.join(tmpDir, "video3.mp4");
    fs.writeFileSync(mediaPath, "x");
    const longCaption = "a".repeat(150);

    expect(youtubeTitleFor(mediaPath, longCaption)).toHaveLength(100);
  });

  it("returns an empty string when there is neither a sidecar file nor a caption", () => {
    const mediaPath = path.join(tmpDir, "video4.mp4");
    fs.writeFileSync(mediaPath, "x");

    expect(youtubeTitleFor(mediaPath, "")).toBe("");
  });
});

describe("validateDestinosOrThrow", () => {
  function plan(overrides: Partial<PostPlan> = {}): PostPlan {
    return {
      conta: "conta1",
      mediaType: "REELS",
      files: ["/tmp/does-not-need-to-exist.mp4"],
      caption: "Legenda",
      scheduledForUtcIso: "2026-10-01T15:00:00.000Z",
      ...overrides,
    };
  }

  it("passes through silently for --destinos instagram (no TikTok/YouTube requirements)", () => {
    expect(() => validateDestinosOrThrow(args(), [plan()], ["INSTAGRAM"])).not.toThrow();
  });

  it("rejects a non-REELS plan when tiktok/youtube is among the destinations", () => {
    expect(() =>
      validateDestinosOrThrow(
        args({ "tiktok-privacidade": "PUBLIC_TO_EVERYONE", "tiktok-consentimento": true }),
        [plan({ mediaType: "IMAGE" })],
        ["TIKTOK"]
      )
    ).toThrow(/só aceitam vídeo/);
  });

  it("aggregates errors from BOTH tiktok and youtube requirements into one thrown message", () => {
    try {
      validateDestinosOrThrow(args(), [plan({ caption: "" })], ["TIKTOK", "YOUTUBE"]);
      expect.unreachable("should have thrown");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/tiktok-privacidade/);
      expect(message).toMatch(/youtube-infantil/);
      expect(message).toMatch(/YouTube precisa de título/);
    }
  });
});

describe("main() — dry-run grid shows every destination, touches neither network nor upload", () => {
  let tmpDir: string;
  let originalArgv: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agendar-lote-dry-"));
    fs.writeFileSync(path.join(tmpDir, "post1.mp4"), "conteudo-1");
    originalArgv = process.argv;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("dry-run must never call fetch"); }));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.argv = originalArgv;
    logSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("prints the grid with both destinations, without uploading or scheduling anything", async () => {
    process.argv = [
      "node",
      "agendar-lote.ts",
      "--pasta",
      tmpDir,
      "--conta",
      "conta1",
      "--inicio",
      "2026-10-01",
      "--horarios",
      "12:00",
      "--destinos",
      "instagram,tiktok",
      "--tiktok-privacidade",
      "PUBLIC_TO_EVERYONE",
      "--tiktok-consentimento",
      "--tiktok-comentarios",
      "sim",
      "--tiktok-dueto",
      "sim",
      "--tiktok-costura",
      "sim",
      "--dry-run",
    ];

    await main();

    const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines.some((l: string) => /destinos: INSTAGRAM, TIKTOK/.test(l))).toBe(true);
    expect(lines.some((l: string) => /\(dry-run\)/.test(l))).toBe(true);
  });

  it("aborts before printing anything when --destinos tiktok is missing --tiktok-consentimento", async () => {
    process.argv = [
      "node",
      "agendar-lote.ts",
      "--pasta",
      tmpDir,
      "--conta",
      "conta1",
      "--inicio",
      "2026-10-01",
      "--horarios",
      "12:00",
      "--destinos",
      "tiktok",
      "--tiktok-privacidade",
      "PUBLIC_TO_EVERYONE",
      "--dry-run",
    ];

    await expect(main()).rejects.toThrow(/tiktok-consentimento/);
  });
});

describe("main() — per-destination dedup skip (Fase 4)", () => {
  let tmpDir: string;
  let originalArgv: string[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agendar-lote-dedup-"));
    fs.writeFileSync(path.join(tmpDir, "post1.mp4"), "conteudo-fixo");
    originalArgv = process.argv;
    vi.stubEnv("PAINEL_URL", "http://painel.test");
    vi.stubEnv("SCHEDULER_API_TOKEN", "tok_123");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.argv = originalArgv;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("skips only the destination that's already scheduled, still schedules the others for the same upload", async () => {
    const localHash = createHash("sha256").update(fs.readFileSync(path.join(tmpDir, "post1.mp4"))).digest("hex");

    const scheduleCalls: { platform?: string }[] = [];
    fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      if (url.includes("/api/scheduled-posts?username=")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            // Already scheduled on INSTAGRAM with this exact content — TIKTOK has nothing yet.
            data: [{ contentHash: [localHash], platform: "INSTAGRAM" }],
          }),
        };
      }
      if (url.endsWith("/api/scheduled-posts/upload")) {
        return { ok: true, json: async () => ({ success: true, data: { path: "stored-post1.mp4" } }) };
      }
      if (url.endsWith("/api/scheduled-posts") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        scheduleCalls.push({ platform: body.platform });
        return { ok: true, json: async () => ({ success: true }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    process.argv = [
      "node",
      "agendar-lote.ts",
      "--pasta",
      tmpDir,
      "--conta",
      "conta1",
      "--inicio",
      "2026-10-01",
      "--horarios",
      "12:00",
      "--destinos",
      "instagram,tiktok",
      "--tiktok-privacidade",
      "PUBLIC_TO_EVERYONE",
      "--tiktok-consentimento",
      "--tiktok-comentarios",
      "sim",
      "--tiktok-dueto",
      "sim",
      "--tiktok-costura",
      "sim",
    ];

    await main();

    // Only one upload for the shared file, regardless of how many
    // destinations actually end up scheduled.
    const uploadCalls = fetchMock.mock.calls.filter((call: unknown[]) =>
      String(call[0]).endsWith("/upload")
    );
    expect(uploadCalls).toHaveLength(1);

    expect(scheduleCalls).toEqual([{ platform: "TIKTOK" }]);
  });
});
