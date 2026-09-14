// ViewportServer —— 视图数学（见 docs/ARCHITECTURE.md §3.3 第 4 项）。
//
// 这里放**全部**缩放 / 平移 / 坐标映射的算术，全是纯函数：没有 DOM、没有 Session，
// 所以可以脱离浏览器单测（tests/viewport.test.ts）。状态（zoom / ox / oy）暂时仍由
// `View` 持有 —— UI 里 ui/canvas.tsx 直接读 `view.zoom`，等 UI 改成订阅信号后再搬。
//
// 口径（改之前先读，这四条各对应过一次真机问题）：
//   1. **屏幕坐标 = 逻辑坐标**：旋转不作用在逻辑坐标上，而是作为画布 transform 施加
//      （`rotationMatrix`），指针坐标用 `toLogical` 转回来 —— 别在这里混进旋转。
//   2. **以锚点为中心缩放**：`ox' = cx − (cx − ox)·k`，k = 新缩放 / 旧缩放。这样拖拽
//      缩放时光标下的那个像素不动。
//   3. `clampViewport` 保证画布不会被拖出屏幕：单画布夹到边；多画布（无限空间）保留
//      `SPACE_MARGIN` 像素可见，避免"画布被拖到永远找不回来"。
//   4. 适配缩放优先取整数倍（只有差值 < 0.18 才吸），否则像素画会出现非整数缩放下的
//      半格抖动。
import { clamp } from "../engine/types";

/** 视图旋转：只允许 90 的倍数 */
export type Rotation = 0 | 90 | 180 | 270;

/** 视口状态（屏幕像素单位：ox/oy 是文档原点在屏幕上的位置，zoom 是像素放大率） */
export interface Viewport {
  zoom: number;
  ox: number;
  oy: number;
}

/** 无限空间里的一张画布（坐标是空间单位，w/h 是文档尺寸） */
export interface SpaceEntry {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 多画布模式下至少要有这么多像素留在屏幕内 */
export const SPACE_MARGIN = 60;

/**
 * 适配视口的视图参数：整幅画布居中，尽量落在整数倍上。
 * `vpW/vpH` 是逻辑视口尺寸（旋转 90/270 时已交换过宽高）。
 */
export function fitTarget(docW: number, docH: number, vpW: number, vpH: number, zoomMin: number, zoomMax: number): Viewport {
  const aw = Math.max(24, vpW - 20);
  const ah = Math.max(24, vpH - 20);
  let z = Math.min(aw / docW, ah / docH);
  const zi = Math.floor(z);
  if (zi >= 1 && Math.abs(z - zi) < 0.18) z = zi;
  z = clamp(z, zoomMin, zoomMax);
  return { zoom: z, ox: (vpW - docW * z) / 2, oy: (vpH - docH * z) / 2 };
}

/**
 * 单画布夹取：画布比视口大时边缘不许进到视口内（否则会露出背景），
 * 比视口小时就把它夹在视口里（居中范围内可自由摆放）。
 */
export function clampSingle(v: Viewport, docW: number, docH: number, vpW: number, vpH: number): Viewport {
  const dw = docW * v.zoom;
  const dh = docH * v.zoom;
  return {
    zoom: v.zoom,
    ox: dw >= vpW ? clamp(v.ox, vpW - dw, 0) : clamp(v.ox, 0, Math.max(0, vpW - dw)),
    oy: dh >= vpH ? clamp(v.oy, vpH - dh, 0) : clamp(v.oy, 0, Math.max(0, vpH - dh)),
  };
}

/**
 * 无限空间夹取：以**聚焦画布**为坐标原点，把所有画布的外接框算出来，
 * 只要还有 `SPACE_MARGIN` 像素在屏幕里就允许 —— 既不会把画布拖丢，
 * 也不会像单画布那样把整片空间锁死。
 */
export function clampSpace(
  v: Viewport, focus: SpaceEntry, list: readonly SpaceEntry[], vpW: number, vpH: number,
): Viewport {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of list) {
    const rx = (e.x - focus.x) * v.zoom;
    const ry = (e.y - focus.y) * v.zoom;
    x0 = Math.min(x0, rx); y0 = Math.min(y0, ry);
    x1 = Math.max(x1, rx + e.w * v.zoom); y1 = Math.max(y1, ry + e.h * v.zoom);
  }
  return {
    zoom: v.zoom,
    ox: clamp(v.ox, SPACE_MARGIN - x1, vpW - SPACE_MARGIN - x0),
    oy: clamp(v.oy, SPACE_MARGIN - y1, vpH - SPACE_MARGIN - y0),
  };
}

/** 以屏幕点 (cx, cy) 为不动点缩放到 `z`（夹在 zoomMin..zoomMax） */
export function zoomAtPoint(v: Viewport, z: number, cx: number, cy: number, zoomMin: number, zoomMax: number): Viewport {
  const nz = clamp(z, zoomMin, zoomMax);
  const k = nz / v.zoom;
  return { zoom: nz, ox: cx - (cx - v.ox) * k, oy: cy - (cy - v.oy) * k };
}

/** 平移（屏幕像素增量） */
export function panBy(v: Viewport, dx: number, dy: number): Viewport {
  return { zoom: v.zoom, ox: v.ox + dx, oy: v.oy + dy };
}

/** 屏幕点 → 文档像素下标（向下取整：命中的是那一个像素，不是它的中心） */
export function screenToPixel(v: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: Math.floor((sx - v.ox) / v.zoom), y: Math.floor((sy - v.oy) / v.zoom) };
}

/**
 * 画布 transform：逻辑视口 → 真实表面 canvas（含 dpr 与旋转）。
 * 返回 `setTransform` 的六个参数（写成元组是为了能直接 `ctx.setTransform(...)`）。
 */
export function rotationMatrix(rot: Rotation, dpr: number, w: number, h: number): [number, number, number, number, number, number] {
  if (rot === 90) return [0, dpr, -dpr, 0, w * dpr, 0];
  if (rot === 180) return [-dpr, 0, 0, -dpr, w * dpr, h * dpr];
  if (rot === 270) return [0, -dpr, dpr, 0, 0, h * dpr];
  return [dpr, 0, 0, dpr, 0, 0];
}

/** 表面（指针 / DOM）点 → 逻辑点。`w/h` 是**表面**尺寸。 */
export function toLogical(rot: Rotation, w: number, h: number, x: number, y: number): { x: number; y: number } {
  if (rot === 90) return { x: y, y: w - x };
  if (rot === 180) return { x: w - x, y: h - y };
  if (rot === 270) return { x: h - y, y: x };
  return { x, y };
}

/** 逻辑点 → 表面点（DOM 覆盖层坐在表面空间里） */
export function toSurface(rot: Rotation, w: number, h: number, x: number, y: number): { x: number; y: number } {
  if (rot === 90) return { x: w - y, y: x };
  if (rot === 180) return { x: w - x, y: h - y };
  if (rot === 270) return { x: y, y: h - x };
  return { x, y };
}

/** 表面拖拽增量 → 空间单位增量（旋转感知；除以 zoom） */
export function surfaceDelta(rot: Rotation, zoom: number, dx: number, dy: number): { x: number; y: number } {
  if (rot === 90) return { x: dy / zoom, y: -dx / zoom };
  if (rot === 180) return { x: -dx / zoom, y: -dy / zoom };
  if (rot === 270) return { x: -dy / zoom, y: dx / zoom };
  return { x: dx / zoom, y: dy / zoom };
}
