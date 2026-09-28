/**
 * "Is this comment a question?" — Unit Tests
 */

import { describe, it, expect } from "vitest";
import { isQuestion } from "../lib/comments/questions";

describe("isQuestion — real comments from the account", () => {
  it("is true for a long comment ending in a literal question mark", () => {
    expect(
      isQuestion(
        "Oiii Boa tarde gostaria de saber qual a diferença do Ingles visual premium Para o app Ingles visual ?"
      )
    ).toBe(true);
  });

  it("is true for a short comment ending in a literal question mark", () => {
    expect(isQuestion("Boa tarde,o material chega em casa?")).toBe(true);
  });

  it("is false for a statement/suggestion with no question mark", () => {
    expect(isQuestion("Seria interessante se o material viesse encadernado")).toBe(false);
  });

  it("is false for plain praise", () => {
    expect(isQuestion("Amei!")).toBe(false);
  });

  it("is true for an interrogative-start comment with no question mark", () => {
    expect(isQuestion("como faço pra comprar")).toBe(true);
  });
});

describe("isQuestion — literal '?' anywhere is always true", () => {
  it("matches regardless of position", () => {
    expect(isQuestion("? isso chega quando")).toBe(true);
    expect(isQuestion("legal, mas quanto custa?")).toBe(true);
  });

  it("is case/accent-insensitive for the interrogative-start check", () => {
    expect(isQuestion("QUAL o preço")).toBe(true);
    expect(isQuestion("Cadê o link")).toBe(true);
    expect(isQuestion("cade o link")).toBe(true);
  });
});

describe("isQuestion — greeting stripped before the interrogative check", () => {
  it("strips a single greeting", () => {
    expect(isQuestion("Oiii cadê o link")).toBe(true);
    expect(isQuestion("Boa tarde onde compro")).toBe(true);
    expect(isQuestion("Bom dia quando chega")).toBe(true);
  });

  it("strips more than one greeting in a row", () => {
    expect(isQuestion("Oiii gente pessoal, quando chega o material")).toBe(true);
  });

  it("does not strip a greeting that isn't followed by an interrogative", () => {
    expect(isQuestion("Oiii bom dia pessoal, feliz por comprar")).toBe(false);
  });
});

describe("isQuestion — other interrogative phrases", () => {
  it("recognizes 'tem como'", () => {
    expect(isQuestion("tem como enviar mais rápido")).toBe(true);
  });

  it("recognizes 'dá pra'/'da pra'", () => {
    expect(isQuestion("dá pra parcelar")).toBe(true);
    expect(isQuestion("da pra pagar no pix")).toBe(true);
  });

  it("recognizes 'vale a pena'", () => {
    expect(isQuestion("vale a pena comprar o pack de bônus")).toBe(true);
  });

  it("recognizes 'é possível'", () => {
    expect(isQuestion("é possível enviar para o exterior")).toBe(true);
  });

  it("recognizes 'por que'/'porque'/'pq'", () => {
    expect(isQuestion("por que demora tanto")).toBe(true);
    expect(isQuestion("porque nao chegou ainda")).toBe(true);
    expect(isQuestion("pq nao recebi o link")).toBe(true);
  });

  it("recognizes 'serve'/'funciona'", () => {
    expect(isQuestion("serve para iphone")).toBe(true);
    expect(isQuestion("funciona offline")).toBe(true);
  });
});

describe("isQuestion — edge cases", () => {
  it("is false for an empty string", () => {
    expect(isQuestion("")).toBe(false);
  });

  it("checks every sentence, not only the first", () => {
    expect(isQuestion("Amei o conteudo. Como faço para comprar")).toBe(true);
  });

  it("is false when no sentence starts with an interrogative", () => {
    expect(isQuestion("Muito bom o material. Recomendo demais")).toBe(false);
  });
});
