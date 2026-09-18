// 参考图 → 挂给模型的图像（vision）：**尺寸夹取 / 体积判定 / 编码前的数据准备**。
//
// 为什么单独一层：这些判断**全是算术**，而真正的编码必须走 DOM（canvas 的 `toBlob`）。
// 把算术与 DOM 分开之后，「768 怎么算出来的」「为什么这张图要缩小」「超限时到底拦不拦」
// 都能在没有浏览器的 Node 测试里逐条钉住（`tests/ai-vision.test.ts`）——
// 页面侧只剩三行：`putImageData` → `pngBytes()` → `bytesToDataUrl()`。
//
// 三条口径（都对应真实的上限，不是拍脑袋的常数）：
//
//   1. **最长边 ≤ 768px，只缩不放**（`clampImageSize`）。像素画放大只是把同样的信息铺开，
//      对模型没有新信息，却会让 PNG 与 base64 一起变大 —— 所以宁可放大方向上一个字节都不动。
//   2. **data URL ≤ 512 KiB（软）/ 768 KiB（硬）**（`fitEncodedImage`）。这条上限的来源是
//      **我们自己的桌面壳**：`toolchain/pc-shell.mjs` 的 `MAX_BODY_BYTES` = 1 MiB，
//      超了直接回 HTTP 413「请求太大」（页面侧的 `hostError()` 翻成一句中文）。
//      1 MiB 是**整个请求体**（messages + 61 个工具的 schema + 系统提示词），所以单张图
//      必须留足余量：512 KiB 软线 + 768 KiB 硬线，剩下的空间给文本与工具表还有一倍富余。
//      超硬线时**不静默截断、也不静默发出去**：返回一句中文原因让调用方拦下来（`reason`）。
//   3. **缩小优先整数比例 + 最近邻**（`clampImageSize` 的 `exactDivisor`）：整数倍时最近邻
//      既快又**逐像素等于**「抽掉整行整列」，不会在像素画的硬边上插出半透明的新颜色；
//      非整数比例才交给 `engine/resample.ts` 的既有重采样（`bilinear`）。
//   4. **源图任一边超过 1024（引擎契约）时，这一层自己降采样**（`downscaleOutOfContract()`）。
//      `engine/resample.ts` 对越界的源不报错、只回一块**全透明**的等长缓冲区 —— 参考图若走那条路，
//      结果就是「发出去的是空白图，说明里还写着已缩到 768×768」。这是本轮实测出来的缺陷，
//      断言在 `tests/ai-vision.test.ts` 的 `aivision.ref.huge.*`（像素级，不是比宽高）。
//
// 与参考图（`src/io/refstore.ts` 的 `RefImg`）的关系：参考图是 `{w, h, px: RGBA 字节, name}`，
// 即**直通 RGBA**（没有预乘）。`rgbaOfRef()` 只做「拿走一份能放进 ImageData 的像素」这一件事
// （`ImageData.data.set()` 要的就是 `Uint8ClampedArray`），缩放也照旧按直通解释 ——
// 与 `read_region` 的读侧口径一致（`docs/API.md` §21.2）。
import type { RefImg } from "../io/refstore";
import { resamplePixels } from "../engine/resample";
import { visionCapableModels, visionOfModel } from "./ai-presets";
import type { AiVision } from "./ai-presets";

// ------------------------------------------------------------------ 尺寸与体积口径

/** 发给模型的单边最大像素数（只缩不放）。768 = 512 × 1.5，够看清像素画的细节，PNG 也压得住 */
export const AI_VISION_MAX_EDGE = 768;
/** 缩到多小就不再缩了（再小就真的看不清参考图了；此时宁可报错让用户自己裁） */
export const AI_VISION_MIN_EDGE = 64;
/** `data:image/png;base64,` 前缀的长度（体积估算与「是不是 data URL」共用） */
export const AI_VISION_DATA_URL_PREFIX = "data:image/png;base64,";
/** data URL 总长的**软上限**：超过它 UI 提示「已经很大了」，但仍然允许发送 */
export const AI_VISION_SOFT_DATA_URL_BYTES = 512 * 1024;
/**
 * data URL 总长的**硬上限**：超过它**拦住不发送**。
 *
 * 为什么是 768 KiB 而不是贴着壳的 1 MiB：1 MiB 限的是**整个请求体**，而请求体里还有
 * 系统提示词、对话历史与 61 个工具的 schema（实测约 60–90 KB，长对话更多）。
 * 768 KiB 给那些留了 25% 以上余量，且 base64 本身已经比原始 PNG 大 4/3 —— 也就是说
 * 768 KiB 的 data URL 对应的 PNG 只有约 576 KiB。
 */
