// RenderServer —— 「文档 → 画面」的合成与缓存所有权（见 docs/ARCHITECTURE.md §3.3 第 3 项）。
//
// 它拥有合成的全部中间状态：合成缓冲区、合成键、失效区域、多画布合成缓存、
// 透明背景的棋盘格。视图层（render/view.ts）只负责把结果 blit 到屏幕、画自己的覆盖层；
// **不要把 blit / 视图变换搬进来** —— 那是 ViewportServer 与视图层的事。
//
// 为什么要单独一层（而不是继续挂在 View 里）：
//   · 合成是纯数据变换，**可以脱离 DOM 测**：compositor 与 canvas 都从这里注入，
//     测试用假实现就能断言"什么时候部分合成、什么时候必须整幅重建"；
//   · 这段逻辑历史上出过真 bug（见 `compositeIsStale` 的注释），现在它有测试兜着了。
import type { Doc } from "../engine/doc";
import type { Rect } from "../engine/types";
import * as comp from "../render/compositor";
import { clampRect, screenRectOf, tileOffsets, tileRect, unionRect, type TileMode } from "../render/rect";

/** 画布工厂：真机走 DOM，测试注假实现即可在 Node 里跑 */
export interface CanvasFactory {
  create(w: number, h: number): HTMLCanvasElement;
}

export const domCanvasFactory: CanvasFactory = {
  create: (w, h) => {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    return cv;
  },
};

/** 合成内核（默认是真 compositor；测试注入假实现） */
export interface CompositorApi {
  composeFrame(doc: Doc, fi: number): HTMLCanvasElement;
  composeFrameWithOnion(doc: Doc, fi: number, onion: comp.OnionSpec, cache?: comp.ComposeCache): HTMLCanvasElement;
  composeRectInto(doc: Doc, fi: number, onion: comp.OnionSpec, rect: Rect, target: HTMLCanvasElement, cache?: comp.ComposeCache): void;
  newComposeCache(): comp.ComposeCache;
}

/**
 * 真 compositor 的**晚绑定**包装。
 *
 * 这里刻意写成箭头函数而不是直接引用函数对象：测试（`tests/view.test.ts`、
 * `tests/session.test.ts`）会在运行时替换 `compositor.composeFrame*` 来数调用次数，
 * 提前绑定就把补丁挡在外面了 —— 那些计数断言会静默失效（真出过这种"测试看着绿、
 * 其实什么都没测"的情况）。
 */
export const realCompositor: CompositorApi = {
  composeFrame: (doc, fi) => comp.composeFrame(doc, fi),
  composeFrameWithOnion: (doc, fi, onion, cache) => comp.composeFrameWithOnion(doc, fi, onion, cache),
  composeRectInto: (doc, fi, onion, rect, target, cache) => comp.composeRectInto(doc, fi, onion, rect, target, cache),
  newComposeCache: () => comp.newComposeCache(),
};

/**
 * 合成画布过时了吗？
 *
 * `compRect === null` 表示**整幅都脏了**，调用方必须真正重建 —— 不能沿用旧画布。
 * 这条曾经是个真 bug：FX / 选区编辑"延迟一拍"才显示，而预览框看起来是对的
 * （因为预览总是直接从文档合成）。别把 `compRect === null` 当成"没有脏区域"。
 */
export function compositeIsStale(hasComposite: boolean, keySame: boolean, compRect: Rect | null): boolean {
  return !hasComposite || !keySame || compRect === null;
}

/**
 * 文档空间的脏矩形 → **需要重绘的屏幕区域**。
 *
 * 两件事一起做：①把脏矩形映射到屏幕（`screenRectOf` 自带 2px 余量，避免缩放取整
 * 露边）②**平铺模式下把 8 个邻居副本的区域一并并进来** —— 同样的像素在屏幕上出现
 * 9 次，只重绘中心那一块的话邻居副本会留在旧画面上（真机表现：开了平铺后涂画，
 * 四周的副本"半拍才更新"）。
 *
 * 最后裁到视口：区域越界交给 canvas 裁剪是浪费，脏矩形越大越亏。
 * 返回 null = 这块脏区域完全在视口外，不用重绘。
 */
