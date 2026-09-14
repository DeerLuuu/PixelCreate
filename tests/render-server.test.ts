// RenderServer 的回归（src/servers/render.ts）。
//
// 这一段以前长在 render/view.ts 里，只能靠"DOM 桩 + 手势"间接覆盖，而它偏偏是最容易
// 悄悄坏掉的地方 —— 旧的 bug 就是"该整幅重建时返回了部分合成"，表现为 FX / 选区编辑
// 延迟一拍才显示。现在 compositor 与 canvas 都可注入，于是能直接在 Node 里断言：
//   · 什么时候允许部分合成、什么时候必须整幅重建
//   · 失效区域怎么合并、消费后怎么清
//   · 多画布合成缓存的键（pixelRev 那一条）
//   · 换文档 / 换帧各自的复位范围
import { Doc } from "../src/engine/doc";
import type { Rect } from "../src/engine/types";
import type { ComposeCache, OnionSpec } from "../src/render/compositor";
import {
  RenderServer, compositeIsStale, compositeKey, onionKeyOf, onionSpecOf, otherCompositeKey,
  type CanvasFactory, type CompositorApi,
} from "../src/servers/render";
import { eq, ok } from "./common";

const ONION: OnionSpec = { before: 0, after: 0, alpha: 0.5, tint: false, wrap: false };

function stubCtx(): CanvasRenderingContext2D {
  return { fillStyle: "", fillRect: () => undefined } as unknown as CanvasRenderingContext2D;
}

/** 假画布工厂：记录创建次数，画布带一个只会吞调用的 2D 上下文 */
function fakeFactory(): { factory: CanvasFactory; created: () => number } {
  let created = 0;
  return {
    factory: {
      create: (w, h) => {
        created++;
        return { width: w, height: h, getContext: () => stubCtx() } as unknown as HTMLCanvasElement;
      },
    },
    created: () => created,
  };
}

interface Rec {
  full: number;
  partial: Rect[];
  other: number;
  ghostsCleared: number;
}

/** 假 compositor：记录调用形状，返回假画布 */
function fakeApi(f: { factory: CanvasFactory }): { api: CompositorApi; rec: Rec } {
  const rec: Rec = { full: 0, partial: [], other: 0, ghostsCleared: 0 };
  const cache: ComposeCache = { ghosts: new Map() };
  const origClear = cache.ghosts.clear.bind(cache.ghosts);
  cache.ghosts.clear = () => { rec.ghostsCleared++; origClear(); };
  const api: CompositorApi = {
    composeFrame: (_doc, _fi) => { rec.other++; return f.factory.create(1, 1); },
    composeFrameWithOnion: (_doc, _fi, _onion, _cache) => { rec.full++; return f.factory.create(4, 4); },
    composeRectInto: (_doc, _fi, _onion, rect, _target, _cache) => { rec.partial.push({ ...rect }); },
    newComposeCache: () => cache,
  };
  return { api, rec };
}

function mkServer(): { srv: RenderServer; rec: Rec; created: () => number } {
  const f = fakeFactory();
  const { api, rec } = fakeApi(f);
  return { srv: new RenderServer({ factory: f.factory, compositor: api }), rec, created: f.created };
}