export const AI_VISION_HARD_DATA_URL_BYTES = 768 * 1024;
/**
 * 硬上限对应的**原始 PNG 字节数**上限（`dataUrlBytesFor()` 的反函数）。
 *
 * 口径是「**预测精确、反推也精确**」：`dataUrlBytesFor(n) = 前缀 + 4 * ceil(n / 3)`，
 * 于是 `dataUrlBytesFor(n) ≤ HARD` ⟺ `4 * ceil(n / 3) ≤ HARD - 前缀`
 * ⟺ `n ≤ 3 * floor((HARD - 前缀) / 4)`。少给那 2 个字节是必要的：
 * 早先按 `(HARD - 前缀) * 3 / 4` 取整，在 `n % 3 === 2` 的档上算出来的长度会比硬线多 2，
 * 于是「字节数没超、长度却超了」——`tests/ai-vision.test.ts` 的
 * `aivision.budget.at-hard-*` 会把三个余数档全扫一遍，正是为了钉住这一条。
 */
export const AI_VISION_HARD_BYTES =
  3 * Math.floor((AI_VISION_HARD_DATA_URL_BYTES - AI_VISION_DATA_URL_PREFIX.length) / 4);
/** 缩图循环最多试几轮（每轮至少缩到 0.72 倍，4 轮足够把 768 缩到 200 以下；防死循环） */
export const AI_VISION_FIT_ROUNDS = 6;
/** 单轮缩小的最大幅度（一次最多缩到 1/4 边长，免得为了一张巨图反复编码十几次） */
export const AI_VISION_MAX_SHRINK = 0.25;
/** 从字节数反推边长时的安全系数：PNG 体积不是严格正比于面积（小块图有固定头部开销） */
const AREA_SAFETY = 0.92;
/**
 * **重采样引擎 `engine/resample.ts` 的尺寸契约**（那边的 `MAX_SIZE`）：源与目标都必须 ≤ 1024。
 *
 * 抄在这里，是因为这一层必须**在调用之前**就知道它 —— 越界的源不报错，只会拿回一块全透明的
 * 等长缓冲区（`refToRgba()` 的注释里记着这个坑造成的真实后果）。
 * 两处是同一条约定，不是两份独立配置：改它要连着改 `engine/resample.ts`。
 */
export const AI_VISION_RESAMPLE_MAX = 1024;

// ------------------------------------------------------------------ 纯函数：尺寸

/** 尺寸夹取的结果（`ref` 一定是「可以拿去 putImageData 的直通 RGBA」，见 `rgbaOfRef`） */
export interface ClampedImage {
  /** 缩放之后的宽（像素，≥1） */
  w: number;
  /** 缩放之后的高（像素，≥1） */
  h: number;
  /** 缩放之后的直通 RGBA 字节（长度恒为 `w * h * 4`） */
  px: Uint8ClampedArray;
  /** 原始宽（用来在 UI 上写「2048×2048 → 768×768」） */
  sw: number;
  /** 原始高 */
  sh: number;
  /** 实际缩放系数（1 = 一个像素都没动） */
  scale: number;
  /** 用了几倍整数缩小（2 = 每 2×2 取 1 个像素）；非整数比例时是 0 */
  exactDivisor: number;
  /** 用到的重采样算法（`none` = 没缩；`area` = 源超出引擎契约时的盒式平均） */
  algo: "none" | "nearest" | "bilinear" | "area";
}

/**
 * **目标尺寸**：最长边夹到 `maxEdge`，只缩不放，长宽比与像素网格对齐（各自 `round`，下限 1）。
 * 纯算术，不碰像素 —— 调用方拿它去决定要不要真的重采样（`scale === 1` 就免了）。
 */
