// 等距图形（2:1 像素几何）—— 把「基础等距体」生成为像素。
//
// 口径（见 docs/PLAN-isobuilder.md §2，已锁进 tests/iso.test.ts 的黄金值）：
//   一格的顶面 = T×T/2 像素的菱形，1 单位高度 = T/2 像素，
//   所以 1×1×1 的立方体正好是 T×T 像素的正方形外框。
//   投影： sx = (x - y) * T/2， sy = (x + y) * T/4 - z * T/2
//
// 立方体的「行宽模板」（自上而下 T 行）恰好能铺满平面（相邻格偏移 (T/2, T/4)），
// 所以渲染器直接拿它当 stamp：顶面用菱形模板，两个侧面用六边形减菱形的部分。
// 纯函数：无 DOM、无 Session，方便直接单测。
import { rgbToHsl } from "./adjust";
import { SHADING_DEFAULTS, shadingRamps, type ShadingParams } from "./shading";
import type { RGBA } from "./types";

/** 每格像素宽（2:1 固定：顶面 T×T/2、每单位高度 T/2）。4 = 图标尺寸的迷你方块（4×4 px） */
export const ISO_TILES = [4, 8, 16, 32] as const;
export type IsoTile = (typeof ISO_TILES)[number];
export const ISO_TILE_DEFAULT: IsoTile = 16;

/** 体素上限（误填 999 的护城河）：32×32×32 = 32768 只是常规量级，这里给足余量 */
export const ISO_MAX_VOXELS = 262144;

// ---------------------------------------------------------------- 体素网格

export interface Voxels {
  /** 宽（x 方向格数） / 深（y 方向格数） / 高（z 层数） */
  w: number; d: number; h: number;
  /** 1 = 实心；下标 = (z * d + y) * w + x */
  data: Uint8Array;
}

export function makeVoxels(w: number, d: number, h: number): Voxels {
  return { w, d, h, data: new Uint8Array(Math.max(0, w * d * h)) };
}

export function voxelAt(v: Voxels, x: number, y: number, z: number): boolean {
  if (x < 0 || y < 0 || z < 0 || x >= v.w || y >= v.d || z >= v.h) return false;
  return v.data[(z * v.d + y) * v.w + x] === 1;
}

function setVoxel(v: Voxels, x: number, y: number, z: number): void {
  if (x < 0 || y < 0 || z < 0 || x >= v.w || y >= v.d || z >= v.h) return;
  v.data[(z * v.d + y) * v.w + x] = 1;
}

export function voxelCount(v: Voxels): number {
  let n = 0;
  for (let i = 0; i < v.data.length; i++) if (v.data[i]) n++;
  return n;
}

/** 占用的体积上限检查（UI 在改参数时先问它，别等渲染才发现） */
export function isoWithinBudget(w: number, d: number, h: number): boolean {
  return w * d * h <= ISO_MAX_VOXELS;
}

// ---------------------------------------------------------------- 形状库

/** 基础等距体的形状；加形状 = 加一个 id + 一个函数 + 一条 i18n + 一个 chip */
export const ISO_SHAPES = ["box", "steps", "wedge", "cylinder", "pyramid", "frame"] as const;
export type IsoShapeId = (typeof ISO_SHAPES)[number];

export interface IsoShapeParams {
  shape: IsoShapeId;
  /** 足迹宽（x 格数） */
  w: number;
  /** 足迹深（y 格数） */
  d: number;
  /** 高度（z 层数） */
  h: number;
  /** steps：级数；wedge：不用 */
  steps: number;
  /** steps / wedge 的坡向轴 */
  axis: "x" | "y";
  /** steps / wedge：1 = 正向递增，-1 = 反向 */
  dir: 1 | -1;
  /** cylinder / pyramid：足迹半径（格） */
  radius: number;
  /** cylinder：空心（留壁厚 thickness） */
  hollow: boolean;
  /** pyramid：顶部平顶尺寸（格），0 = 尖顶 */
  topW: number;
  topD: number;
  /** frame：壁厚（格） */
  thickness: number;
}

export const ISO_SHAPE_DEFAULTS: IsoShapeParams = {
  shape: "box", w: 3, d: 3, h: 2,
  steps: 4, axis: "x", dir: 1,
  radius: 3, hollow: false, topW: 0, topD: 0, thickness: 1,
};

