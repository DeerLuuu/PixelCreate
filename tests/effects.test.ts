import { Cel } from "../src/engine/cel";
import { blurCel, outlineCel, inlineCel, dropShadowCel } from "../src/engine/effects";
import { eq, ok } from "./common";

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

function mk(w: number, h: number, pts: Array<[number, number]>, c: [number, number, number, number] = RED): Cel {
  const cel = new Cel(w, h);
  for (const [x, y] of pts) {
    const i = cel.idx(x, y);
    cel.data[i] = c[0]; cel.data[i + 1] = c[1]; cel.data[i + 2] = c[2]; cel.data[i + 3] = c[3];
  }
  return cel;
}
function at(c: Cel, x: number, y: number): number[] {
  const i = c.idx(x, y);
  return [c.data[i], c.data[i + 1], c.data[i + 2], c.data[i + 3]];
}
function alphaSum(c: Cel): number {
  let s = 0;
  for (let i = 3; i < c.data.length; i += 4) s += c.data[i];
  return s;
}
function countAlpha(c: Cel): number {
  let n = 0;
  for (let i = 3; i < c.data.length; i += 4) if (c.data[i] > 0) n++;
  return n;
}

export function testEffects(): void {
  // ---------------------------------------------------------------- blur
  {
    // radius 0 (and negative) is a no-op
    const a = mk(5, 5, [[2, 2]]);
    const keep = a.data.join();
    blurCel(a.data, 5, 5, 0);
    eq("blur.radius-0-noop", a.data.join(), keep);
    blurCel(a.data, 5, 5, -3);
    eq("blur.radius-negative-noop", a.data.join(), keep);

    // an empty cel stays empty
    const e = mk(6, 6, []);
    blurCel(e.data, 6, 6, 3);
    eq("blur.empty-stays-empty", countAlpha(e), 0);

    // a uniform opaque cel is unchanged
    const u = mk(4, 4, [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1],
      [0, 2], [1, 2], [2, 2], [3, 2], [0, 3], [1, 3], [2, 3], [3, 3]]);
    blurCel(u.data, 4, 4, 2);
    eq("blur.uniform-unchanged", at(u, 1, 1), RED);

    // a single speck spreads outwards, far from any edge -> mass is conserved
    // (up to the per-pixel rounding of the final unpremultiply)
    const s = mk(15, 15, [[7, 7]]);
    const before = alphaSum(s);
    blurCel(s.data, 15, 15, 1);
    ok("blur.mass-conserved", Math.abs(alphaSum(s) - before) <= 8, "delta=" + (alphaSum(s) - before));
    ok("blur.spreads", countAlpha(s) > 1, "only " + countAlpha(s) + " pixel(s)");
    ok("blur.softens-centre", at(s, 7, 7)[3] < 255 && at(s, 7, 7)[3] > 0, "centre=" + at(s, 7, 7)[3]);
    ok("blur.neighbour-gains", at(s, 8, 7)[3] > 0);
    // premultiplied: the halo of a pure red speck stays pure red (never black)
    let coloured = 0;
    let wrong = 0;
    for (let y = 0; y < 15; y++) {
      for (let x = 0; x < 15; x++) {
        const p = at(s, x, y);
        if (p[3] === 0) continue;
        coloured++;
        if (p[0] !== 255 || p[1] !== 0 || p[2] !== 0) wrong++;
      }
    }
    eq("blur.no-dark-halo", wrong, 0);
    ok("blur.halo-count", coloured > 10, "coloured=" + coloured);
  }

  // ------------------------------------------------------- outline styles
  {
    // outside: the ring around the silhouette is painted, the shape is kept
    const o = mk(5, 5, [[2, 2]]);
    outlineCel(o.data, 5, 5, 1, BLUE, "outside");
    eq("outline.outside.centre-kept", at(o, 2, 2), RED);
    eq("outline.outside.ring", [at(o, 1, 1), at(o, 3, 3), at(o, 2, 1)], [BLUE, BLUE, BLUE]);
    eq("outline.outside.count", countAlpha(o), 9);

    // inside: the size never changes, only the edge band is recoloured
    const i = mk(3, 3, [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]]);
    outlineCel(i.data, 3, 3, 1, BLUE, "inside");
    eq("outline.inside.count", countAlpha(i), 9);
    eq("outline.inside.middle-kept", at(i, 1, 1), RED);
    eq("outline.inside.edge", [at(i, 0, 0), at(i, 2, 2), at(i, 1, 0)], [BLUE, BLUE, BLUE]);

    // center, width 2: one pixel outside + one inside
    const c = mk(5, 5, [[1, 1], [2, 1], [1, 2], [2, 2]]);
    outlineCel(c.data, 5, 5, 2, BLUE, "center");
    eq("outline.center.outside-px", at(c, 0, 0), BLUE);
    eq("outline.center.inside-px", at(c, 1, 1), BLUE);
    eq("outline.center.shape-kept", at(c, 2, 2), BLUE);

    // a 1px inside outline on a single pixel keeps it opaque (no hole)
    const tiny = mk(3, 3, [[1, 1]]);
    outlineCel(tiny.data, 3, 3, 1, BLUE, "inside");
    eq("outline.inside.tiny", [at(tiny, 1, 1), countAlpha(tiny)], [BLUE, 1]);

    // width < 1 does nothing at all
    const z = mk(3, 3, [[1, 1]]);
    const zs = z.data.join();
    outlineCel(z.data, 3, 3, 0, BLUE, "outside");
    eq("outline.width-0-noop", z.data.join(), zs);
  }

  // ------------------------------------------- 内描边（inline：保住最外圈）
  {
    // 5x5 实心块：最外圈保留原色，往里一圈上色，中心不动
    const block = (sz = 5) => {
      const pts: Array<[number, number]> = [];
      for (let y = 0; y < sz; y++) for (let x = 0; x < sz; x++) pts.push([x, y]);
      return mk(sz, sz, pts);
    };
    const b = block();
    inlineCel(b.data, 5, 5, 1, BLUE);
    eq("inline.outer-ring-kept", [at(b, 0, 0), at(b, 0, 2), at(b, 4, 4)], [RED, RED, RED]);
    eq("inline.inner-ring-painted", [at(b, 1, 1), at(b, 1, 2), at(b, 3, 3)], [BLUE, BLUE, BLUE]);
    eq("inline.centre-kept", at(b, 2, 2), RED);

    // 宽度 2：往里两圈都上色（5x5 里第 3 圈就是正中心），最外圈仍是原色
    const b2 = block();
    inlineCel(b2.data, 5, 5, 2, BLUE);
    eq("inline.width2", [at(b2, 1, 1), at(b2, 2, 2), at(b2, 0, 0)], [BLUE, BLUE, RED]);

    // 只有 1px 粗的线：里面没有位置，什么都不该改
    const line = mk(5, 1, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
    const before = line.data.join();
    inlineCel(line.data, 5, 1, 1, BLUE);
    eq("inline.thin-line-untouched", line.data.join(), before);

    // 半透明：与底色混合，且**不动像素自身的 alpha**
    const semi = block();
    inlineCel(semi.data, 5, 5, 1, BLUE, 128);
    const px = at(semi, 1, 1);
    ok("inline.blend-rgb", px[0] > 0 && px[0] < 255 && px[2] > 0 && px[2] < 255, px.join());
    eq("inline.blend-keeps-alpha", px[3], 255);
    const alpha0 = block();
    inlineCel(alpha0.data, 5, 5, 1, BLUE, 0);
    eq("inline.alpha-0-noop", at(alpha0, 1, 1), RED);

    // 半透明的原像素：alpha 不被改成不透明
    // 索引是**字节**偏移（idx(x,y) 已含 ×4），别自己再乘
    const ghost = mk(5, 5, [[2, 2]], [255, 0, 0, 128]);
    const gp = ghost.idx(1, 2);
    ghost.data[gp] = 255; ghost.data[gp + 1] = 0; ghost.data[gp + 2] = 0; ghost.data[gp + 3] = 128;
    inlineCel(ghost.data, 5, 5, 1, BLUE);
    eq("inline.keeps-semi-alpha", at(ghost, 1, 2)[3], 128);

    // 空画布 / 非法宽度：安全
    const empty = new Cel(4, 4);
    const es = empty.data.join();
    inlineCel(empty.data, 4, 4, 1, BLUE);
    eq("inline.empty-noop", empty.data.join(), es);
    const w0 = block();
    const w0s = w0.data.join();
    inlineCel(w0.data, 5, 5, 0, BLUE);
    eq("inline.width-0-noop", w0.data.join(), w0s);
  }

  // ------------------------------------------- parameterised drop shadow
  {
    const d = mk(9, 9, [[4, 4]]);
    dropShadowCel(d.data, 9, 9, -2, 1, BLUE, true);
    eq("shadow.original-kept", at(d, 4, 4), RED);
    eq("shadow.offset", at(d, 2, 5), BLUE);
    // the silhouette is copied, so nothing appears on the opposite side
    eq("shadow.no-stray", at(d, 6, 3), [0, 0, 0, 0]);
    // keepOriginal=false leaves ONLY the shadow copy
    const d2 = mk(9, 9, [[4, 4]]);
    dropShadowCel(d2.data, 9, 9, 1, 0, BLUE, false);
    eq("shadow.copy-only", [at(d2, 4, 4), at(d2, 5, 4)], [[0, 0, 0, 0], BLUE]);
  }
}