export function clampImageSize(w: number, h: number, maxEdge = AI_VISION_MAX_EDGE): { w: number; h: number; scale: number } {
  const sw = Math.max(0, Math.round(Number(w) || 0));
  const sh = Math.max(0, Math.round(Number(h) || 0));
  const edge = Math.max(AI_VISION_MIN_EDGE, Math.round(Number(maxEdge) || AI_VISION_MAX_EDGE));
  if (sw <= 0 || sh <= 0) return { w: 1, h: 1, scale: 1 };
  const longest = Math.max(sw, sh);
  if (longest <= edge) return { w: sw, h: sh, scale: 1 };   // **只缩不放**：够小就一个像素都不动
  const scale = edge / longest;
  return {
    w: Math.max(1, Math.round(sw * scale)),
    h: Math.max(1, Math.round(sh * scale)),
    scale,
  };
}

/**
 * 整数倍缩小系数：`sw/dw === sh/dh` 且两边都是整数倍时返回那个倍数，否则 0。
 * 整数倍才能用最近邻（等于「每 k 行 / 每 k 列取一个」，不产生新颜色）。
 */
export function exactDownscaleDivisor(sw: number, sh: number, dw: number, dh: number): number {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return 0;
  if (sw % dw !== 0 || sh % dh !== 0) return 0;
  const kx = sw / dw;
  const ky = sh / dh;
  return kx === ky ? kx : 0;
}

/** `RefImg` → **可以放进 `ImageData` 的直通 RGBA**（拷贝一份：绝不改参考图自己的缓冲区） */
export function rgbaOfRef(img: Pick<RefImg, "w" | "h" | "px">): Uint8ClampedArray {
  const src = img && img.px ? img.px : null;
  if (!src) return new Uint8ClampedArray(0);
  return src instanceof Uint8ClampedArray
    ? new Uint8ClampedArray(src)                        // 拷贝：调用方拿去缩放也不会动到原图
    : new Uint8ClampedArray(Array.prototype.slice.call(src) as number[]);
}

/**
 * **源超出重采样引擎契约时的降采样**（纯算术、不依赖 DOM，本模块自己实现）。
 *
 * 为什么自己写而不是调 `resamplePixels()`：那个函数对超 1024 的源**只会返回全透明块**
 * （见 `refToRgba()` 的注释）。这里按「一个目标像素 ← 源上对应的那一块」直接算，
 * 每块覆盖 `sw/dw × sh/dh` 个源像素，每个源像素只被访问一次：
 *   · `area` = 那一块的平均（大比例缩图的标准做法：照片 / 截图走这条）；
 *   · `nearest` = 取那一块的左上角（整数倍缩小时的抽点，像素画的硬边不被插值糊掉）。
 *
 * 平均按**直通 RGBA** 算（不做预乘）—— 与 `read_region` 的读侧口径一致（`docs/API.md` §21.2），
 * 而参考图 / 照片的 alpha 基本恒为 255，预乘在这里只是白算。
 */
export function downscaleOutOfContract(
  px: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number, algo: "area" | "nearest",
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor(((y + 1) * sh) / dh)));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.floor(((x + 1) * sw) / dw)));
      const o = (y * dw + x) * 4;
      if (algo === "nearest") {
        const i = (y0 * sw + x0) * 4;
        out[o] = px[i]; out[o + 1] = px[i + 1]; out[o + 2] = px[i + 2]; out[o + 3] = px[i + 3];
        continue;
      }
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * sw + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3]; n++;
        }
      }
      // Uint8ClampedArray 的赋值自带四舍五入与 0..255 夹取
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

/**
 * `RefImg` → 夹取到上限的直通 RGBA（**编码前唯一的数据准备步骤**）。
 *
 * 四条实现口径：
 *   · `scale === 1`（够小）→ 原样拷贝，**一个像素都不重采样**（像素画最怕无谓的插值）；
 *   · 源在引擎契约内（两边都 ≤ `AI_VISION_RESAMPLE_MAX`）：整数倍缩小 → `nearest`（逐格抽取，
 *     硬边还是硬的），非整数比例 → `bilinear`（`engine/resample.ts` 的既有实现，不另写一份缩放）；
 *   · 源**超出**契约（照片动辄 2000+）→ 走本模块的 `downscaleOutOfContract()`：整数倍仍 `nearest`，
 *     否则 `area`。
 *
 * **为什么最后一条不能省（真踩过的坑，别再简化回去）**：`engine/resample.ts` 的约定是
 * 「源与目标都在 1..1024」，越界时它**不抛异常**，而是返回一块**等长但全透明**的缓冲区
 * （见那边的 `dimsOk()` / `MAX_SIZE`）。早先这里把用户的原始尺寸直接喂了进去，于是
 * **1200px 以上的参考图会被静默编成一张空白图发给模型**，而附件条上还写着「已缩到 768×768」——
 * 尺寸对、像素全空，是这一层最难发现、后果最重的一类失败。
 * `tests/ai-vision.test.ts` 的 `aivision.ref.huge.*` 钉着它：断言里必须有
 * 「输出缓冲区里有多于一种颜色、alpha 不为 0」，**只断言宽高是不够的**（那条弱断言就是当时的漏网之鱼）。
 */
