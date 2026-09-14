// InputServer（手势策略与算术）—— 见 docs/ARCHITECTURE.md §3.3 第 5 项。
//
// 这一片搬出来的是**策略判定与算术**，全是纯函数、无 DOM、无 Session：
//   · 鼠标按键 → 意图（中键＝聚焦适配；右键 / 空格+左键＝用另一个色槽绘制）
//   · 双指 pinch 的缩放与平移解算（锚点＝两指中点，缩放夹在 zoomMin..zoomMax）
//   · 四指手势的"是否已经划动"判定（≥2 根手指各自离开落点超过阈值）
//   · 落点是否在画布外、长按是否可用（有些长按动作必须落在画布内）
//   · 多指点击序列的落点容差
//
// **还没搬的**（P5 的后两片，见 §9 进度）：手势会话状态（pointers / pinchBase / twoTap /
// fourSeen …）与 onDown/onMove/onUp 里各分支的**动作体** —— 那些要碰 stroke / xf / 选区 /
// 会话，得连着真机回归一起做，不适合一次搬完。
import type { Viewport } from "./viewport";

/** 一个屏幕点（逻辑坐标，CSS px） */
export interface Pt {
  x: number;
  y: number;
}

/** 修饰键：触屏没有这些键，所以只有 PC 模式下的鼠标路径会用到 */
export interface GestureMods {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  space: boolean;
}

export function modsOf(e: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean }, space: boolean): GestureMods {
  return { shift: !!e.shiftKey, ctrl: !!e.ctrlKey, alt: !!e.altKey, space };
}

/** 鼠标按下要做什么（触屏不走这里） */
export type MouseIntent = "focus-fit" | "secondary" | "primary";

/**
 * PC 鼠标：中键＝聚焦并适配当前画布（不是平移）、右键或空格+左键＝用**另一个色槽**
 * （默认背景色）绘制，其余＝主色槽。
 */
export function mouseButtonIntent(button: number, space: boolean): MouseIntent {
  if (button === 1) return "focus-fit";
  if (button === 2 || (button === 0 && space)) return "secondary";
  return "primary";
}

/** 点是否落在画布（文档）外 */
export function outsideDoc(p: Pt, docW: number, docH: number): boolean {
  return p.x < 0 || p.y < 0 || p.x >= docW || p.y >= docH;
}

/**
 * 长按动作里哪些**必须落在画布内**才允许触发：取色与放大/缩小要看像素，
 * 落在画布外的长按留给"平移 / 别的手势"。（画布外的长按菜单是另一回事。）
 */
export function longPressNeedsDoc(action: string): boolean {
  return action === "pickColor" || action === "zoomIn" || action === "zoomOut";
}

/** 触屏长按是否该开始：PC 不用（有右键/快捷键），且看清是否落在画布内 */
export function longPressAllowed(o: {
  isPc: boolean;
  action: string;
  /** 当前是否允许取色（有选区、或当前是选区类工具时不允许） */
  pickAllowed: boolean;
  insideDoc: boolean;
}): boolean {
  if (o.isPc) return false;
  if (!o.insideDoc) return false;
  return !longPressNeedsDoc(o.action) || o.pickAllowed;
}

/** 四指手势的划动阈值（px，逻辑屏幕像素）；设置里可覆盖（`prefs.fourFingerPx`） */
export const FOUR_MOVE_PX_DEFAULT = 15;

/**
 * 四指手势是否"已经划动"：**至少两根**手指各自离开自己的落点超过阈值（方向不限）。
 * 按每根手指自己的落点算，所以晚落/早抬的手指不会削弱判定。
 */
export function fourFingerArmed(
  pointers: Iterable<[number, Pt]>, starts: Map<number, Pt>, threshold: number,
): boolean {
  let moving = 0;
  for (const [pid, p] of pointers) {
    const s = starts.get(pid);
    if (s && Math.hypot(p.x - s.x, p.y - s.y) > threshold) moving++;
    if (moving >= 2) return true;
  }
  return false;
}

/** 多指点击（轻点）的落点容差：超过就不算同一次连点 */
export const TAP_SLOP_PX = 24;

export function withinTapSlop(a: Pt, b: Pt, slop = TAP_SLOP_PX): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= slop;
}

// ------------------------------------------------------------------ pinch
/** 双指捏合的即时几何：中点与两指距离（距离下限 1 避免除零） */
export interface PinchNow {
  mx: number;
  my: number;
  dist: number;
}

export function pinchNow(a: Pt, b: Pt): PinchNow {
  return {
    mx: (a.x + b.x) / 2,
    my: (a.y + b.y) / 2,
    dist: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
  };
}

/** 双指起始时冻结的视图状态：以中点 (mx,my) 为不动点缩放的基准 */
export interface PinchBase extends PinchNow {
  ox: number;
  oy: number;
  zoom: number;
}

export function pinchBaseOf(a: Pt, b: Pt, v: Viewport): PinchBase {
  const n = pinchNow(a, b);
  return { ...n, ox: v.ox, oy: v.oy, zoom: v.zoom };
}

/** 缩放是否算"真的动过"（用来区分「双指轻点」与「双指缩放」） */
export const PINCH_EPS = 0.001;

/**
 * 双指捏合 → 新的视图变换。
 *
 * 口径：**中点是不动点** —— 手指之间的那个点始终盯着同一处画面，
 * `ox' = mx − (mx₀ − ox₀)·k`，k = 新缩放 / 起始缩放。缩放夹在 zoomMin..zoomMax；
 * 夹住了也仍然是"不动点缩放"（不会像先夹后算那样把锚点算飞）。
 */
export function pinchAround(
  base: PinchBase, now: PinchNow, zoomMin: number, zoomMax: number,
): { zoom: number; ox: number; oy: number; zoomed: boolean } {
  const k = now.dist / base.dist;
  const raw = base.zoom * k;
  const z = raw < zoomMin ? zoomMin : raw > zoomMax ? zoomMax : raw;
  const sc = z / base.zoom;
  return {
    zoom: z,
    ox: now.mx - (base.mx - base.ox) * sc,
    oy: now.my - (base.my - base.oy) * sc,
    zoomed: Math.abs(z - base.zoom) > PINCH_EPS,
  };
}
