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
  RenderDebug, RenderServer, compositeIsStale, compositeKey, onionKeyOf, onionSpecOf,
  otherCompositeKey, repaintRegion,
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

  // ------------------------------------------------ 脏矩形 → 屏幕重绘区域
  // 平铺模式下同样的像素在屏幕上出现 9 次，只重绘中心那一块会让邻居副本留旧画面
  {
    const base = { zoom: 10, ox: 0, oy: 0, vpW: 360, vpH: 640, docW: 32, docH: 32 };
    const dirty = { x: 2, y: 3, w: 4, h: 5 };
    // 不平铺：脏矩形映射到屏幕 + 2px 余量（screenRectOf 的 pad）
    // 屏幕矩形 = 脏矩形 × zoom ± 2px 余量：x 18..62、y 28..82
    eq("rr.off", repaintRegion(dirty, { ...base, tile: "off" }), { x: 18, y: 28, w: 44, h: 54 });
    // 横向平铺：左右两个副本一起并进来（一个副本 = 一个文档宽 = 320px）
    eq("rr.row", repaintRegion(dirty, { ...base, tile: "row" }), { x: 0, y: 28, w: 360, h: 54 });
    // 九宫格：上下也并进来，宽度撑满整个视口
    const grid = repaintRegion(dirty, { ...base, tile: "grid" });
    eq("rr.grid.width", grid ? grid.w : null, 360);
    ok("rr.grid.taller-than-row", !!grid && grid.h > 54);
    // 完全在视口外的脏区域：不用重绘
    eq("rr.outside", repaintRegion({ x: 50, y: 50, w: 2, h: 2 }, { ...base, vpW: 100, vpH: 100, tile: "off" }), null);
    // 缩小视图（zoom < 1）时区域也跟着缩
    // 缩到 0.5 倍时 2px 余量反而成了主导（脏矩形本身只有 2×2.5 屏幕像素）
    eq("rr.zoomed-out", repaintRegion(dirty, { ...base, zoom: 0.5, tile: "off" }), { x: 0, y: 0, w: 5, h: 6 });
    // server 上的薄包装与纯函数一致（"重绘规则属于渲染服务"）
    const { srv } = mkServer();
    eq("rr.via-server", srv.repaintScreenRegion(dirty, { ...base, tile: "row" }), { x: 0, y: 28, w: 360, h: 54 });
  }

  // ---------------------------------------------------------- 渲染调试模式
  {
    const d = new RenderDebug();
    const f = fakeFactory();
    const { api, rec } = fakeApi(f);
    const srv = new RenderServer({ factory: f.factory, compositor: api, debug: d });
    const doc = new Doc(32, 32, "t");
    const note = (e: Partial<Parameters<RenderServer["noteFrame"]>[0]> = {}): void => {
      srv.noteFrame({
        composed: true, rebuilt: false, reason: "partial", fi: 0,
        docRect: { x: 1, y: 1, w: 2, h: 2 }, screen: { x: 8, y: 8, w: 24, h: 24 },
        fullBlit: false, ms: 1.5, ...e,
      });
    };

    // 关着的时候：一条都不记（热路径零成本），计数也不动
    note();
    eq("dbg.off.events", d.events().length, 0);
    eq("dbg.off.frames", d.totals.frames, 0);

    // 打开后开始记录
    d.setEnabled(true);
    note({ composed: true, rebuilt: true, reason: "first" });
    note({ composed: false, rebuilt: false, reason: "skip", docRect: null, screen: null });
    note({ fullBlit: true, ms: 4 });
    eq("dbg.events", d.events().length, 3);
    eq("dbg.totals", [d.totals.frames, d.totals.composes, d.totals.rebuilds, d.totals.partials, d.totals.skips, d.totals.fullBlits],
       [3, 2, 1, 1, 1, 1]);
    eq("dbg.timing", [d.totals.lastMs, d.totals.maxMs], [4, 4]);
    eq("dbg.reason-kept", d.events()[0].reason, "first");
    ok("dbg.text", d.text().includes("compose=2") && d.text().includes("full-dirty") === false);
    ok("dbg.text-row", d.text().includes("f0"));

    // 事件流订阅：收到通知；退订后不再收到
    let hits = 0;
    const off = d.subscribe(() => { hits++; });
    note();
    eq("dbg.subscribe", hits >= 1, true);
    off();
    const before = hits;
    note();
    eq("dbg.unsubscribe", hits, before);

    // 环形缓冲上限：留最近 cap 条
    for (let i = 0; i < d.cap + 10; i++) note();
    eq("dbg.cap", d.events().length, d.cap);

    // clear 清空计数与事件；关掉开关也清空（别留陈旧数字误导）
    d.clear();
    eq("dbg.clear", [d.events().length, d.totals.frames], [0, 0]);
    note();
    d.setEnabled(false);
    eq("dbg.disable-clears", d.events().length, 0);

    // compose 的 reason 分类：直接断到"为什么走这条路径"
    d.setEnabled(true);
    const r1 = srv.compose(doc, 0, ONION, "0", false);
    eq("dbg.reason.first", r1.reason, "first");
    srv.invalidate({ x: 1, y: 1, w: 2, h: 2 });
    eq("dbg.reason.partial", srv.compose(doc, 0, ONION, "0", false).reason, "partial");
    srv.invalidate();
    eq("dbg.reason.full-dirty", srv.compose(doc, 0, ONION, "0", false).reason, "full-dirty");
    eq("dbg.reason.force", srv.compose(doc, 0, ONION, "0", true).reason, "force");
    srv.invalidate({ x: 0, y: 0, w: 1, h: 1 });
    doc.layers[0].visible = false;
    eq("dbg.reason.key-changed", srv.compose(doc, 0, ONION, "0", false).reason, "key-changed");
    eq("dbg.compose-count", rec.full, 4);
  }
}
