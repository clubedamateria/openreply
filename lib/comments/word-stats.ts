/**
 * Word/emoji/bigram stats for the "what the audience writes" panel.
 *
 * Grouping is accent-insensitive (foldDiacritics from the keyword matcher, the
 * same helper campaigns use to match "preço"/"preco"), but the label shown is
 * whichever surface form (casing + accent) the audience actually typed most.
 * Emojis are counted separately from words, never mixed into either list.
 * Bigrams keep stopwords on ONE side so natural two-word phrases like
 * "eu quero" survive — only a pair where BOTH words are stopwords is dropped.
 */

import { foldDiacritics } from "@/lib/utils/keyword-matcher";
import { STOPWORDS_PT_BR } from "./stopwords";

// `\p{Extended_Pictographic}` covers the emoji repertoire; `️` is the
// emoji-presentation variation selector and `‍` joins sequences like
// multi-person or flag emojis into one visual glyph, which should count once.
const EMOJI_PATTERN =
  /\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*/gu;
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

export interface CountedItem {
  /** Most common surface form the audience typed for this normalized key. */
  label: string;
  count: number;
}

interface Accumulator {
  count: number;
  surfaceForms: Map<string, number>;
}

function normalizeWord(word: string): string {
  return foldDiacritics(word).toLowerCase();
}

/** Every emoji (or joined emoji sequence) found in the text, in order. */
export function extractEmojis(text: string): string[] {
  return text.match(EMOJI_PATTERN) ?? [];
}

function stripEmojis(text: string): string {
  return text.replace(EMOJI_PATTERN, " ");
}

/** Raw word tokens (letters/numbers, any script), emojis and punctuation removed. */
export function tokenizeWords(text: string): string[] {
  return stripEmojis(text).match(WORD_PATTERN) ?? [];
}

export function isStopword(word: string): boolean {
  return STOPWORDS_PT_BR.has(normalizeWord(word));
}

function bump(map: Map<string, Accumulator>, key: string, surface: string): void {
  let acc = map.get(key);
  if (!acc) {
    acc = { count: 0, surfaceForms: new Map() };
    map.set(key, acc);
  }
  acc.count += 1;
  acc.surfaceForms.set(surface, (acc.surfaceForms.get(surface) ?? 0) + 1);
}

function mostCommonSurface(acc: Accumulator): string {
  let bestSurface = "";
  let bestCount = -1;
  for (const [surface, count] of acc.surfaceForms) {
    if (count > bestCount) {
      bestCount = count;
      bestSurface = surface;
    }
  }
  return bestSurface;
}

function toSortedList(map: Map<string, Accumulator>, limit: number): CountedItem[] {
  return [...map.values()]
    .map((acc) => ({ label: mostCommonSurface(acc), count: acc.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export interface CommentTextStats {
  topWords: CountedItem[];
  topBigrams: CountedItem[];
  topEmojis: CountedItem[];
}

/**
 * Tally words, bigrams and emojis across a batch of comment texts.
 *
 * @param limit - how many entries to keep per list (highest count first).
 */
export function analyzeCommentTexts(
  texts: string[],
  limit = 25
): CommentTextStats {
  const wordMap = new Map<string, Accumulator>();
  const bigramMap = new Map<string, Accumulator>();
  const emojiMap = new Map<string, Accumulator>();

  for (const text of texts) {
    if (!text) continue;

    for (const emoji of extractEmojis(text)) {
      bump(emojiMap, emoji, emoji);
    }

    const tokens = tokenizeWords(text);
    const normalized = tokens.map(normalizeWord);

    tokens.forEach((token, i) => {
      const key = normalized[i];
      if (!key || STOPWORDS_PT_BR.has(key)) return;
      bump(wordMap, key, token);
    });

    for (let i = 0; i < tokens.length - 1; i++) {
      const keyA = normalized[i];
      const keyB = normalized[i + 1];
      if (!keyA || !keyB) continue;
      if (STOPWORDS_PT_BR.has(keyA) && STOPWORDS_PT_BR.has(keyB)) continue;
      bump(bigramMap, `${keyA} ${keyB}`, `${tokens[i]} ${tokens[i + 1]}`);
    }
  }

  return {
    topWords: toSortedList(wordMap, limit),
    topBigrams: toSortedList(bigramMap, limit),
    topEmojis: toSortedList(emojiMap, limit),
  };
}