export function refToRgba(img: Pick<RefImg, "w" | "h" | "px">, maxEdge = AI_VISION_MAX_EDGE): ClampedImage {
  const sw = Math.max(0, Math.round(Number(img?.w) || 0));
  const sh = Math.max(0, Math.round(Number(img?.h) || 0));
  const target = clampImageSize(sw, sh, maxEdge);
  const src = rgbaOfRef(img);
  if (target.scale === 1 || src.length < sw * sh * 4) {
    // 尺寸非法（缓冲区不够长）时也走这里：把能给的给出去，后面的体积判定会兜住
    const px = src.length === sw * sh * 4 ? src : new Uint8ClampedArray(sw * sh * 4);
    return { w: sw || 1, h: sh || 1, px, sw, sh, scale: 1, exactDivisor: 0, algo: "none" };
  }
  const k = exactDownscaleDivisor(sw, sh, target.w, target.h);
  if (sw > AI_VISION_RESAMPLE_MAX || sh > AI_VISION_RESAMPLE_MAX) {
    // 超契约：**绝不能**交给 `resamplePixels()`（它会回一块全透明）
    const algo: "nearest" | "area" = k >= 2 ? "nearest" : "area";
    const px = downscaleOutOfContract(src, sw, sh, target.w, target.h, algo);
    return { w: target.w, h: target.h, px, sw, sh, scale: target.scale, exactDivisor: k >= 2 ? k : 0, algo };
  }
  const algo: "nearest" | "bilinear" = k >= 2 ? "nearest" : "bilinear";
  const px = resamplePixels(src, sw, sh, target.w, target.h, algo);
  return { w: target.w, h: target.h, px, sw, sh, scale: target.scale, exactDivisor: k >= 2 ? k : 0, algo };
}

// ------------------------------------------------------------------ 纯函数：编码与体积

/**
 * PNG 字节 → base64 的 `data:` URL。
 *
 * 就一个参数：**base64 文本**。生成它是 `src/engine/b64.ts` 的 `bytesToB64()`
 * （仓库里唯一的那一份），这里只负责拼前缀 —— 这一层不重复实现编码。
 */
export function dataUrlOfPng(b64: string): string {
  return AI_VISION_DATA_URL_PREFIX + String(b64 ?? "");
}

/**
 * PNG 字节 → 「`data:` URL 会有多长」的**精确**预测（纯算术，不真去 base64）。
 *
 * 不是估算而是**逐位相等**：`bytesToB64()` 每 3 字节出 4 个字符，不足 3 字节的尾巴补 `=`
 * 也要占满 4 个字符位（1 字节 → 2 字符 + `==`，2 字节 → 3 字符 + `=`）。
 * 所以长度 = `4 * ceil(n / 3)`。
 *
 * 为什么必须精确（这一条是被测试逼出来的）：早先写成 `ceil(n / 3) * 4`，它在 `n % 3 === 2`
 * 时**多算 4 个字节**，于是硬线附近的判定会比实际严格一点点，而
 * `tests/ai-vision.test.ts` 的 `aivision.url.estimate-matches` 会把「预测 == 真实长度」
 * 钉死 —— 估算与实测对不上时，这里立刻红。
 */
export function dataUrlBytesFor(pngLength: number): number {
  const n = Math.max(0, Math.round(Number(pngLength) || 0));
  return AI_VISION_DATA_URL_PREFIX.length + 4 * Math.ceil(n / 3);
}

