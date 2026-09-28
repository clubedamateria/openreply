/**
 * Word/emoji/bigram stats for the "what the audience writes" panel.
 *
 * Grouping is accent-insensitive (foldDiacritics from the keyword matcher, the
 * same helper campaigns use to match "preço"/"preco"), but the label shown is
 * whichever surface form (casing + accent) the audience actually typed most.
 * Emojis are counted separately from words, never mixed into either list.
 * Bigrams keep stopwords on ONE side so natural two-word phrases like
 * "eu quero" survive — only a pair where BOTH words are stopwords is dropped.
 *
 * Normalization also collapses a letter repeated 3+ times in a row into one
 * ("oiii" → "oi", "kkkk" → "k") before grouping, so keyboard-mashing variants
 * of the same word land in the same bucket instead of splintering the count.
 * Whatever the collapse leaves as a single letter ("kkkk" → "k") is then
 * discarded outright — it is noise, not a word, in either the word list or a
 * bigram.
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

// 3+ of the same letter in a row ("oiii", "kkkk") collapses to one instance.
// Two in a row ("carro", "certo") is normal pt-br spelling and stays intact.
const REPEATED_LETTER_PATTERN = /(.)\1{2,}/gu;

function collapseRepeatedLetters(word: string): string {
  return word.replace(REPEATED_LETTER_PATTERN, "$1");
}

function normalizeWord(word: string): string {
  return collapseRepeatedLetters(foldDiacritics(word).toLowerCase());
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

function toSortedList(
  map: Map<string, Accumulator>,
  limit: number,
  minCount: number
): CountedItem[] {
  return [...map.values()]
    .filter((acc) => acc.count >= minCount)
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
 * @param minCount - drop entries seen fewer than this many times (default 1,
 *   i.e. keep everything). The Comentários page passes 2 here: with only a
 *   handful of comments, a word said once is noise ("Oiii", "de saber"), not
 *   a pattern.
 */
export function analyzeCommentTexts(
  texts: string[],
  limit = 25,
  minCount = 1
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

    // A key that collapsed down to a single letter ("kkkk" → "k") is dropped
    // outright, from both the word list and any bigram it would join —
    // treated the same as punctuation, not as a (very short) word.
    const kept = tokens
      .map((token, i) => ({ token, key: normalized[i] }))
      .filter(({ key }) => key.length > 1);

    kept.forEach(({ token, key }) => {
      if (STOPWORDS_PT_BR.has(key)) return;
      bump(wordMap, key, token);
    });

    for (let i = 0; i < kept.length - 1; i++) {
      const a = kept[i];
      const b = kept[i + 1];
      if (STOPWORDS_PT_BR.has(a.key) && STOPWORDS_PT_BR.has(b.key)) continue;
      bump(bigramMap, `${a.key} ${b.key}`, `${a.token} ${b.token}`);
    }
  }

  return {
    topWords: toSortedList(wordMap, limit, minCount),
    topBigrams: toSortedList(bigramMap, limit, minCount),
    topEmojis: toSortedList(emojiMap, limit, minCount),
  };
}
