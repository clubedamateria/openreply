/**
 * Portuguese (Brazil) stopwords for the "most written words" comment stat.
 *
 * Own list, no dependency: articles, prepositions (plus their contractions
 * with articles), conjunctions, pronouns, common ser/estar/ter/haver forms,
 * frequent adverbs, and Instagram-comment abbreviations (pra, vc, tb...).
 *
 * Written here WITH accents for readability; normalized (folded + lowercase)
 * once at module load into the exported Set, so lookups compare against the
 * same normalized form the tokenizer produces.
 */

import { foldDiacritics } from "@/lib/utils/keyword-matcher";

const RAW_STOPWORDS_PT_BR = [
  // Artigos
  "o", "a", "os", "as", "um", "uma", "uns", "umas",
  // Preposições
  "de", "em", "para", "por", "com", "sem", "sob", "sobre", "entre", "até",
  "após", "ante", "desde", "contra", "perante", "trás", "per",
  // Contrações preposição + artigo/pronome
  "do", "da", "dos", "das", "no", "na", "nos", "nas", "ao", "aos", "à", "às",
  "pelo", "pela", "pelos", "pelas", "num", "numa", "nuns", "numas",
  "dum", "duma", "duns", "dumas", "dele", "dela", "deles", "delas",
  "nesse", "nessa", "nesses", "nessas", "nisso", "neste", "nesta", "nestes",
  "nestas", "nisto", "naquele", "naquela", "naqueles", "naquelas", "naquilo",
  // Conjunções
  "e", "ou", "mas", "porém", "contudo", "todavia", "entretanto", "que", "se",
  "como", "quando", "porque", "pois", "portanto", "logo", "então", "nem",
  "tampouco", "senão", "caso", "embora", "conforme",
  // Pronomes pessoais, possessivos, demonstrativos, relativos
  "eu", "tu", "ele", "ela", "nós", "vós", "eles", "elas", "me", "mim",
  "minha", "meu", "meus", "minhas", "te", "ti", "tua", "teu", "teus", "tuas",
  "si", "consigo", "conosco", "vos", "convosco", "lhe", "lhes", "seu", "sua",
  "seus", "suas", "este", "esta", "estes", "estas", "esse", "essa", "esses",
  "essas", "aquele", "aquela", "aqueles", "aquelas", "isto", "isso", "aquilo",
  "quem", "qual", "quais", "cujo", "cuja", "cujos", "cujas", "nosso", "nossa",
  "nossos", "nossas", "outro", "outra", "outros", "outras", "mesmo", "mesma",
  "mesmos", "mesmas",
  // Ser / estar / ter / haver (formas comuns)
  "é", "são", "foi", "foram", "ser", "sendo", "sido", "está", "estão",
  "estava", "estavam", "estive", "esteve", "estivemos", "estou", "sou",
  "era", "eram", "seja", "sejam", "tem", "tém", "tinha", "tinham", "tenho",
  "temos", "têm", "ter", "tendo", "tido", "há", "havia", "hei", "houve",
  // Advérbios e partículas frequentes
  "não", "sim", "muito", "muita", "muitos", "muitas", "mais", "menos",
  "também", "já", "ainda", "sempre", "nunca", "aqui", "ali", "lá", "aí",
  "assim", "tão", "bem", "mal", "só", "apenas", "quase", "talvez", "onde",
  "todo", "toda", "todos", "todas", "cada", "algum", "alguma", "alguns",
  "algumas", "nenhum", "nenhuma", "nada", "tudo", "alguém", "ninguém",
  // Abreviações e gírias comuns em comentários do Instagram
  "pra", "pro", "pq", "né", "ne", "tá", "ta", "vc", "vcs", "voce", "voces",
  "você", "vocês", "tb", "tbm", "obg", "blz", "q",
];

export const STOPWORDS_PT_BR: ReadonlySet<string> = new Set(
  RAW_STOPWORDS_PT_BR.map((word) => foldDiacritics(word).toLowerCase())
);

export function isStopwordPtBr(normalizedWord: string): boolean {
  return STOPWORDS_PT_BR.has(normalizedWord);
}