/** 解析一条 data URL 的字节数；不是 `data:...;base64,` 形状时返回 0（**从不抛异常**） */
export function dataUrlBytes(url: string): number {
  const s = String(url ?? "");
  const comma = s.indexOf(",");
  if (comma < 0 || s.slice(0, comma).indexOf(";base64") < 0) return 0;
  const body = s.slice(comma + 1);
  if (!body) return 0;
  const pad = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((body.length * 3) / 4) - pad);
}

/** 一张已经编好的图的体积判定（`ok` 为假时 `reason` 一定有中文说明） */
export interface VisionBudget {
  /** 原始 PNG 字节数（base64 之前） */
  bytes: number;
  /** data URL 的总长度（发给模型的就是这一串） */
  dataUrlBytes: number;
  /** 是否超过**硬**上限（超过 = 不许发送） */
  overHard: boolean;
  /** 是否超过**软**上限（超过 = 能发，但 UI 要提示） */
  overSoft: boolean;
  ok: boolean;
  reason?: string;
}

/** 判定一张图的体积（**纯函数**：只数长度，不碰像素也不碰 DOM） */
export function visionBudgetOf(pngBytes: number, hard = AI_VISION_HARD_DATA_URL_BYTES, soft = AI_VISION_SOFT_DATA_URL_BYTES): VisionBudget {
  const bytes = Math.max(0, Math.round(Number(pngBytes) || 0));
  const total = dataUrlBytesFor(bytes);
  const overHard = total > hard;
  const overSoft = total > soft;
  const out: VisionBudget = { bytes, dataUrlBytes: total, overHard, overSoft, ok: !overHard };
  if (overHard) {
    out.reason = "参考图太大：编码后 " + Math.round(total / 1024) + " KiB，超过上限 " + Math.round(hard / 1024)
      + " KiB（本机壳对请求体的上限是 1 MiB，整轮对话还要占一部分）——请把参考图裁小一些，或换一张更简单的图";
  }
  return out;
}

/** 一张图缩到哪一档的尺寸（`fitEncodedImage()` 的返回，UI 拿着它再编码一轮） */
export interface FitStep {
  /** 这一次的尺寸能不能用 */
  ok: boolean;
  /** 不能用时下一次要试的尺寸（`ok` 为真时为 `null`） */
  next: { w: number; h: number } | null;
  /** 不能用时报错的中文原因（缩到底也放不下时才有） */
  reason?: string;
  /** 体积判定 */
  budget: VisionBudget;
}

/**
 * **编码之后的收口**：拿真实的 PNG 字节数与当前尺寸，决定「就这样发」「再缩一轮」还是「拦下」。
 *
 * 为什么是「编码后再判」而不是「编码前估算」：PNG 的体积与内容强相关（一张纯色 768² 只有
 * 几 KB，一张噪点图能到 1 MB），任何事前估算都会在某一头失准。所以口径是**以真实字节数为准**，
 * 缩小的幅度由真实比例反推（`sqrt(目标面积 / 当前面积)`）—— 每轮都拿真数，不猜。
 *
 * `next` 的尺寸**走 `clampImageSize()`**（按当前长宽比等比缩，只缩不放，下限 `minEdge`）：
 * 早先这里直接由「字节比例」算出两个边长、没经过等比夹取，于是一张 1600×400 的图会拿到
 * `next = {w: 900, h: 900}` 这种**正方形**尺寸 —— 调用方拿它去编码就等于**把图裁掉一半**。
 * 这一条是探测脚本量出来的（报告「未验项与已知缺口」里记了量法），不是推演出来的。
 *
 * 边界：缩到 `AI_VISION_MIN_EDGE` 或用了 `AI_VISION_FIT_ROUNDS` 轮还是超硬线 → `ok:false`
 * 并给一句中文原因（**绝不静默截断数据**：截断的 base64 会让模型端解码失败，那比报错更糟）。
 */