const clampInt = (v: number, a: number, b: number) => Math.max(a, Math.min(b, Math.round(Number.isFinite(v) ? v : a)));

/** 夹到合法范围（半径按 2:1 的圆盘最大格数给上限，高度上限 64） */
export function normalizeShapeParams(p: Partial<IsoShapeParams>): IsoShapeParams {
  const src = { ...ISO_SHAPE_DEFAULTS, ...p };
  const shape = (ISO_SHAPES as readonly string[]).includes(src.shape) ? src.shape : "box";
  const w = clampInt(src.w, 1, 64), d = clampInt(src.d, 1, 64), h = clampInt(src.h, 1, 64);
  return {
    shape,
    w, d, h,
    steps: clampInt(src.steps, 2, Math.max(2, Math.max(w, d))),
    axis: src.axis === "y" ? "y" : "x",
    dir: src.dir === -1 ? -1 : 1,
    radius: clampInt(src.radius, 1, Math.max(2, Math.ceil(Math.max(w, d) / 2))),
    hollow: !!src.hollow,
    topW: clampInt(src.topW, 0, w),
    topD: clampInt(src.topD, 0, d),
    thickness: clampInt(src.thickness, 1, Math.max(1, Math.floor(Math.min(w, d) / 2)) || 1),
  };
}

/**
 * 形状 → 体素。六个基础形状都是「参数化的纯函数」，互不依赖；
 * 后面加柱础 / 拱门 / 棱柱等，只往这里追加分支。
 */
export function isoShapeVoxels(input: Partial<IsoShapeParams>): Voxels {
  const p = normalizeShapeParams(input);
  const { w, d, h } = p;
  const v = makeVoxels(w, d, h);
  switch (p.shape) {
    case "box":
      v.data.fill(1);
      break;
    case "steps": {
      // 沿 axis 分 steps 级，逐级升高；dir = -1 时反向
      const span = p.axis === "x" ? w : d;
      const n = Math.max(1, Math.min(p.steps, span));
      for (let z = 0; z < h; z++) {
        for (let y = 0; y < d; y++) {
          for (let x = 0; x < w; x++) {
            const i = p.axis === "x" ? x : y;
            const band = Math.min(n - 1, Math.floor((i * n) / span));
            const rank = p.dir === 1 ? band : n - 1 - band;
            const top = Math.max(1, Math.round((h * (rank + 1)) / n));
            if (z < top) setVoxel(v, x, y, z);
          }
        }
      }
      break;
    }
    case "wedge": {
      // 单向斜坡：沿 axis 线性降到 1 层
      const span = p.axis === "x" ? w : d;
      for (let z = 0; z < h; z++) {
        for (let y = 0; y < d; y++) {
          for (let x = 0; x < w; x++) {
            const i = p.axis === "x" ? x : y;
            const t = span <= 1 ? 1 : (i + 0.5) / span;
            const top = Math.max(1, Math.round(h * (p.dir === 1 ? 1 - t : t)));
            if (z < top) setVoxel(v, x, y, z);
          }
        }
      }
      break;
    }
    case "cylinder": {
      // 足迹 = 格空间里的圆盘（2:1 由投影负责），可空心。
      // 判定用「格子的四个角 + 中心」五个采样点，取多数：只测中心的话，半径 4 的圆盘
      // 在对角线上会被啃成十字形（实测），多采样能把台阶补顺。
      const cx = (w - 1) / 2, cy = (d - 1) / 2;
      const r = p.radius;
      const inner = p.hollow ? Math.max(0, r - p.thickness) : -1;
      const inside = (x: number, y: number, rad: number): boolean => {
        const pts = [[x, y], [x - 0.5, y - 0.5], [x + 0.5, y - 0.5], [x - 0.5, y + 0.5], [x + 0.5, y + 0.5]];
        let n = 0;
        for (const [px, py] of pts) if (Math.hypot(px - cx, py - cy) <= rad) n++;
        return n >= 3;
      };
      for (let y = 0; y < d; y++) {
        for (let x = 0; x < w; x++) {
          if (!inside(x, y, r)) continue;
          if (inner >= 0 && inside(x, y, inner) && Math.hypot(x - cx, y - cy) <= inner) continue;
          for (let z = 0; z < h; z++) setVoxel(v, x, y, z);
        }
      }
      break;
    }
    case "pyramid": {
      // 逐层线性收缩，可留平顶（topW / topD，0 = 收到 1 格）
      const tw = p.topW > 0 ? p.topW : 1;
      const td = p.topD > 0 ? p.topD : tw;
      for (let z = 0; z < h; z++) {
        const t = h <= 1 ? 0 : z / (h - 1);
        const cw = Math.max(1, Math.round(w + (tw - w) * t));
        const cd = Math.max(1, Math.round(d + (td - d) * t));
        const x0 = Math.floor((w - cw) / 2), y0 = Math.floor((d - cd) / 2);
        for (let y = y0; y < y0 + cd && y < d; y++) {
          for (let x = x0; x < x0 + cw && x < w; x++) setVoxel(v, x, y, z);
        }
      }
      break;
    }
    case "frame": {
      // 空心框 / 拱门：四面留壁厚 t
      const t = p.thickness;
      for (let z = 0; z < h; z++) {
        for (let y = 0; y < d; y++) {
          for (let x = 0; x < w; x++) {
            if (x < t || y < t || x >= w - t || y >= d - t) setVoxel(v, x, y, z);
          }
        }
      }
      break;
    }
  }
  return v;
}