export function repaintRegion(dirty: Rect, o: RepaintRegionOpts): Rect | null {
  let u = screenRectOf(dirty, o.ox, o.oy, o.zoom);
  if (o.tile !== "off") {
    for (const [dx, dy] of tileOffsets(o.tile)) {
      if (dx === 0 && dy === 0) continue;
      u = unionRect(u, screenRectOf(tileRect(dirty, o.docW, o.docH, dx, dy), o.ox, o.oy, o.zoom))!;
    }
  }
  return clampRect(u, o.vpW, o.vpH);
}

export interface RepaintRegionOpts {
  /** 视图变换：文档像素 → 屏幕 */
  zoom: number;
  ox: number;
  oy: number;
  /** 逻辑视口尺寸（裁取用） */
  vpW: number;
  vpH: number;
  /** 文档尺寸（平铺偏移一格 = 一个文档宽/高） */
  docW: number;
  docH: number;
  /** 平铺模式；"off" = 不做邻居展开 */
  tile: TileMode;
}

// ---------------------------------------------------------------- 调试设施

export type RenderKind = "full" | "partial";
/** 一次「重绘」为什么发生 —— HUD 里直接显示这个字符串 */
export type RenderReason =
  | "first"          // 还没有合成画布
  | "full-dirty"     // 整幅失效（FX / 选区编辑 / 粘贴 …）
  | "force"          // 调用方要求强制重建（切帧 / 换文档 / 旋转视图）
  | "key-changed"    // 图层配置或洋葱皮配置变了
  | "partial"        // 只重合成脏区域
  | "skip";          // 这一帧没重合成（只重画了覆盖层）

export interface RenderEvent {
  seq: number;
  /** performance.now() 风格的时间戳（打点用） */
  t: number;
  kind: RenderKind | "skip";
  reason: RenderReason;
  /** 当前帧号 */
  fi: number;
  /** 本次合成消费的脏矩形（文档空间；整幅 = null） */
  docRect: Rect | null;
  /** 实际重绘的屏幕区域（null = 整块重绘） */
  screen: Rect | null;
  /** 是否整块 blit（视图变换 / 视口尺寸变化会置起） */
  fullBlit: boolean;
  /** 合成耗时（毫秒） */
  ms: number;
  /** 合成画布尺寸 */
  w: number;
  h: number;
}

export interface RenderTotals {
  /** 重绘次数（= refresh 走到"需要重绘"的次数） */
  frames: number;
  composes: number;
  rebuilds: number;
  partials: number;
  skips: number;
  fullBlits: number;
  lastMs: number;
  maxMs: number;
}

/**
 * 渲染调试：**开着才记录**（关掉时 `note()` 第一行就返回，热路径上没有额外开销）。
 *
 * 用途是回答"这一次渲染到底渲染了什么"：整幅还是局部、脏矩形多大、屏幕重绘区域多大、
 * 耗时多少、为什么（`reason`）。真机上看 HUD（设置 → 显示 → 渲染调试），
 * 或者在控制台里 `__pcRender.text()` / `__pcRender.totals` 直接读。
 */
export class RenderDebug {
  private on = false;
  private evts: RenderEvent[] = [];
  private seq = 0;
  private subs = new Set<() => void>();
  /** 保留最近多少条事件（HUD 只画最后几条，多的留着给控制台看） */
  readonly cap = 60;
  readonly totals: RenderTotals = {
    frames: 0, composes: 0, rebuilds: 0, partials: 0, skips: 0, fullBlits: 0, lastMs: 0, maxMs: 0,
  };

  get enabled(): boolean {
    return this.on;
  }

  setEnabled(v: boolean): void {
    if (this.on === v) return;
    this.on = v;
    if (!v) this.evts = [];      // 关掉就清干净，别留一堆陈旧数据误导
    this.emit();
  }

  /** 最近的事件（老的在前） */
  events(): readonly RenderEvent[] {
    return this.evts;
  }

  clear(): void {
    this.evts = [];
    for (const k of Object.keys(this.totals) as Array<keyof RenderTotals>) this.totals[k] = 0;
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }

  when(): number {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  /** 记录一次重绘（关掉时零成本） */
  note(e: Omit<RenderEvent, "seq" | "t">): void {
    if (!this.on) return;
    this.seq++;
    this.evts.push({ seq: this.seq, t: this.when(), ...e });
    if (this.evts.length > this.cap) this.evts.splice(0, this.evts.length - this.cap);
    this.totals.frames++;
    if (e.kind === "skip") this.totals.skips++;
    else {
      this.totals.composes++;
      if (e.kind === "full") this.totals.rebuilds++;
      else this.totals.partials++;
    }
    if (e.fullBlit) this.totals.fullBlits++;
    this.totals.lastMs = e.ms;
    if (e.ms > this.totals.maxMs) this.totals.maxMs = e.ms;
    this.emit();
  }

  /** 给控制台用的一行行文本 */
  text(limit = 20): string {
    const head = `frames=${this.totals.frames} compose=${this.totals.composes}`
      + `(full=${this.totals.rebuilds} partial=${this.totals.partials}) skip=${this.totals.skips}`
      + ` fullBlit=${this.totals.fullBlits} last=${this.totals.lastMs.toFixed(1)}ms max=${this.totals.maxMs.toFixed(1)}ms`;
    const rect = (r: Rect | null): string => (r ? `${r.x},${r.y} ${r.w}x${r.h}` : "-");
    const rows = this.evts.slice(-limit).map((e) =>
      `#${e.seq} f${e.fi} ${e.kind.padEnd(7)} ${e.reason.padEnd(11)} doc ${rect(e.docRect).padEnd(16)}`
      + ` screen ${rect(e.screen).padEnd(16)} ${e.fullBlit ? "FULLBLIT" : "        "} ${e.ms.toFixed(1)}ms`);
    return [head, ...rows].join("\n");
  }

  private emit(): void {
    for (const fn of this.subs) fn();
  }
}

/** 全应用共用一份（View 里的 RenderServer 默认接它；测试可以注入自己的） */
export const renderDebug = new RenderDebug();

// 控制台入口：真机上直接 `__pcRender.setEnabled(true)` / `__pcRender.text()` 就能看
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__pcRender = renderDebug;
}

/** 从 Prefs 投影出洋葱皮参数（关掉时 before/after 归零） */
export function onionSpecOf(p: {
  onionOn: boolean; onionBefore: number; onionAfter: number;
  onionAlpha: number; onionTint: boolean; onionWrap: boolean;
}): comp.OnionSpec {
  return {
    before: p.onionOn ? p.onionBefore : 0,
    after: p.onionOn ? p.onionAfter : 0,
    alpha: p.onionAlpha / 100,
    tint: p.onionTint,
    wrap: p.onionWrap,
  };
}

/** 洋葱皮的键片段：开关 + 四个参数（任何一个变了都得整幅重建） */
export function onionKeyOf(p: {
  onionOn: boolean; onionBefore: number; onionAfter: number;
  onionAlpha: number; onionTint: boolean; onionWrap: boolean;
}): string {
  return p.onionOn
    ? "1:" + p.onionBefore + ":" + p.onionAfter + ":" + p.onionAlpha + ":" + (p.onionTint ? 1 : 0) + ":" + (p.onionWrap ? 1 : 0)
    : "0";
}

/** 图层配置片段：可见性 / 不透明度 / 混合 / 引用图层 id / 有没有底色 */
function layerKeyOf(doc: Doc): string {
  return doc.layers
    .map((l) => (l.visible ? 1 : 0) + ":" + l.opacity + ":" + l.blend + ":" + (l.ref ?? "") + (doc.bg ? "B" : "T"))
    .join();
}

/** 当前帧的合成键：尺寸 / 帧号 / 图层配置 / 洋葱皮配置 */
export function compositeKey(doc: Doc, fi: number, onionKey: string): string {
  return doc.w + "x" + doc.h + "|" + fi + "|" + layerKeyOf(doc) + "|on" + onionKey;
}

/**
 * 非聚焦画布的合成键：比当前帧多带 `pixelRev` —— 别的画布可能被画到了
 * （引用图层被绘制等）而它自己的图层配置并没有变，只靠配置键会漏刷新。
 */
export function otherCompositeKey(doc: Doc, fi: number): string {
  return doc.w + "x" + doc.h + "|" + fi + "|" + doc.pixelRev + "|" + layerKeyOf(doc);
}