export function fitEncodedImage(
  pngBytes: number,
  size: { w: number; h: number },
  opts: { hard?: number; soft?: number; minEdge?: number; round?: number } = {},
): FitStep {
  const budget = visionBudgetOf(pngBytes, opts.hard, opts.soft);
  if (budget.ok) return { ok: true, next: null, budget };
  const w = Math.max(1, Math.round(Number(size?.w) || 0));
  const h = Math.max(1, Math.round(Number(size?.h) || 0));
  const minEdge = Math.max(1, Math.round(opts.minEdge ?? AI_VISION_MIN_EDGE));
  const round = Math.max(0, Math.round(opts.round ?? 0));
  const limit = opts.hard ?? AI_VISION_HARD_DATA_URL_BYTES;
  const longest = Math.max(w, h);
  const giveUp = (why: string): FitStep => ({ ok: false, next: null, reason: why, budget });
  if (longest <= minEdge) {
    return giveUp("参考图缩到 " + minEdge + "px 仍然太大（编码后 " + Math.round(budget.dataUrlBytes / 1024)
      + " KiB > " + Math.round(limit / 1024) + " KiB）：这张图的内容太复杂，请先裁小或降低细节");
  }
  if (round >= AI_VISION_FIT_ROUNDS) {
    return giveUp("参考图试了 " + AI_VISION_FIT_ROUNDS + " 轮还是超过 " + Math.round(limit / 1024)
      + " KiB（现在 " + Math.round(budget.dataUrlBytes / 1024) + " KiB）：请先裁小这张图");
  }
  // 由真实比例反推**目标最长边**：面积 ∝ 边长²，所以新边长 = 旧边长 × sqrt(目标 / 现在)
  const shrink = Math.max(AI_VISION_MAX_SHRINK, Math.min(1, Math.sqrt((limit * AREA_SAFETY) / Math.max(1, budget.dataUrlBytes))));
  let edge = Math.max(minEdge, Math.min(longest, Math.round(longest * shrink)));
  let next = clampImageSize(w, h, edge);
  // 夹取之后必须**严格变小**，否则会死循环在同一条尺寸上（`clampImageSize` 会四舍五入）
  if (next.w >= w && next.h >= h) {
    edge = Math.max(minEdge, longest - 1);
    next = clampImageSize(w, h, edge);
  }
  if ((next.w >= w && next.h >= h) || next.w <= 0 || next.h <= 0) {
    return giveUp("参考图缩不下去了（现在 " + w + "×" + h + "，编码后 " + Math.round(budget.dataUrlBytes / 1024)
      + " KiB > " + Math.round(limit / 1024) + " KiB）：请先裁小这张图");
  }
  return { ok: false, next: { w: next.w, h: next.h }, budget };
}

// ------------------------------------------------------------------ 能力门控（挂在模型上）

/** 挂图之前的一次判定（纯函数，`ai-chat.runChatTurn()` 与面板共用同一个口径） */
export interface VisionGate {
  /** 能不能带着图发出去 */
  allow: boolean;
  /** 模型的能力位（`yes` / `no` / `unknown`） */
  vision: AiVision;
  /** 不许发时的一句中文原因（**已经点出该换哪个模型**） */
  reason?: string;
  /** 允许发但能力未知时的一句中文提醒（`allow:true` + 非空 = UI 显示一句风险说明） */
  note?: string;
}

/**
 * **挂图 + 模型不支持视觉 → 发送前拦下**（契约 §4）。
 *
 * 为什么必须在本地拦：`deepseek-v4-pro` 收到 `content` 数组会直接回 HTTP 400
 * （错误体往往是 `"Invalid content type"` 之类），用户看到的是「端点报错」——
 * 而真正的原因是「这个模型不看图」，本地一句话就能说清，还省一次请求。
 *
 * `unknown`（自建网关 / 没听说过的名字）**放行**（见 `AiVision`），但带一句提醒：
 * 报错了用户才知道该换模型 —— 这条提醒就是「别让他以为是我们坏了」。
 */
export function visionGate(model: string, hasImage: boolean): VisionGate {
  const vision = visionOfModel(model);
  if (!hasImage) return { allow: true, vision };
  if (vision === "no") {
    const names = visionCapableModels();
    return {
      allow: false,
      vision,
      reason: "模型「" + String(model ?? "").trim() + "」不支持图像理解，带参考图发过去会被端点拒绝（HTTP 400）。"
        + (names.length ? "请在 设置 → AI 助手 → 模型 里换成 " + names.join(" / ") + " 再发。" : "请换一个支持图像理解的模型。"),
    };
  }
  if (vision === "unknown") {
    return {
      allow: true,
      vision,
      note: "模型「" + String(model ?? "").trim() + "」的图像能力未知：本轮会照发，若端点报错请换一个支持图像理解的模型。",
    };
  }
  return { allow: true, vision };
}
