/**
 * Comment word/emoji/bigram stats — Unit Tests
 */

import { describe, it, expect } from "vitest";
import {
  analyzeCommentTexts,
  extractEmojis,
  isStopword,
  normalizeWord,
  tokenizeWords,
} from "../lib/comments/word-stats";

describe("tokenizeWords", () => {
  it("splits on punctuation and whitespace", () => {
    expect(tokenizeWords("Eu quero o link, por favor!")).toEqual([
      "Eu",
      "quero",
      "o",
      "link",
      "por",
      "favor",
    ]);
  });

  it("removes emojis before tokenizing", () => {
    expect(tokenizeWords("quero 🔥 o link 💪")).toEqual(["quero", "o", "link"]);
  });

  it("keeps accented letters and numbers", () => {
    expect(tokenizeWords("qual o preço da promoção 2?")).toEqual([
      "qual",
      "o",
      "preço",
      "da",
      "promoção",
      "2",
    ]);
  });

  it("returns an empty array for text with only punctuation/emoji", () => {
    expect(tokenizeWords("!! 🔥🔥 ...")).toEqual([]);
  });
});

describe("extractEmojis", () => {
  it("extracts every emoji in order", () => {
    expect(extractEmojis("amei 😍 muito 🔥🔥")).toEqual(["😍", "🔥", "🔥"]);
  });

  it("returns an empty array when there is no emoji", () => {
    expect(extractEmojis("quero o link")).toEqual([]);
  });

  it("joins a ZWJ emoji sequence into a single entry", () => {
    // Family emoji: man + ZWJ + woman + ZWJ + girl.
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    expect(extractEmojis(`amamos ${family}`)).toEqual([family]);
  });
});

describe("isStopword", () => {
  it("recognises common pt-br stopwords regardless of accent/case", () => {
    expect(isStopword("não")).toBe(true);
    expect(isStopword("NAO")).toBe(true);
    expect(isStopword("Você")).toBe(true);
    expect(isStopword("para")).toBe(true);
  });

  it("does not flag content words as stopwords", () => {
    expect(isStopword("link")).toBe(false);
    expect(isStopword("preço")).toBe(false);
    expect(isStopword("quero")).toBe(false);
  });
});

describe("analyzeCommentTexts — words", () => {
  it("counts words and excludes pt-br stopwords", () => {
    const stats = analyzeCommentTexts([
      "eu quero o link",
      "manda o link pra mim",
      "quero o link também",
    ]);

    const labels = stats.topWords.map((w) => w.label);
    expect(labels).toContain("link");
    expect(labels).toContain("quero");
    // Stopwords never make the word list.
    expect(labels).not.toContain("eu");
    expect(labels).not.toContain("o");
    expect(labels).not.toContain("pra");

    const link = stats.topWords.find((w) => w.label === "link");
    expect(link?.count).toBe(3);
  });

  it("groups accented and unaccented spellings under one entry", () => {
    const stats = analyzeCommentTexts(["qual o preço", "qual o preco", "preço??"]);
    const preco = stats.topWords.find((w) =>
      ["preço", "preco"].includes(w.label)
    );
    expect(preco?.count).toBe(3);
  });

  it("displays the most common surface form for a grouped word", () => {
    const stats = analyzeCommentTexts([
      "preço",
      "preço",
      "preco",
    ]);
    const grouped = stats.topWords.find((w) =>
      ["preço", "preco"].includes(w.label)
    );
    expect(grouped?.label).toBe("preço");
    expect(grouped?.count).toBe(3);
  });

  it("is case-insensitive for grouping", () => {
    const stats = analyzeCommentTexts(["LINK", "Link", "link"]);
    expect(stats.topWords).toHaveLength(1);
    expect(stats.topWords[0].count).toBe(3);
  });
});

describe("analyzeCommentTexts — bigrams", () => {
  it("keeps a natural phrase even when one word is a stopword", () => {
    const stats = analyzeCommentTexts(["eu quero o link", "eu quero muito"]);
    const bigrams = stats.topBigrams.map((b) => b.label);
    expect(bigrams).toContain("eu quero");
  });

  it("drops a bigram where both words are stopwords", () => {
    const stats = analyzeCommentTexts(["eu quero de o link"]);
    const bigrams = stats.topBigrams.map((b) => b.label);
    expect(bigrams).not.toContain("de o");
  });

  it("only pairs consecutive tokens within the same comment", () => {
    const stats = analyzeCommentTexts(["quero link", "manda preço"]);
    const bigrams = stats.topBigrams.map((b) => b.label);
    expect(bigrams).not.toContain("link manda");
  });
});

describe("analyzeCommentTexts — emojis", () => {
  it("counts emojis separately from words", () => {
    const stats = analyzeCommentTexts(["quero 🔥", "muito bom 🔥🔥"]);
    expect(stats.topEmojis).toEqual([{ label: "🔥", count: 3 }]);
    expect(stats.topWords.map((w) => w.label)).not.toContain("🔥");
  });
});

describe("analyzeCommentTexts — limit and ordering", () => {
  it("sorts by count descending and respects the limit", () => {
    const stats = analyzeCommentTexts(
      ["link link link", "preço preço", "promoção"],
      2
    );
    expect(stats.topWords).toHaveLength(2);
    expect(stats.topWords[0].label).toBe("link");
    expect(stats.topWords[0].count).toBe(3);
  });

  it("ignores empty comment texts", () => {
    const stats = analyzeCommentTexts(["", "link"]);
    expect(stats.topWords).toEqual([{ label: "link", count: 1 }]);
  });
});

