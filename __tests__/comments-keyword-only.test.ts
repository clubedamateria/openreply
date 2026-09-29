/**
 * "Is this comment ONLY a campaign keyword?" — Unit Tests
 */

import { describe, it, expect } from "vitest";
import { isKeywordOnlyComment, matchKeywordOnly } from "../lib/comments/keyword-only";

const KEYWORDS = ["Clube"];

describe("isKeywordOnlyComment — real cases from the account", () => {
  it("is true for the keyword alone with punctuation", () => {
    expect(isKeywordOnlyComment("Clube!", KEYWORDS)).toBe(true);
  });

  it("is true for the keyword alone with an emoji", () => {
    expect(isKeywordOnlyComment("CLUBE 🙏", KEYWORDS)).toBe(true);
  });

  it("is true for the keyword alone with a mention", () => {
    expect(isKeywordOnlyComment("@fulana clube", KEYWORDS)).toBe(true);
  });

  it("is true for the keyword repeated", () => {
    expect(isKeywordOnlyComment("clube clube", KEYWORDS)).toBe(true);
  });

  it("is false when the keyword is followed by a real question", () => {
    expect(isKeywordOnlyComment("Clube, quanto custa?", KEYWORDS)).toBe(false);
  });

  it("is false when the keyword is part of a longer sentence", () => {
    expect(isKeywordOnlyComment("quero o clube", KEYWORDS)).toBe(false);
  });
});

describe("isKeywordOnlyComment — normalization", () => {
  it("is case/accent-insensitive, matching the campaign matcher's own folding", () => {
    expect(isKeywordOnlyComment("PRECO", ["preço"])).toBe(true);
    expect(isKeywordOnlyComment("preço", ["PRECO"])).toBe(true);
  });

  it("matches a multi-word keyword repeated", () => {
    expect(isKeywordOnlyComment("eu quero eu quero", ["eu quero"])).toBe(true);
  });

  it("does not match a multi-word keyword mixed with something else", () => {
    expect(isKeywordOnlyComment("eu quero muito", ["eu quero"])).toBe(false);
  });
});

describe("isKeywordOnlyComment — edge cases", () => {
  it("is false for an empty comment", () => {
    expect(isKeywordOnlyComment("", KEYWORDS)).toBe(false);
  });

  it("is false when there is no recognizable word at all (only emoji/mention)", () => {
    expect(isKeywordOnlyComment("🙏", KEYWORDS)).toBe(false);
    expect(isKeywordOnlyComment("@fulana", KEYWORDS)).toBe(false);
  });

  it("is false with no keywords configured", () => {
    expect(isKeywordOnlyComment("clube", [])).toBe(false);
  });

  it("tries every keyword, matching the first one that fits", () => {
    expect(isKeywordOnlyComment("link", ["clube", "link"])).toBe(true);
  });
});

describe("matchKeywordOnly", () => {
  it("returns the normalized keyword and the surface form actually typed", () => {
    expect(matchKeywordOnly("CLUBE 🙏", KEYWORDS)).toEqual({
      keyword: "clube",
      surface: "CLUBE",
    });
  });

  it("returns null when the comment is not keyword-only", () => {
    expect(matchKeywordOnly("quero o clube", KEYWORDS)).toBeNull();
  });

  it("returns the surface of just the first repeat when the keyword repeats", () => {
    expect(matchKeywordOnly("Clube CLUBE", KEYWORDS)).toEqual({
      keyword: "clube",
      surface: "Clube",
    });
  });
});