// ---------------------------------------------------------------- 渲染

/** 仅外观相关的渲染参数（形状参数另传），便于 UI 分开存 */
export interface IsoLook {
  tile: IsoTile;
  /** 顶面 / 右面（+x）/ 左面（+y）三个颜色 */
  faces: { top: RGBA; right: RGBA; left: RGBA };
  /** 接触阴影：在物体之前画一圈偏移的暗色 */
  shadow: "off" | "contact";
  shadowColor: RGBA;
  /** 外轮廓 1px 暗边（像素画常见需求） */
  outline: boolean;
  outlineColor: RGBA;
}

export interface IsoRenderResult {
  /** 紧凑缓冲：左上角就是外接框原点（含阴影与描边的余量） */
  px: Uint8ClampedArray;
  w: number;
  h: number;
  /**
   * **地面原点**（格 `(0,0,0)` 的顶顶点）在这个缓冲里的位置。
   * 变形状 / 变尺寸时缓冲大小会变，靠它当锚点，预览才不会跳 —— 调用方按
   * `screen = 画布原点 + originAt` 摆缓冲即可。
   */
  originAt: { x: number; y: number };
  /** 实际点亮的体素数 / 写下的像素数 */
  voxels: number;
  pixels: number;
}

/** 足迹菱形的四个角（相对**地面原点**的局部像素坐标；± 与投影口径一致） */
export function isoGroundCorners(tile: IsoTile, w: number, d: number): {
  top: { x: number; y: number }; right: { x: number; y: number };
  bottom: { x: number; y: number }; left: { x: number; y: number };
} {
  const T = tile;
  return {
    top: { x: 0, y: 0 },
    right: { x: (w * T) / 2, y: (w * T) / 4 },
    bottom: { x: ((w - d) * T) / 2, y: ((w + d) * T) / 4 },
    left: { x: (-d * T) / 2, y: (d * T) / 4 },
  };
}

/** 顶面中心（高度抓手的锚点）：足迹菱形中心再往上 `h * T/2` */
export function isoHeightHandle(tile: IsoTile, w: number, d: number, h: number): { x: number; y: number } {
  const T = tile;
  return { x: ((w - d) * T) / 4, y: ((w + d) * T) / 8 - (h * T) / 2 };
}

/** 把屏幕增量拆成「沿两条等距轴走几格」：a = +x 方向，b = +y 方向（doc 像素单位） */
export function isoDeltaToCells(tile: IsoTile, ddx: number, ddy: number): { a: number; b: number } {
  const T = tile;
  return { a: (ddx + 2 * ddy) / T, b: (2 * ddy - ddx) / T };
}

