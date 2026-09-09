import { eq, ok } from "./common";
import { evalExpr, normalizeExpr } from "../src/engine/expr";

export function testExpr(): void {
  // plain numbers pass straight through
  eq("expr.plain", evalExpr("12"), 12);
  eq("expr.zero", evalExpr("0"), 0);
  eq("expr.lead-dot", evalExpr(".5"), 0.5);
  eq("expr.decimal", evalExpr("12.25"), 12.25);

  // precedence + parentheses
  eq("expr.prec", evalExpr("12+3*2"), 18);
  eq("expr.paren", evalExpr("(12+3)*2"), 30);
  eq("expr.nested", evalExpr("((2+3)*4)-1"), 19);
  eq("expr.pow", evalExpr("2^3"), 8);
  eq("expr.pow-right", evalExpr("2^3^2"), 512);
  eq("expr.pow-unary", evalExpr("-2^2"), -4);

  // unary signs and left-to-right chains
  eq("expr.unary", evalExpr("-5+10"), 5);
  eq("expr.unary-plus", evalExpr("+7"), 7);
  eq("expr.chain-sub", evalExpr("10-2-3"), 5);
  eq("expr.chain-div", evalExpr("100/4/5"), 5);
  eq("expr.mod", evalExpr("100%7"), 2);

  // friendly operators / separators
  eq("expr.times", evalExpr("12\u00d73"), 36);
  eq("expr.x-times", evalExpr("12x3"), 36);
  eq("expr.divide", evalExpr("12\u00f74"), 3);
  eq("expr.minus", evalExpr("9\u22125"), 4);
  eq("expr.comma", evalExpr("1,024"), 1024);
  eq("expr.spaces", evalExpr(" 64 \u00d7 2 + 8 "), 136);
  eq("expr.trailing-eq", evalExpr("(6+6)= "), 12);
  eq("expr.norm-fullwidth", normalizeExpr("\uff082\uff0b3\uff09"), "(2+3)");

  // anything incomplete or impossible is rejected
  eq("expr.empty", evalExpr(""), null);
  eq("expr.blank", evalExpr("   "), null);
  eq("expr.trailing-op", evalExpr("12+"), null);
  eq("expr.op-only", evalExpr("+"), null);
  eq("expr.unclosed", evalExpr("(12+3"), null);
  eq("expr.extra-close", evalExpr("12+3)"), null);
  eq("expr.letters", evalExpr("12*abc"), null);
  eq("expr.div-zero", evalExpr("1/0"), null);
  eq("expr.mod-zero", evalExpr("1%0"), null);
  eq("expr.letters-tail", evalExpr("1e309"), null);
  ok("expr.mixed", evalExpr("(1+2)*(3+4)") === 21);
}
