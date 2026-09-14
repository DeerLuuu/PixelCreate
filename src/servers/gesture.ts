// GestureServer（手势状态机）—— 见 docs/ARCHITECTURE.md §3.3 第 5 项。
//
// P5 第二片：**轻点序列状态机**（单击 / 双击 / 三击 / 双指双击）。搬出来的是一个
// **有状态、但无 DOM、无 Session** 的小机器：它只按「按下/抬起的时间、落点、当时的开关」
// 决定这次抬手算什么，动作体（取消笔迹、发手势动作、撤销）留在 View 里执行。
//
// 为什么单拎这一块：这四个手势的**优先级与容差**以前埋在 `view.ts` 的 `onUp` 里
// （480ms / 64px / 80px / 三击回滚那一个点），既没法单测也不好看 —— 现在有了
// `tests/gesture.test.ts`，改容差或调优先级会直接撞测试。
//
// 口径（与 `view.ts` 的 onUp 逐个分支对齐，改之前先读这一段）：
//   · 第二次点击**落在画布内且「双击画布」没映射动作**时，这一下被吞掉但不清零计数，
//     留给三击（三击＝放大，会顺手把前一下画上去的那个点撤销掉）。
//   · 双击**边距**＝用户映射的动作；双击**另一个画布**＝聚焦并适配（与映射无关）。
//   · PC 模式不做单击连击（滚轮与快捷键替代）—— 所以 `isPc` 下永远只出 `plain`。
//   · 双指轻点序列（两指都抬起、且中途没缩放）＝两下之内算「双指双击」；
//     **中点落在画布内不算**（画画时太容易碰到）；缩放过的双指抬手不算轻点。
//   · 多指介入（第 3、4 根手指落下）与 pointercancel 都会清掉双指序列 —— 见 `clearTwoTapSeq()`。
import type { Pt } from "./input";

/** 单指连点的时限（ms）：超时就从「第一下」重新数 */
export const TAP_SEQ_MS = 480;
/** 单指连点的落点容差（px）：超过就不算同一串点击 */
export const TAP_SEQ_PX = 64;
/** 双指双击的落点容差（px），比特例里的单指更宽松（两指中点本来就有抖动） */
export const TWO_TAP_PX = 80;

/** `TapMachine.up()` 需要的当次上下文（都是 View 侧现成的读数，机器自己不查任何东西） */
export interface TapUpInput {
  now: number;
  pt: Pt;
  /** 这一下的像素坐标是否落在画布内 */
  overDoc: boolean;
  /** 松手处命中的画布索引（-1 = 没命中任何画布） */
  canvasIndex: number;
  /** 当前聚焦的画布索引 */
  docIndex: number;
  /** 手势期间画过（有笔迹且离开过起点）：第二次点击前拖动过就断掉连点 */
  moved: boolean;
  hasStroke: boolean;
  hasSelDrag: boolean;
  hasXf: boolean;
  /** 这一次双指手势里真的缩放过（缩放过就不是轻点） */
  pinchZoomed: boolean;
  isPc: boolean;
  /** 设置里的双击时限（`prefs.doubleTapMs`）；双指双击共用它 */
  doubleTapMs: number;
  /** 「双击画布」是否映射了动作（没映射时第二下被吞掉，留给三击） */
  canvasDoubleMapped: boolean;
  /** 双指轻点的中点是否落在画布内（落在画上不许触发重做） */
  midOverDoc: boolean;
}

/**
 * 一次抬手的结果。View 只按这个执行副作用：
 * - `plain` 照常提交笔迹 / 落一个点；
 * - 其余都表示「这一下被手势吃掉」，动作体见 `view.ts` 的 onUp。
 */
export type TapOutcome =
  /** 没被手势接管：照常落笔 / 提交 */
  | { kind: "plain" }
  /** 第二次点击落在画布内且没映射动作：吞掉（清零由下一次三击判断） */
  | { kind: "skip" }
  /** 双指轻点：中点落在画布内，整串作废 */
  | { kind: "two-finger-skip" }
  /** 双指轻点：记下第一下，等第二下 */
  | { kind: "two-finger-first" }
  /** 双指双击成立：跑设置里的动作 */
  | { kind: "two-finger-redo"; mid: Pt }
  /** 双击落在别的画布上（或当前画布没映射动作）：聚焦并适配 */
  | { kind: "focus-canvas"; index: number }
  /** 双击落在画布外的边距上 */
  | { kind: "margin-double" }
  /** 双击落在画布上（该动作已映射） */
  | { kind: "canvas-double" }
  /** 三击（落在画布内＝放大，会顺手撤销前一下画的那一个点） */
  | { kind: "triple"; overDoc: boolean; undoSingleDot: boolean };

/**
 * 轻点序列状态机。
 *
 * 持有：单指连点计数与上一次的时间/落点、双指轻点的上一次时间/中点、以及
 * 「上一次完成的单击画了什么」——三击放大时要把那一个点撤销掉，免得留下一个孤点。
 */