/**
 * 落点是否正好在 2:1 栅格**节点**上。
 *
 * 栅格节点＝两条等距轴各走整数格的点：`i·(T/2, T/4) + j·(-T/2, T/4)`，
 * 所以 x 是 T/2 的整数倍、y 是 T/4 的整数倍，**并且两者同奇偶**
 * （x/(T/2) 与 y/(T/4) 的奇偶性必须一致）。
 *
 * 为什么不能分别对 x、y 取整：那样会吸到 `(0, T/4)` 这种「格子边缘中点」上，
 * 形状看着就在两行网格线中间 —— 用户看到的现象就是「生成的图形没和网格对齐」。
 */
export function isoOnLattice(tile: IsoTile, x: number, y: number): boolean {
  const sx = tile / 2, sy = tile / 4;
  const u = x / sx, v = y / sy;
  return Number.isInteger(u) && Number.isInteger(v) && (((u + v) % 2) + 2) % 2 === 0;
}

/** 吸附到**最近的栅格节点**（在候选里按像素距离取最近，保证结果一定在栅格上） */
export function isoSnapOrigin(tile: IsoTile, x: number, y: number): { x: number; y: number } {
  const sx = tile / 2, sy = tile / 4;
  const u0 = Math.round(x / sx), v0 = Math.round(y / sy);
  let bx = u0 * sx, by = v0 * sy, bd = Infinity;
  for (let du = -1; du <= 1; du++) {
    for (let dv = -1; dv <= 1; dv++) {
      const u = u0 + du, v = v0 + dv;
      if ((((u + v) % 2) + 2) % 2 !== 0) continue;      // 半格位置：不是节点
      const px = u * sx, py = v * sy;
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < bd) { bd = d; bx = px; by = py; }
    }
  }
  return { x: bx, y: by };
}

/**
 * 落点：把理想位置吸到栅格上，再保证整块缓冲**落在画布内**。
 *
 * 移动只能沿栅格轴走（`+x` 一格 = `(+T/2, +T/4)`，`+y` 一格 = `(-T/2, +T/4)`），
 * 所以「往右挪一点」必然带着往下一点 —— 早先按 x / y 各自加减 T/2 / T/4，
 * 挪完就离开了栅格（形状和网格错半格）。形状比画布还大时只保证左上不越界。
 */
export function isoPlaceOrigin(
  tile: IsoTile,
  box: { w: number; h: number; originAt: { x: number; y: number } },
  docW: number, docH: number,
  want: { x: number; y: number },
): { x: number; y: number } {
  const s = isoSnapOrigin(tile, want.x, want.y);
  const sx = tile / 2, sy = tile / 4;
  const left = (o: { x: number; y: number }) => o.x - box.originAt.x;
  const top = (o: { x: number; y: number }) => o.y - box.originAt.y;
  const fits = (o: { x: number; y: number }) =>
    left(o) >= 0 && top(o) >= 0 && left(o) + box.w <= docW && top(o) + box.h <= docH;
  if (fits(s)) return s;
  // 按「离理想节点几格」从近到远扫，先撞上完全放得下的就返回；
  // 一个都没有（形状比画布大）就退到「左上不越界」里最近的那个
  let loose: { x: number; y: number } | null = null;
  const N = 96;
  for (let cost = 1; cost <= 2 * N; cost++) {
    for (let i = -cost; i <= cost; i++) {
      const jAbs = cost - Math.abs(i);
      const js = jAbs === 0 ? [0] : [jAbs, -jAbs];
      for (const j of js) {
        const o = { x: s.x + (i - j) * sx, y: s.y + (i + j) * sy };
        if (fits(o)) return o;
        if (!loose && left(o) >= 0 && top(o) >= 0) loose = o;
      }
    }
  }
  return loose ?? s;
}

/**
 * 三档面色：单色基色 → 顶面最亮、右面基色、左面最暗。
 * 直接复用 `engine/shading.ts` 的明暗行（强度 / 亮度峰值 / 温度权重都能调），
 * 默认 `sway: 0`（纯明暗、不掺温度色），符合等距方块的习惯。
 */
export function isoFaceColours(base: RGBA, shade?: Partial<ShadingParams>): { top: RGBA; right: RGBA; left: RGBA } {
  const p = { ...SHADING_DEFAULTS, intensity: 18, peak: 55, sway: 0, ...shade };
  const r = shadingRamps(base, base, p);
  return { top: r.shade[6], right: [base[0], base[1], base[2], base[3]], left: r.shade[0] };
}