export function testRenderServer(): void {
  // -------------------------------------------------------- compositeIsStale
  {
    // 这条语义是历史 bug 的钉子：compRect === null = 整幅都脏，**必须重建**
    ok("rs.stale.full-dirty", compositeIsStale(true, true, null));
    ok("rs.stale.no-composite", compositeIsStale(false, true, { x: 0, y: 0, w: 1, h: 1 }));
    ok("rs.stale.key-changed", compositeIsStale(true, false, { x: 0, y: 0, w: 1, h: 1 }));
    ok("rs.fresh.partial", !compositeIsStale(true, true, { x: 2, y: 3, w: 4, h: 5 }));
  }

  // ------------------------------------------------------------------ 键
  {
    const d = new Doc(32, 32, "t");
    eq("rs.key.stable", compositeKey(d, 0, "0"), compositeKey(d, 0, "0"));
    ok("rs.key.frame", compositeKey(d, 0, "0") !== compositeKey(d, 1, "0"));
    ok("rs.key.onion", compositeKey(d, 0, "0") !== compositeKey(d, 0, "1:1:0"));
    const k0 = compositeKey(d, 0, "0");
    d.layers[0].visible = false;
    ok("rs.key.layer-visible", compositeKey(d, 0, "0") !== k0);
    const k1 = compositeKey(d, 0, "0");
    d.layers[0].opacity = 50;
    ok("rs.key.layer-opacity", compositeKey(d, 0, "0") !== k1);
    // 另一张画布的键额外带 pixelRev（引用图层被绘制时配置没变）
    const k2 = otherCompositeKey(d, 0);
    d.pixelRev++;
    ok("rs.key.other-pixelrev", otherCompositeKey(d, 0) !== k2);
  }

  // ------------------------------------------------------------- 洋葱皮投影
  {
    const p = { onionOn: false, onionBefore: 2, onionAfter: 1, onionAlpha: 40, onionTint: true, onionWrap: true };
    const off = onionSpecOf(p);
    eq("rs.onion.off.zeroed", [off.before, off.after], [0, 0]);
    eq("rs.onion.alpha", off.alpha, 0.4);
    eq("rs.onion.key.off", onionKeyOf(p), "0");
    const on = onionSpecOf({ ...p, onionOn: true });
    eq("rs.onion.on", [on.before, on.after, on.tint, on.wrap], [2, 1, true, true]);
    ok("rs.onion.key.on", onionKeyOf({ ...p, onionOn: true }) !== "0");
    ok("rs.onion.key.params", onionKeyOf({ ...p, onionOn: true }) !== onionKeyOf({ ...p, onionOn: true, onionBefore: 3 }));
  }

  // ------------------------------------------------------ 失效 → 合成 → 清空
  {
    const { srv, rec } = mkServer();
    const d = new Doc(32, 32, "t");
    ok("rs.initial-dirty", srv.needsCompose);
    eq("rs.initial-canvas", srv.canvas, null);

    const r1 = srv.compose(d, 0, ONION, "0", false);
    eq("rs.first.rebuilt", r1.rebuilt, true);
    eq("rs.first.consumed", r1.consumed, null);
    eq("rs.first.calls", [rec.full, rec.partial.length], [1, 0]);
    ok("rs.canvas-after-compose", !!srv.canvas);
    ok("rs.clean-after-compose", !srv.needsCompose);

    // 部分合成：脏区域已知 + 键没变 → 只走 composeRectInto，并把区域原样回报
    srv.invalidate({ x: 2, y: 3, w: 4, h: 5 });
    ok("rs.dirty-after-invalidate", srv.needsCompose);
    eq("rs.dirty-rect", srv.dirtyRect, { x: 2, y: 3, w: 4, h: 5 });
    const r2 = srv.compose(d, 0, ONION, "0", false);
    eq("rs.second.rebuilt", r2.rebuilt, false);
    eq("rs.second.consumed", r2.consumed, { x: 2, y: 3, w: 4, h: 5 });
    eq("rs.second.calls", [rec.full, rec.partial.length], [1, 1]);
    eq("rs.second.rect-passed", rec.partial[0], { x: 2, y: 3, w: 4, h: 5 });

    // 两次脏区域并集
    srv.invalidate({ x: 10, y: 10, w: 2, h: 2 });
    srv.invalidate({ x: 0, y: 0, w: 3, h: 3 });
    eq("rs.union", srv.dirtyRect, { x: 0, y: 0, w: 12, h: 12 });

    // 整幅失效（invalidate() 不传参）→ 下一次必须整幅重建
    srv.invalidate();
    eq("rs.full-dirty-rect", srv.dirtyRect, null);
    const r3 = srv.compose(d, 0, ONION, "0", false);
    eq("rs.full-dirty.rebuilt", r3.rebuilt, true);
    eq("rs.full-dirty.calls", rec.full, 2);

    // force 即使刚合成完也要重建
    const r4 = srv.compose(d, 0, ONION, "0", true);
    eq("rs.force.rebuilt", r4.rebuilt, true);
    eq("rs.force.calls", rec.full, 3);

    // 图层配置变了（键变）→ 哪怕只有一小块脏，也必须整幅重建
    srv.invalidate({ x: 1, y: 1, w: 1, h: 1 });
    d.layers[0].visible = false;
    const r5 = srv.compose(d, 0, ONION, "0", false);
    eq("rs.key-change.rebuilt", r5.rebuilt, true);
    eq("rs.key-change.calls", rec.full, 4);
    ok("rs.key-change.ghosts-cleared", rec.ghostsCleared >= 4, "cleared=" + rec.ghostsCleared);
  }

  // ------------------------------------------------------ 多画布合成缓存
  {
    const { srv, rec } = mkServer();
    const a = new Doc(16, 16, "a");
    const b = new Doc(16, 16, "b");
    const c1 = srv.composeOther(1, a, 0);
    const c2 = srv.composeOther(1, a, 0);
    ok("rs.other.cached", c1 === c2);
    eq("rs.other.calls", rec.other, 1);
    // pixelRev 变了 → 重新合成
    a.pixelRev++;
    ok("rs.other.pixelrev-invalidates", srv.composeOther(1, a, 0) !== c2);
    eq("rs.other.calls2", rec.other, 2);
    // 另一个下标独立缓存
    srv.composeOther(2, b, 0);
    eq("rs.other.calls3", rec.other, 3);
    srv.composeOther(2, b, 0);
    eq("rs.other.calls4", rec.other, 3);
  }

  // ------------------------------------------------------------ 复位范围
  {
    const { srv, rec } = mkServer();
    const d = new Doc(16, 16, "d");
    const other = new Doc(16, 16, "o");
    srv.compose(d, 0, ONION, "0", false);
    srv.composeOther(1, other, 0);
    eq("rs.reset.setup", rec.other, 1);

    srv.resetFrame();
    ok("rs.reset.frame.needs", srv.needsCompose);
    eq("rs.reset.frame.canvas", srv.canvas, null);
    // 换帧不该丢掉别的画布缓存（不然多画布每次切帧都重合成）
    srv.composeOther(1, other, 0);
    eq("rs.reset.frame.keeps-others", rec.other, 1);
    srv.compose(d, 0, ONION, "0", false);
    eq("rs.reset.frame.full-rebuild", rec.full, 2);

    srv.resetDoc();
    srv.composeOther(1, other, 0);
    eq("rs.reset.doc.clears-others", rec.other, 2);
  }

  // -------------------------------------------------------- 棋盘格与画布
  {
    const { srv, created } = mkServer();
    const ctx = { createPattern: () => ({} as unknown as CanvasPattern) } as unknown as CanvasRenderingContext2D;
    const p1 = srv.checkerPattern(ctx);
    const p2 = srv.checkerPattern(ctx);
    ok("rs.checker.made", !!p1 && !!p2);
    eq("rs.checker.created-once", created(), 1);   // 只创建一个 2×2 画布
  }
}