/** 这次合成消费掉的脏矩形 + 是否整幅重建（调用方据此算重绘区域） */
export interface ComposeResult {
  /** true = 整幅重建（调用方必须全量 blit） */
  rebuilt: boolean;
  /** 这次用掉的脏矩形（整幅重建时为 null） */
  consumed: Rect | null;
  /** 为什么走这条路径（调试用） */
  reason: RenderReason;
  /** 合成耗时（毫秒；调试关闭时记 0） */
  ms: number;
}

export interface RenderServerOpts {
  factory?: CanvasFactory;
  compositor?: CompositorApi;
  /** 调试记录器（默认接全局 `renderDebug`；测试可注入自己的） */
  debug?: RenderDebug;
}

export class RenderServer {
  private readonly factory: CanvasFactory;
  private readonly api: CompositorApi;
  private readonly debug: RenderDebug;
  private composite: HTMLCanvasElement | null = null;
  private key = "";
  private dirty = true;
  /** dirty 时的失效区域（文档空间；null = 整幅） */
  private rect: Rect | null = null;
  private cache: comp.ComposeCache;
  private others = new Map<number, { key: string; doc: Doc; cv: HTMLCanvasElement }>();
  private checker: HTMLCanvasElement | null = null;

  constructor(opts: RenderServerOpts = {}) {
    this.factory = opts.factory ?? domCanvasFactory;
    this.api = opts.compositor ?? realCompositor;
    this.debug = opts.debug ?? renderDebug;
    this.cache = this.api.newComposeCache();
  }

  /** 调试记录开着吗（视图层据此决定要不要打点，避免白算时间戳） */
  get debugEnabled(): boolean {
    return this.debug.enabled;
  }

  /** 统一时钟（与调试记录同源，别混 Date.now，否则耗时会出现负数） */
  nowMs(): number {
    return this.debug.when();
  }

  /** 当前合成画布（只读用途：取色 / 放大镜）。可能为 null。 */
  get canvas(): HTMLCanvasElement | null {
    return this.composite;
  }

  /** 有没有待合成的改动（视图层据此决定要不要重绘） */
  get needsCompose(): boolean {
    return this.dirty;
  }

  /** 当前失效区域（文档空间；null = 整幅）—— 调试/测试用 */
  get dirtyRect(): Rect | null {
    return this.rect;
  }

  /** 合成键（调试/测试用） */
  get compositeKeyNow(): string {
    return this.key;
  }

  /**
   * 标记失效。`rect`（文档空间）只标记一块；不传 = 整幅失效。
   * 注意：这里**不**管"必须整幅 blit"——那是视图层的事（视图变换 / 尺寸变化），
   * 由 `View.markDirty` 自己把 `blitFull` 置上。
   */
  invalidate(rect?: Rect | null): void {
    if (!rect) {
      this.dirty = true;
      this.rect = null;
      return;
    }
    if (!this.dirty) {
      this.dirty = true;
      this.rect = rect;
      return;
    }
    if (this.rect) this.rect = unionRect(this.rect, rect);
  }

  /**
   * 合成当前帧。
   *
   * 部分合成只在三种条件同时成立时可用：已有合成画布、合成键没变、脏区域已知。
   * 否则整幅重建（`force` 直接走整幅）。无论哪条路径，返回后失效状态都清干净。
   */
  compose(doc: Doc, fi: number, onion: comp.OnionSpec, onionKey: string, force: boolean): ComposeResult {
    const t0 = this.debug.enabled ? this.debug.when() : 0;
    const key = compositeKey(doc, fi, onionKey);
    const keySame = this.key === key;
    const partial = !force && !compositeIsStale(!!this.composite, keySame, this.rect);
    const consumed = this.rect;
    if (partial) {
      this.api.composeRectInto(doc, fi, onion, this.rect!, this.composite!, this.cache);
      this.clearDirty();
      return { rebuilt: false, consumed, reason: "partial", ms: this.since(t0) };
    }
    // 整幅重建是「上一次渲染」的主要性能风险，所以把原因分细（HUD 直接显示）
    const reason: RenderReason = force ? "force"
      : !this.composite ? "first"
      : this.rect === null ? "full-dirty"
      : "key-changed";
    this.key = key;
    this.cache.ghosts.clear(); // 帧或图层配置变了，幽灵帧缓存不再可信
    this.composite = this.api.composeFrameWithOnion(doc, fi, onion, this.cache);
    this.clearDirty();
    return { rebuilt: true, consumed: null, reason, ms: this.since(t0) };
  }

