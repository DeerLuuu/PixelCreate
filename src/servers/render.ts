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
import { unionRect } from "../render/rect";

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
}

export interface RenderServerOpts {
  factory?: CanvasFactory;
  compositor?: CompositorApi;
}

export class RenderServer {
  private readonly factory: CanvasFactory;
  private readonly api: CompositorApi;
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
    this.cache = this.api.newComposeCache();
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
    const key = compositeKey(doc, fi, onionKey);
    const partial = !force && !compositeIsStale(!!this.composite, this.key === key, this.rect);
    const consumed = this.rect;
    if (partial) {
      this.api.composeRectInto(doc, fi, onion, this.rect!, this.composite!, this.cache);
      this.clearDirty();
      return { rebuilt: false, consumed };
    }
    this.key = key;
    this.cache.ghosts.clear(); // 帧或图层配置变了，幽灵帧缓存不再可信
    this.composite = this.api.composeFrameWithOnion(doc, fi, onion, this.cache);
    this.clearDirty();
    return { rebuilt: true, consumed: null };
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
}