/** 顶面菱形的行宽（高 T/2 行）—— 与六边形模板同源，能无缝铺满 */
export function isoDiamondRows(tile: IsoTile): number[] {
  const T = tile, H = T / 2, out: number[] = [];
  for (let j = 0; j < H; j++) out.push(2 + 4 * Math.min(j, H - 1 - j));
  return out;
}

/** 立方体的行宽（T 行）：上半菱形 → 满宽 → 下半菱形收窄 */
export function isoHexRows(tile: IsoTile): number[] {
  const T = tile, Q = T / 4, out: number[] = [];
  for (let j = 0; j < T; j++) {
    if (j < Q) out.push(2 + 4 * j);
    else if (j < T - Q) out.push(T);
    else out.push(2 + 4 * (T - 1 - j));
  }
  return out;
}

/** 一个体素的 stamp 左上角（未含外接框平移） */
function voxelOrigin(tile: IsoTile, x: number, y: number, z: number): { ox: number; oy: number } {
  const T = tile;
  return { ox: (x - y) * (T / 2) - T / 2, oy: (x + y) * (T / 4) - z * (T / 2) };
}

/** 阴影相对物体的像素偏移（右下一点，留出一条接触暗边） */
export function isoShadowOffset(tile: IsoTile): { x: number; y: number } {
  return { x: Math.max(1, Math.round(tile / 8)), y: Math.max(1, Math.round(tile / 16)) };
}

/**
 * 渲染。只画到**外接框**：先扫一遍求包围盒，再往缓冲写，画布再大也不慢。
 * 绘制顺序：`x + y` 递增（远→近），同深度内 `z` 递增（下→上）；
 * 每个体素只画没被遮挡的面。
 */
