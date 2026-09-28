/**
 * "Is this comment a question the audience is asking us?" — powers the
 * "Perguntas do público" panel on the Comentários page.
 *
 * A literal "?" anywhere in the text is the strong, unambiguous signal and is
 * checked first. Mobile keyboards make people skip the "?" constantly though
 * ("como faço pra comprar"), so the fallback splits the comment into
 * sentences, strips a leading greeting off each one ("Boa tarde, gostaria de
 * saber..." → "gostaria de saber...", "Oiii gente, cadê o link" →
 * "cadê o link"), and checks whether what is left starts with a common
 * interrogative word or phrase.
 *
 * Case/accent-insensitive throughout (foldDiacritics — the same helper the
 * keyword matcher and word-stats use), so "Cadê", "cade" and "CADÊ" all match
 * the same way.
 */

import { foldDiacritics } from "@/lib/utils/keyword-matcher";

// Matched at the start of a (sub)sentence, greediest first so "boa tarde"
// isn't cut short at "boa". Trailing punctuation/whitespace right after the
// greeting is consumed too, so "Oiii, boa tarde! gostaria..." strips cleanly.
const GREETING_PATTERN =
  /^(oi+|ol[aá]|boa\s+tarde|boa\s+noite|bom\s+dia|gente|pessoal)\b[,.!\s]*/;

const INTERROGATIVE_STARTS = [
  "como",
  "qual",
  "quais",
  "quantos?",
  "quantas?",
  "quando",
  "onde",
  "cade",
  "por\\s*que",
  "porque",
  "pq",
  "tem\\s+como",
  "da\\s+pra",
  "serve",
  "funciona",
  "vale\\s+a\\s+pena",
  "e\\s+possivel",
] as const;

const INTERROGATIVE_PATTERN = new RegExp(`^(${INTERROGATIVE_STARTS.join("|")})\\b`);

function normalize(text: string): string {
  return foldDiacritics(text).toLowerCase();
}

/** Strip every leading greeting/filler in a row ("Oiii boa tarde gente, ..."). */
function stripLeadingGreetings(sentence: string): string {
  let result = sentence.trimStart();
  for (;;) {
    const next = result.replace(GREETING_PATTERN, "").trimStart();
    if (next === result) return result;
    result = next;
  }
}

function startsWithInterrogative(sentence: string): boolean {
  return INTERROGATIVE_PATTERN.test(stripLeadingGreetings(sentence));
}

export function isQuestion(text: string): boolean {
  if (!text) return false;
  if (text.includes("?")) return true;

  const normalized = normalize(text);
  const sentences = normalized
    .split(/[.!;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length === 0) return startsWithInterrogative(normalized);
  return sentences.some(startsWithInterrogative);
}
