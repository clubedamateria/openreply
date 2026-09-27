/**
 * Comment word/emoji/bigram stats — Unit Tests
 */

import { describe, it, expect } from "vitest";
import {
  analyzeCommentTexts,
  extractEmojis,
  isStopword,
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