describe("analyzeCommentTexts — repeated-letter collapse", () => {
  it("collapses a letter repeated 3+ times before grouping ('oiii' -> 'oi')", () => {
    const stats = analyzeCommentTexts(["oiii material", "oi material", "oiiiii material"]);
    const material = stats.topWords.find((w) => w.label === "material");
    expect(material?.count).toBe(3);
    // "oi" is a stopword, so none of the three surface forms should show up
    // as a word of its own.
    expect(stats.topWords.map((w) => w.label)).not.toContain("oi");
    expect(stats.topWords.map((w) => w.label)).not.toContain("oiii");
  });

  it("does not touch a normal double letter ('carro', 'certo')", () => {
    const stats = analyzeCommentTexts(["quero o carro certo"]);
    const labels = stats.topWords.map((w) => w.label);
    expect(labels).toContain("carro");
    expect(labels).toContain("certo");
  });

  it("discards a token that collapses down to a single letter ('kkkk' -> 'k')", () => {
    const stats = analyzeCommentTexts(["kkkk amei o material", "material top"]);
    const labels = stats.topWords.map((w) => w.label);
    expect(labels).not.toContain("k");
    expect(labels).not.toContain("kkkk");
    const material = stats.topWords.find((w) => w.label === "material");
    expect(material?.count).toBe(2);
  });

  it("never forms a bigram with a collapsed single-letter token", () => {
    const stats = analyzeCommentTexts(["amei kkkk muito"]);
    const bigrams = stats.topBigrams.map((b) => b.label);
    expect(bigrams.some((b) => b.includes("k"))).toBe(false);
  });
});

describe("analyzeCommentTexts — minCount", () => {
  it("drops words/bigrams/emojis seen fewer times than minCount", () => {
    const stats = analyzeCommentTexts(
      ["material bom", "material", "unico material", "sozinho 🔥"],
      25,
      2
    );
    const labels = stats.topWords.map((w) => w.label);
    expect(labels).toContain("material");
    expect(labels).not.toContain("bom");
    expect(labels).not.toContain("unico");
    expect(stats.topEmojis).toEqual([]);
  });

  it("defaults to minCount 1 (keeps everything) when not given", () => {
    const stats = analyzeCommentTexts(["material unico"]);
    expect(stats.topWords.map((w) => w.label)).toEqual(
      expect.arrayContaining(["material", "unico"])
    );
  });
});

describe("stopwords — greetings and comment filler", () => {
  it("excludes common greetings and their variants from the word list", () => {
    const stats = analyzeCommentTexts(["Oi gente, boa tarde, tudo bem?"]);
    expect(stats.topWords).toEqual([]);
  });

  it("excludes 'gostaria de saber' style filler", () => {
    const stats = analyzeCommentTexts([
      "gostaria de saber qual o preço",
      "queria saber qual o preço",
    ]);
    const labels = stats.topWords.map((w) => w.label);
    expect(labels).not.toContain("gostaria");
    expect(labels).not.toContain("queria");
    expect(labels).not.toContain("saber");
    const preco = stats.topWords.find((w) => ["preço", "preco"].includes(w.label));
    expect(preco?.count).toBe(2);
  });

  it("excludes 'obrigado'/'obrigada'/'gente'/'pessoal'/'rs'", () => {
    expect(isStopword("obrigado")).toBe(true);
    expect(isStopword("obrigada")).toBe(true);
    expect(isStopword("gente")).toBe(true);
    expect(isStopword("pessoal")).toBe(true);
    expect(isStopword("rs")).toBe(true);
  });

  it("never shows 'kkk'/'kkkk' as a word (collapses to the single-letter 'k', discarded)", () => {
    const stats = analyzeCommentTexts(["kkk muito bom o video"]);
    expect(stats.topWords.map((w) => w.label)).not.toContain("kkk");
    expect(stats.topWords.map((w) => w.label)).not.toContain("k");
  });
});

describe("analyzeCommentTexts — excludeKeys (campaign keywords)", () => {
  it("drops a word matching an excluded key", () => {
    const stats = analyzeCommentTexts(
      ["quero clube muito", "quero clube muito"],
      25,
      1,
      new Set(["clube"])
    );
    const labels = stats.topWords.map((w) => w.label);
    expect(labels).not.toContain("clube");
    expect(labels).toContain("quero");
  });

  it("drops a bigram containing an excluded key even when only one side matches", () => {
    const stats = analyzeCommentTexts(
      ["quero clube muito"],
      25,
      1,
      new Set(["clube"])
    );
    const bigrams = stats.topBigrams.map((b) => b.label);
    expect(bigrams.some((b) => b.includes("clube"))).toBe(false);
  });

  it("matches the same normalized key space as normalizeWord (accent/case-insensitive)", () => {
    const stats = analyzeCommentTexts(["Clube", "Clube"], 25, 1, new Set([normalizeWord("Clube")]));
    expect(stats.topWords).toEqual([]);
  });

  it("does not affect words/bigrams when excludeKeys is omitted", () => {
    const stats = analyzeCommentTexts(["quero clube muito", "quero clube muito"]);
    expect(stats.topWords.map((w) => w.label)).toContain("clube");
  });
});