export class TapMachine {
  /** 单指连点计数（1 = 第一下；2 = 第二下……） */
  private n = 0;
  /** 上一次单击的时间 */
  private t = 0;
  /** 上一次单击的落点 */
  private pt: Pt | null = null;
  /** 上一次**双指轻点**的时间 */
  private two = 0;
  /** 上一次双指轻点的中点 */
  private twoPt: Pt | null = null;
  /** 这一次手势的双指中点（抬起时用来判「落在画上」与双击距离） */
  private twoMid: Pt | null = null;
  /** 这一次手势有没有出现过两根手指 */
  private hadTwo = false;
  /** 上一次完成的单击「是不是没动过就落了一笔」（点） */
  private lastWasDraw = false;
  /** 那一下是不是真的记进了历史（否则没东西可撤） */
  private lastChanged = false;

  /** 第二根手指落下：记住双指中点，这一次手势就带上「双指」标记 */
  noteSecondFinger(a: Pt, b: Pt): void {
    this.twoMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.hadTwo = true;
  }

  /** 当前手势的双指中点（没出现过双指时为 null）——View 用它算「中点是否落在画布内」 */
  twoMidPoint(): Pt | null {
    return this.twoMid;
  }

  /**
   * 清掉双指轻点序列：第 3/4 根手指落下、四指手势成立、双指长按已经触发、
   * 以及 `pointercancel` 都要调它。**不动单指连点计数** —— 单指序列不该被多指打断
   * （多指落下时早先那一下单击仍然算数，改这里会让「单击后误触两指」断掉三击）。
   */
  clearTwoTapSeq(): void {
    this.two = 0;
    this.twoPt = null;
    this.twoMid = null;
    this.hadTwo = false;
  }

  /** 一笔提交完，记下「这一下单击画了没有」给三击用 */
  noteSingleTap(painted: boolean, changed: boolean): void {
    this.lastWasDraw = painted;
    this.lastChanged = changed;
  }

  /** 抬手：算出这次抬手算什么（**只读入参、只改自己的状态**，没有副作用） */
  up(i: TapUpInput): TapOutcome {
    // 双指序列优先：只要这一次手势出现过两根手指，且没缩放 / 没在画 / 没在选 / 没在变换
    const hadTwo = this.hadTwo;
    this.hadTwo = false;
    if (hadTwo && !i.pinchZoomed && !i.hasStroke && !i.hasSelDrag && !i.hasXf && this.twoMid) {
      const mid = this.twoMid;
      this.twoMid = null;
      if (i.midOverDoc) {
        this.two = 0;
        this.twoPt = null;
        return { kind: "two-finger-skip" };
      }
      if (this.twoPt && i.now - this.two < i.doubleTapMs &&
        Math.hypot(mid.x - this.twoPt.x, mid.y - this.twoPt.y) < TWO_TAP_PX) {
        this.two = 0;
        this.twoPt = null;
        return { kind: "two-finger-redo", mid };
      }
      this.two = i.now;
      this.twoPt = mid;
      return { kind: "two-finger-first" };
    }
    // 拖动过的第二次点击不算连点（一笔画完就断串）
    if (i.moved) {
      this.n = 0;
      return { kind: "plain" };
    }
    const cont = !i.isPc && this.n > 0 && i.now - this.t < TAP_SEQ_MS && this.pt &&
      Math.hypot(i.pt.x - this.pt.x, i.pt.y - this.pt.y) < TAP_SEQ_PX;
    this.n = cont ? this.n + 1 : 1;
    this.t = i.now;
    this.pt = { x: i.pt.x, y: i.pt.y };
    // 双击画布：换画布＝聚焦适配；当前画布只有在「双击画布」没映射动作时才走这条
    if (this.n === 2 && i.canvasIndex >= 0 && (i.canvasIndex !== i.docIndex || !i.canvasDoubleMapped)) {
      this.n = 0;
      return { kind: "focus-canvas", index: i.canvasIndex };
    }
    if (this.n === 2 && !i.overDoc) {
      this.n = 0;
      return { kind: "margin-double" };
    }
    if (this.n === 2 && i.overDoc && i.canvasDoubleMapped) {
      this.n = 0;
      return { kind: "canvas-double" };
    }
    if (this.n === 3) {
      this.n = 0;
      let undoSingleDot = false;
      if (i.overDoc) {
        // 三击＝放大：先把前一下留下的那个点撤掉（只在真的画过、且还有历史时）
        undoSingleDot = this.lastWasDraw && this.lastChanged;
        this.lastWasDraw = false;
        this.lastChanged = false;
      }
      return { kind: "triple", overDoc: i.overDoc, undoSingleDot };
    }
    if (this.n === 2 && i.overDoc) {
      // 第二下落在画布内但没映射动作：吞掉它、**不清零**，留给第三下（三击）
      return { kind: "skip" };
    }
    return { kind: "plain" };
  }
}
