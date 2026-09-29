/**
 * "Is this comment ONLY a campaign keyword (or that keyword repeated), with
 * nothing else in it?" — used to keep a keyword blast (e.g. 25 people all
 * writing "Clube" to trigger the carousel DM automation) from drowning
 * "Do que o público fala" and "Todos os comentários" under one repeated
 * word.
 *
 * Mentions ("@fulana"), emoji and punctuation are stripped before
 * comparing — none of them count as "something else" in the comment. What
 * is left is split into word tokens and folded (foldDiacritics + lowercase,
 * the exact normalization the campaign keyword matcher itself applies — see
 * `matchKeywords` in lib/utils/keyword-matcher.ts), so a "preço" keyword
 * catches a "PRECO" comment.
 *
 * A comment counts as keyword-only when its entire token sequence is made
 * of one-or-more back-to-back repeats of the SAME keyword's own token
 * sequence: "clube clube" repeats the single-word keyword "clube"; a
 * multi-word keyword like "eu quero" would likewise match "eu quero eu
 * quero". Mixing in any other word ("quero o clube", "Clube, quanto
 * custa?") disqualifies it — and so does an empty comment (nothing but an
 * emoji or a mention, no word at all).
 */

import { foldDiacritics } from "@/lib/utils/keyword-matcher";

const MENTION_PATTERN = /@[\p{L}\p{N}._]+/gu;
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

interface Tokenized {
  /** foldDiacritics + lowercase, for comparison. */
  normalized: string[];
  /** Original casing, for display ("forma mais usada"). */
  original: string[];
}

function tokenize(text: string): Tokenized {
  const withoutMentions = text.replace(MENTION_PATTERN, " ");
  const original = withoutMentions.match(WORD_PATTERN) ?? [];
  return { original, normalized: original.map((word) => foldDiacritics(word).toLowerCase()) };
}

/** `commentTokens` is one-or-more back-to-back repeats of `keywordTokens`. */
function isRepeatedSequence(commentTokens: string[], keywordTokens: string[]): boolean {
  const { length } = keywordTokens;
  if (
    length === 0 ||
    commentTokens.length === 0 ||
    commentTokens.length % length !== 0
  ) {
    return false;
  }
  for (let offset = 0; offset < commentTokens.length; offset += length) {
    for (let i = 0; i < length; i++) {
      if (commentTokens[offset + i] !== keywordTokens[i]) return false;
    }
  }
  return true;
}

export interface KeywordOnlyMatch {
  /** Normalized keyword (fold + lowercase), space-joined for multi-word keywords. */
  keyword: string;
  /** The comment's own words for one repeat of the keyword, original casing. */
  surface: string;
}

/**
 * The first keyword (in array order) this comment is made entirely of.
 * `null` when the comment has any other word in it, or no recognizable word
 * at all.
 */
export function matchKeywordOnly(
  text: string,
  keywords: string[]
): KeywordOnlyMatch | null {
  if (!text) return null;
  const comment = tokenize(text);
  if (comment.normalized.length === 0) return null;

  for (const keyword of keywords) {
    const kw = tokenize(keyword);
    if (kw.normalized.length === 0) continue;
    if (isRepeatedSequence(comment.normalized, kw.normalized)) {
      return {
        keyword: kw.normalized.join(" "),
        surface: comment.original.slice(0, kw.normalized.length).join(" "),
      };
    }
  }
  return null;
}

export function isKeywordOnlyComment(text: string, keywords: string[]): boolean {
  return matchKeywordOnly(text, keywords) !== null;
}
