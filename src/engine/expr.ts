// Tiny arithmetic evaluator for the numeric inputs: a field may hold a plain
// number or a formula ("64*2+8", "(12+4)/2") and is evaluated when committed.
//
// Grammar (precedence low → high):
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | '/' | '%') unary)*
//   unary   := ('+' | '-') unary | pow
//   pow     := primary ('^' unary)?
//   primary := number | '(' expr ')'
//
// Friendly input: full-width and typographic variants (× ÷ − ＋ （ ） ％),
// "x"/"·" as multiplication, spaces and thousands separators are ignored, and a
// trailing "=" is dropped. Anything else — or a non-finite result — returns
// null so the caller can keep the previous value instead of storing garbage.

const CHAR_MAP: Record<string, string> = {
  "\u00d7": "*", x: "*", X: "*", "\u00b7": "*", "\uff0a": "*", "\u2715": "*",
  "\u00f7": "/", "\uff0f": "/", "\u2044": "/",
  "\u2212": "-", "\u2013": "-", "\u2014": "-", "\uff0d": "-", "\ufe63": "-",
  "\uff0b": "+", "\uff08": "(", "\uff09": ")", "\uff05": "%", "\uff3e": "^",
  ",": "", "\uff0c": "", " ": "", "\u00a0": "", "\u3000": "", "\t": "",
};

/** normalise an input string to the ASCII grammar (empty = nothing usable) */
export function normalizeExpr(src: string): string {
  let out = "";
  for (const ch of String(src)) out += CHAR_MAP[ch] ?? ch;
  return out.replace(/=+$/, "").trim();
}

/** evaluate an arithmetic expression; null = not a complete valid formula */
export function evalExpr(src: string): number | null {
  const s = normalizeExpr(src);
  if (!s) return null;
  let i = 0;
  const fail = (): never => { throw new Error("expr"); };
  const eat = (c: string): boolean => { if (s[i] === c) { i++; return true; } return false; };
  const num = (): number => {
    const m = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(s.slice(i));
    if (!m) return fail();
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const primary = (): number => {
    if (eat("(")) {
      const v = expr();
      if (!eat(")")) return fail();
      return v;
    }
    return num();
  };
  const pow = (): number => {
    const base = primary();
    if (eat("^")) return Math.pow(base, unary());
    return base;
  };
  const unary = (): number => {
    if (eat("-")) return -unary();
    if (eat("+")) return unary();
    return pow();
  };
  const term = (): number => {
    let v = unary();
    for (;;) {
      if (eat("*")) v *= unary();
      else if (eat("/")) { const d = unary(); if (d === 0) return fail(); v /= d; }
      else if (eat("%")) { const d = unary(); if (d === 0) return fail(); v %= d; }
      else return v;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) {
      if (eat("+")) v += term();
      else if (eat("-")) v -= term();
      else return v;
    }
  };
  try {
    const v = expr();
    if (i !== s.length) return null; // trailing junk ("12+")
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