export function isoRender(v: Voxels, look: IsoLook): IsoRenderResult {
  const T = look.tile;
  const hex = isoHexRows(T);
  const dia = isoDiamondRows(T);
  const c = T / 2;                       // 对称轴位于 c-1 与 c 之间
  const sh = look.shadow === "contact" ? isoShadowOffset(T) : { x: 0, y: 0 };
  const pad = look.outline ? 1 : 0;

  // ---- 1) 包围盒：物体 + 阴影 + 描边余量
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  for (let z = 0; z < v.h; z++) {
    for (let y = 0; y < v.d; y++) {
      for (let x = 0; x < v.w; x++) {
        if (!voxelAt(v, x, y, z)) continue;
        any = true;
        const o = voxelOrigin(T, x, y, z);
        if (o.ox < minX) minX = o.ox;
        if (o.ox + T - 1 > maxX) maxX = o.ox + T - 1;
        if (o.oy < minY) minY = o.oy;
        if (o.oy + T - 1 > maxY) maxY = o.oy + T - 1;
      }
    }
  }
  if (!any) return { px: new Uint8ClampedArray(0), w: 0, h: 0, originAt: { x: 0, y: 0 }, voxels: 0, pixels: 0 };
  minX -= pad; minY -= pad; maxX += pad + sh.x; maxY += pad + sh.y;
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const px = new Uint8ClampedArray(w * h * 4);
  // 地面原点：与「有没有体素」无关的几何点，所以圆柱这类 (0,0) 不在足迹里的形状也有稳定锚点。
  // 取的是格 (0,0) 顶面菱形的**顶点**（stamp 的对称轴 `c` 处），不是 stamp 左上角：
  // stamp 从 `-T/2` 起画，左上角比顶点偏左 T/2，早先直接拿左上角当锚点，
  // 栅格 / 足迹虚线 / 抓手就整体比形状偏左半格 —— 看起来正是「生成图形没和网格对齐」。
  const g0 = voxelOrigin(T, 0, 0, 0);
  const originAt = { x: g0.ox + c - minX, y: g0.oy - minY };

  const put = (x: number, y: number, col: RGBA) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    const a = col[3] / 255;
    if (a <= 0) return;
    const da = px[i + 3] / 255;
    if (a >= 1 || da === 0) {
      px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2];
      px[i + 3] = Math.round(a * 255);
      return;
    }
    // 真 source-over：阴影可能叠在已画好的像素上，直接取 max 会把半透明算错
    const oa = a + da * (1 - a);
    px[i] = (col[0] * a + px[i] * da * (1 - a)) / oa;
    px[i + 1] = (col[1] * a + px[i + 1] * da * (1 - a)) / oa;
    px[i + 2] = (col[2] * a + px[i + 2] * da * (1 - a)) / oa;
    px[i + 3] = Math.round(oa * 255);
  };

  // ---- 2) 接触阴影：足迹上每个有内容的格，画一块偏移的顶面菱形
  if (look.shadow === "contact") {
    for (let y = 0; y < v.d; y++) {
      for (let x = 0; x < v.w; x++) {
        let solid = false;
        for (let z = 0; z < v.h && !solid; z++) if (voxelAt(v, x, y, z)) solid = true;
        if (!solid) continue;
        const o = voxelOrigin(T, x, y, 0);
        const bx = o.ox - minX + sh.x, by = o.oy - minY + sh.y;
        for (let j = 0; j < dia.length; j++) {
          const rw = dia[j];
          const x0 = bx + c - rw / 2;
          for (let k = 0; k < rw; k++) put(x0 + k, by + j, look.shadowColor);
        }
      }
    }
  }

  // ---- 3) 由远及近、由下到上 stamp 每个体素
  const order: Array<{ x: number; y: number; z: number }> = [];
  for (let z = 0; z < v.h; z++) {
    for (let s = 0; s <= v.w + v.d - 2; s++) {
      for (let x = Math.max(0, s - v.d + 1); x <= Math.min(v.w - 1, s); x++) {
        const y = s - x;
        if (voxelAt(v, x, y, z)) order.push({ x, y, z });
      }
    }
  }
  let pixels = 0;
  for (const cell of order) {
    const { x, y, z } = cell;
    const topVisible = !voxelAt(v, x, y, z + 1);
    const rightVisible = !voxelAt(v, x + 1, y, z);
    const leftVisible = !voxelAt(v, x, y + 1, z);
    if (!topVisible && !rightVisible && !leftVisible) continue;
    const o = voxelOrigin(T, x, y, z);
    const bx = o.ox - minX, by = o.oy - minY;
    for (let j = 0; j < T; j++) {
      const rw = hex[j];
      const x0 = bx + c - rw / 2;
      // 顶面菱形在该行覆盖的**局部**列范围（lx 与这里同一套坐标，别混进 bx）
      const dw = j < dia.length ? dia[j] : 0;
      const topLo = c - dw / 2, topHi = topLo + dw - 1;
      for (let k = 0; k < rw; k++) {
        const lx = c - rw / 2 + k;                       // 该行第 k 列相对对称轴的位置
        const isTop = j < dia.length && lx >= topLo && lx <= topHi;
        const col = isTop
          ? (topVisible ? look.faces.top : null)
          : (lx < c ? (leftVisible ? look.faces.left : null) : (rightVisible ? look.faces.right : null));
        if (!col) continue;
        put(x0 + k, by + j, col);
        pixels++;
      }
    }
  }

  // ---- 4) 外轮廓 1px 暗边：透明像素若有实心邻居就补上
  if (look.outline) {
    const ring: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] !== 0) continue;
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dy] of nb) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (px[(ny * w + nx) * 4 + 3] !== 0) { ring.push(x, y); break; }
        }
      }
    }
    for (let i = 0; i < ring.length; i += 2) put(ring[i], ring[i + 1], look.outlineColor);
  }

  return { px, w, h, originAt, voxels: order.length, pixels };
}

/** 便捷：从基色 + 形状参数直接出图（单色三档） */
export function isoRenderShape(shape: Partial<IsoShapeParams>, base: RGBA, look?: Partial<Omit<IsoLook, "faces">> & { shade?: Partial<ShadingParams> }): IsoRenderResult {
  const v = isoShapeVoxels(shape);
  const faces = isoFaceColours(base, look?.shade);
  const [, , l] = rgbToHsl(base[0], base[1], base[2]);
  const k = Math.max(0, Math.round(l * 255 * 0.3));
  return isoRender(v, {
    tile: look?.tile ?? ISO_TILE_DEFAULT,
    faces,
    shadow: look?.shadow ?? "contact",
    shadowColor: look?.shadowColor ?? [0, 0, 0, 90],
    outline: look?.outline ?? false,
    outlineColor: look?.outlineColor ?? [k, k, k, 255],
  });
}