  /**
   * 文档脏矩形 → 要重绘的屏幕区域（含平铺邻居副本，裁到视口）。
   *
   * 薄包装，实现是模块级纯函数 `repaintRegion`（可单测）。放在 server 上的理由：
   * **"重绘什么"的规则属于渲染服务**，不该散在视图层；视图层只负责把它交给 ctx.clip。
   */
  repaintScreenRegion(dirty: Rect, o: RepaintRegionOpts): Rect | null {
    return repaintRegion(dirty, o);
  }

  /** 非聚焦画布的合成（带缓存，键含 pixelRev）；`index` 是画布下标 */
  composeOther(index: number, doc: Doc, fi: number): HTMLCanvasElement {
    const key = otherCompositeKey(doc, fi);
    const got = this.others.get(index);
    if (got && got.key === key && got.doc === doc) return got.cv;
    const cv = this.api.composeFrame(doc, fi);
    this.others.set(index, { key, doc, cv });
    return cv;
  }

  /** 2×2 透明棋盘格，复用成 pattern（只在需要时创建一次） */
  checkerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
    let chk = this.checker;
    if (!chk) {
      chk = this.factory.create(2, 2);
      const cc = chk.getContext("2d");
      if (!cc) return null;
      cc.fillStyle = "#9aa0b0"; cc.fillRect(0, 0, 1, 1);
      cc.fillStyle = "#b9bec9"; cc.fillRect(1, 0, 1, 1);
      cc.fillStyle = "#b9bec9"; cc.fillRect(0, 1, 1, 1);
      cc.fillStyle = "#9aa0b0"; cc.fillRect(1, 1, 1, 1);
      this.checker = chk;
    }
    return ctx.createPattern(chk, "repeat");
  }

  /**
   * 换文档：合成、幽灵帧、多画布缓存全部作废。
   *
   * 两个 reset 都会顺手置脏 —— 合成画布既然已经丢掉，就**必须**重新合成；
   * 依赖调用方记得再 `invalidate()` 是个潜在的空画面 bug（查过所有调用点，
   * `Session.applyFrame` 后面都跟着 `repaintAll()`，所以置脏只是把这件事写死）。
   */
  resetDoc(): void {
    this.composite = null;
    this.key = "";
    this.dirty = true;
    this.rect = null;
    this.cache.ghosts.clear();
    this.others.clear();
  }

  /** 换帧：只有当前帧的合成与幽灵帧作废，别的画布缓存还能用 */
  resetFrame(): void {
    this.composite = null;
    this.key = "";
    this.dirty = true;
    this.rect = null;
    this.cache.ghosts.clear();
  }

  private clearDirty(): void {
    this.dirty = false;
    this.rect = null;
  }

  private since(t0: number): number {
    return t0 ? this.debug.when() - t0 : 0;
  }

  /**
   * 视图层在**一次重绘结束时**回报：这一帧到底渲染了什么。
   *
   * 位置放这里而不是让 View 自己记：HUD 要看到的是"一次重绘"的完整画像
   * （合成路径 + 脏矩形 + 屏幕区域 + 是否整块重绘 + 耗时），只有 server 与视图层
   * 合起来才知道 —— 合成结果来自 server，屏幕区域来自视图变换。
   */
  noteFrame(e: {
    /** 这一帧有没有重合成 */
    composed: boolean;
    rebuilt: boolean;
    reason: RenderReason;
    fi: number;
    docRect: Rect | null;
    screen: Rect | null;
    fullBlit: boolean;
    ms: number;
  }): void {
    if (!this.debug.enabled) return;
    const cv = this.composite;
    this.debug.note({
      kind: e.composed ? (e.rebuilt ? "full" : "partial") : "skip",
      reason: e.reason,
      fi: e.fi,
      docRect: e.docRect,
      screen: e.screen,
      fullBlit: e.fullBlit,
      ms: e.ms,
      w: cv ? cv.width : 0,
      h: cv ? cv.height : 0,
    });
  }
}
