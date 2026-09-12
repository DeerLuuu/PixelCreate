// 图案笔刷：内置图案、取样平铺、从像素抓图案、以及笔画里的落笔规则。
import { Session } from "../src/app/session";
import { Doc } from "../src/engine/doc";
import { Stroke } from "../src/tools/stroke";
import { History } from "../src/engine/history";
import { BUILTIN_PATTERNS, PATTERN_MAX, patternBytes, patternColorAt, patternFromBytes, type PatternDef } from "../src/data/patterns";
import { eq, ok } from "./common";

export function testPatterns(): void {
  // ---- 内置图案 ----
  {
    ok("pattern.builtin.count", BUILTIN_PATTERNS.length >= 6, String(BUILTIN_PATTERNS.length));
    for (const p of BUILTIN_PATTERNS) {
      const b = patternBytes(p);
      ok("pattern.builtin.bytes." + p.id, !!b && b.length === p.w * p.h * 4, p.id);
      ok("pattern.builtin.tint." + p.id, p.tint === true && p.builtin === true, p.id);
      ok("pattern.builtin.fits." + p.id, p.w <= PATTERN_MAX && p.h <= PATTERN_MAX, p.id);
    }
    // 坏数据不该崩：长度不对 / 尺寸超限都返回 null
    const bad: PatternDef = { id: "x", name: "x", w: 4, h: 4, data: "AAAA" };
    eq("pattern.bytes.bad-length", patternBytes(bad), null);
    const huge: PatternDef = { id: "y", name: "y", w: PATTERN_MAX + 1, h: 1, data: "" };
    eq("pattern.bytes.too-large", patternBytes(huge), null);
  }

  // ---- 取样：按画布坐标取模平铺 ----
  {
    const checker = BUILTIN_PATTERNS.find((p) => p.id === "checker")!;
    const b = patternBytes(checker)!;
    const at = (x: number, y: number): boolean => patternColorAt(b, checker.w, checker.h, x, y) !== null;
    eq("pattern.tile.0-0", at(0, 0), true);
    eq("pattern.tile.1-0", at(1, 0), false);
    eq("pattern.tile.0-1", at(0, 1), false);
    eq("pattern.tile.1-1", at(1, 1), true);
    // 平铺：+8 一圈结果一样；负数坐标也要落到同一格
    eq("pattern.tile.wrap-x", at(8, 0), at(0, 0));
    eq("pattern.tile.wrap-y", at(0, 8), at(0, 0));
    eq("pattern.tile.negative", at(-8, -8), at(0, 0));
    eq("pattern.tile.negative-odd", at(-7, 0), at(1, 0));
  }

  // ---- 从一块像素抓图案：裁掉四周透明 ----
  {
    const w = 4, h = 4;
    const src = new Uint8ClampedArray(w * h * 4);
    const put = (x: number, y: number, r: number, g: number, bl: number): void => {
      const p = (y * w + x) * 4;
      src[p] = r; src[p + 1] = g; src[p + 2] = bl; src[p + 3] = 255;
    };
    put(1, 1, 10, 20, 30);
    put(2, 1, 40, 50, 60);
    const got = patternFromBytes(src, w, h);
    ok("pattern.from-bytes", !!got);
    eq("pattern.from-bytes.size", [got!.w, got!.h], [2, 1]);
    eq("pattern.from-bytes.px0", [got!.bytes[0], got!.bytes[1], got!.bytes[2], got!.bytes[3]], [10, 20, 30, 255]);
    eq("pattern.from-bytes.px1", [got!.bytes[4], got!.bytes[5], got!.bytes[6], got!.bytes[7]], [40, 50, 60, 255]);
    // 全透明：没有图案可抓
    eq("pattern.from-bytes.empty", patternFromBytes(new Uint8ClampedArray(w * h * 4), w, h), null);
    // 超限：直接拒绝
    const wide = new Uint8ClampedArray((PATTERN_MAX + 1) * 4);
    for (let i = 3; i < wide.length; i += 4) wide[i] = 255;
    eq("pattern.from-bytes.too-wide", patternFromBytes(wide, PATTERN_MAX + 1, 1, false), null);
  }

  // ---- 会话：图案库 / 选择 / 从选区与画布抓 ----
  {
    (globalThis as unknown as { localStorage: { clear(): void } }).localStorage.clear();
    const s = new Session();
    ok("pattern.session.builtin-first", s.patternDefs().length >= BUILTIN_PATTERNS.length);
    eq("pattern.session.none-active", s.activePattern(), null);
    s.setPattern("checker");
    eq("pattern.session.active", s.activePattern()?.id, "checker");
    ok("pattern.session.brush-data", !!s.brushPatternData() && s.brushPatternData()!.w === 8);
    s.setPattern(null);
    eq("pattern.session.off", s.brushPatternData(), null);
    // 坏 id 不会选中
    s.setPattern("nope");
    eq("pattern.session.bad-id", s.activePattern(), null);

    // 画布抓图案：画一个 2x2 的方块
    const cel = s.doc.ensureCel(0, 0);
    for (const [x, y] of [[3, 3], [4, 3], [3, 4], [4, 4]]) {
      const p = cel.idx(x, y);
      cel.data[p] = 200; cel.data[p + 1] = 100; cel.data[p + 2] = 50; cel.data[p + 3] = 255;
    }
    eq("pattern.session.from-canvas", s.patternFromCanvas(), "ok");
    const made = s.activePattern();
    ok("pattern.session.from-canvas-size", !!made && made.w === 2 && made.h === 2, made ? made.w + "x" + made.h : "null");
    ok("pattern.session.from-canvas-named", !!made && made.name.length > 0);
    // 空画布
    const emptySession = new Session();
    eq("pattern.session.from-canvas-empty", emptySession.patternFromCanvas(), "empty");
    // 没有选区时给明确结果
    eq("pattern.session.from-sel-nosel", s.patternFromSelection(), "nosel");
    // 用户图案可以删；内置图案删不掉
    ok("pattern.session.remove-user", s.removePattern(made!.id) === true);
    eq("pattern.session.remove-builtin", s.removePattern("checker"), false);
    eq("pattern.session.removed-clears-active", s.activePattern(), null);
  }

  // ---- 笔画：图案笔刷只落在图案点上，tint 用画笔色；橡皮不吃图案 ----
  {
    const hist = new History();
    const doc = new Doc(8, 8, "P");
    const checker = BUILTIN_PATTERNS.find((p) => p.id === "checker")!;
    const data = patternBytes(checker)!;
    const brush = {
      color: [255, 0, 0, 255] as [number, number, number, number],
      size: 1, alpha: 255, pressure: 1,
      pattern: { w: checker.w, h: checker.h, bytes: data, tint: true },
    };
    const st = new Stroke(doc, 0, 0, "pencil", brush, false, "off");
    st.startAt(0, 0);
    st.moveTo(1, 1, 1);          // 再点一格：棋盘上 (1,1) 也是"落笔"格
    st.commit(hist, "pattern");
    const cel = doc.celAt(0, 0)!;
    const alphaAt = (x: number, y: number): number => cel.data[cel.idx(x, y) + 3];
    // 棋盘：(0,0)(1,1) 上色，(1,0)(0,1) 留白
    eq("pattern.stroke.on", [alphaAt(0, 0), alphaAt(1, 1)], [255, 255]);
    eq("pattern.stroke.off", [alphaAt(1, 0), alphaAt(0, 1)], [0, 0]);
    eq("pattern.stroke.tint-colour", [cel.data[cel.idx(0, 0)], cel.data[cel.idx(0, 0) + 1]], [255, 0]);

    // 橡皮配了图案也照常整片擦：图案只影响「上色」，不影响「擦除」
    const doc2 = new Doc(8, 8, "Q");
    const cel2 = doc2.ensureCel(0, 0);
    for (let i = 0; i < cel2.data.length; i += 4) { cel2.data[i + 3] = 255; }
    const er = new Stroke(doc2, 0, 0, "eraser", { ...brush, color: [0, 0, 0, 0] }, false, "off");
    // 横着擦两格：(0,0) 是棋盘"落笔"格、(1,0) 是"留白"格——照图案只擦会漏掉后者，
    // 现在要求两个都被擦掉
    er.startAt(0, 0);
    er.moveTo(1, 0, 1);
    er.commit(new History(), "pattern-erase");
    const a2 = (x: number, y: number): number => cel2.data[cel2.idx(x, y) + 3];
    eq("pattern.erase.touched", [a2(0, 0), a2(1, 0)], [0, 0]);
    eq("pattern.erase.untouched", [a2(0, 1), a2(2, 0)], [255, 255]);
  }
}
