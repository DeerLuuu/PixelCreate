// 参考图 / vision（`src/app/ai-vision.ts` + `ai-chat.ts` 的报文组装）回归。
//
// 这一份盯的是四件容易改回去的事：
//   1. **尺寸夹取**：最长边 ≤ 768 && **只缩不放** && 长宽比不跑偏；整数倍走最近邻（硬边还是硬的）；
//   2. **体积口径**：软线 512 KiB / 硬线 768 KiB 都**由壳的 1 MiB body 上限推出来**，
//      超硬线**不静默截断**（返回一句中文原因），缩不动的极端情况也不会死循环；
//   3. **报文形状**（契约 §3）：有图 → `content` 是数组且**文本先、图后**；无图 → **纯字符串**；
//      `system` / `assistant` 永远不带图（带了上游 400）；`contentText()` 从数组里取文本；
//   4. **能力门控**（契约 §4）：`vision:"no"` 的模型挂图**在发请求之前**就被拦下，且提示里
//      点出了该换哪个模型；`unknown` 放行但带一句提醒（不许把没听说过的模型拦死）。
import {
  AI_VISION_DATA_URL_PREFIX, AI_VISION_HARD_BYTES, AI_VISION_HARD_DATA_URL_BYTES,
  AI_VISION_MAX_EDGE, AI_VISION_MIN_EDGE, AI_VISION_SOFT_DATA_URL_BYTES,
  clampImageSize, dataUrlBytes, dataUrlBytesFor, dataUrlOfPng, exactDownscaleDivisor,
  fitEncodedImage, refToRgba, rgbaOfRef, visionBudgetOf, visionGate,
} from "../src/app/ai-vision";
import {
  AI_CHAT_SYSTEM_PROMPT, contentText, defaultTurnLabel, hasImagePart,
  runChatTurn, systemMessage, userContentParts, userMessage,
} from "../src/app/ai-chat";
import type { ChatContentPart, ChatFetch, ChatFetchInit, ChatMessage, ChatTurnOpts } from "../src/app/ai-chat";
import { AI_CHAT_DEFAULT_MODEL } from "../src/app/settings";
import { AI_CHAT_PRESETS, modelAcceptsImages, visionCapableModels, visionOfModel } from "../src/app/ai-presets";
import { bytesToB64, b64ToBytes } from "../src/engine/b64";
import { Session } from "../src/app/session";
import { stubEnv } from "./session.test";
import { eq, ok } from "./common";

// ---------------------------------------------------------------- 造图

/** 一张直通 RGBA 的测试图：每个像素一个可预测的颜色（用来验「缩放真的按像素算」） */
function img(w: number, h: number): { w: number; h: number; px: Uint8ClampedArray } {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px[i] = x & 255; px[i + 1] = y & 255; px[i + 2] = 128; px[i + 3] = 255;
    }
  }
  return { w, h, px };
}

/** 取 (x,y) 那一格的 RGBA */
function at(px: Uint8ClampedArray, w: number, x: number, y: number): number[] {
  const i = (y * w + x) * 4;
  return [px[i], px[i + 1], px[i + 2], px[i + 3]];
}

/** 一段「像真的 PNG」的字节（内容不重要，体积与 base64 往返才是这一层关心的） */
function pngLike(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 37 + 11) & 255;
  return b;
}

// ---------------------------------------------------------------- 假端点（只记请求体）

interface Seen { url: string; init: ChatFetchInit; headers: Record<string, string>; body: any }

/** 只回一条「模型说了句话」的假端点；每个请求都原样记下来 */
function fakeFetch(replies: string[]): { fn: ChatFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  let i = 0;
  const fn: ChatFetch = async (url, init) => {
    if (init.method === "GET" || init.method === "HEAD") {
      if (init.body !== undefined) throw new TypeError("Request with " + init.method + " method cannot have body");
    }
    seen.push({
      url, init, headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    const text = replies[Math.min(i++, replies.length - 1)];
    return { ok: true, status: 200, text: async () => text };
  };
  return { fn, seen };
}

function say(text: string): string {
  return JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
}

/** 一轮的公共参数（每个用例只改自己关心的那几项） */
function opts(s: Session, fn: ChatFetch, over: Partial<ChatTurnOpts> = {}): ChatTurnOpts {
  return {
    messages: [systemMessage(), userMessage("照这张参考图画一个角色")],
    ctx: { session: s, confirm: async () => true, turn: s.aiTurnHandle() },
    endpoint: "https://endpoint.test/v1", model: "deepseek-flash", key: "sk-test-key", fetchFn: fn,
    ...over,
  };
}

/** 一条足够小的真 data URL（体积断言用它，免得为了「放得下」还要编一张真 PNG） */
const SMALL_PNG = pngLike(2048);
const SMALL_URL = dataUrlOfPng(bytesToB64(SMALL_PNG));

export async function testAiVision(): Promise<void> {
  stubEnv();

  // ================================================================ 1. 尺寸夹取（只缩不放）
  {
    eq("aivision.size.small-untouched", clampImageSize(64, 32), { w: 64, h: 32, scale: 1 });
    eq("aivision.size.exactly-max", clampImageSize(768, 768), { w: 768, h: 768, scale: 1 });
    // 放大方向**一个像素都不动**：像素画放大只丢信息不添信息，还会让 PNG 与 base64 一起变大
    eq("aivision.size.never-upscale", clampImageSize(1, 1), { w: 1, h: 1, scale: 1 });
    eq("aivision.size.never-upscale-2", clampImageSize(10, 400), { w: 10, h: 400, scale: 1 });

    const wide = clampImageSize(2048, 1024);
    eq("aivision.size.wide", [wide.w, wide.h], [768, 384]);
    ok("aivision.size.wide-scale", Math.abs(wide.scale - 0.375) < 1e-9, "scale=" + wide.scale);
    const tall = clampImageSize(300, 1200);
    eq("aivision.size.tall", [tall.w, tall.h], [192, 768]);
    // 长宽比不许跑偏（各自 round 之后允许不到 1px 的偏差）
    ok("aivision.size.aspect-kept", Math.abs(tall.w / tall.h - 300 / 1200) < 0.01,
      tall.w + "x" + tall.h + " vs " + 300 / 1200);
    // 1×N 的极端长条：短边不许被 round 成 0（只比宽高，`scale` 是浮点，不逐位比）
    const thin = clampImageSize(1, 5000);
    eq("aivision.size.thin-min-one", [thin.w, thin.h], [1, 768]);
    // 非法尺寸（0 / 负数 / NaN）不返回 0，也不抛
    eq("aivision.size.zero", clampImageSize(0, 0), { w: 1, h: 1, scale: 1 });
    eq("aivision.size.nan", clampImageSize(NaN, NaN), { w: 1, h: 1, scale: 1 });
    // maxEdge 可换（缩图循环就是靠它一档一档往下走的）
    eq("aivision.size.custom-edge", clampImageSize(1000, 500, 100), { w: 100, h: 50, scale: 0.1 });

    eq("aivision.divisor.exact2", exactDownscaleDivisor(1024, 1024, 512, 512), 2);
    eq("aivision.divisor.exact4", exactDownscaleDivisor(1024, 512, 256, 128), 4);
    eq("aivision.divisor.not-multiple", exactDownscaleDivisor(1024, 1024, 768, 768), 0);
    // 两边倍数不同（长宽比被改过）不算整数倍缩小 —— 那种情况必须走重采样
    eq("aivision.divisor.mismatch", exactDownscaleDivisor(1024, 512, 512, 512), 0);
    eq("aivision.divisor.zero", exactDownscaleDivisor(0, 512, 256, 256), 0);
  }

  // ================================================================ 2. RGBA 直通提取
  {
    const src = img(4, 2);
    const copy = rgbaOfRef(src);
    eq("aivision.rgba.length", copy.length, 4 * 2 * 4);
    eq("aivision.rgba.values", at(copy, 4, 3, 1), [3, 1, 128, 255]);
    ok("aivision.rgba.is-clamped", copy instanceof Uint8ClampedArray);
    // **必须是拷贝**：调用方拿去缩放时不许动到参考图自己的缓冲区（参考图是会话里的长期状态）
    copy[0] = 99;
    eq("aivision.rgba.no-alias", src.px[0], 0);
    // IndexedDB 结构化克隆之后可能是普通数组（`refstore.loadRef()` 会补回来，这里也要扛得住）
    const plain = rgbaOfRef({ w: 2, h: 1, px: [1, 2, 3, 4, 5, 6, 7, 8] as unknown as Uint8ClampedArray });
    eq("aivision.rgba.from-array", [plain.length, plain[4], plain[7]], [8, 5, 8]);
    eq("aivision.rgba.empty", rgbaOfRef({ w: 0, h: 0, px: new Uint8ClampedArray(0) }).length, 0);
    eq("aivision.rgba.null-px", rgbaOfRef({ w: 4, h: 4, px: null as unknown as Uint8ClampedArray }).length, 0);
  }

  // ================================================================ 3. 缩放真的按像素算
  {
    // 够小 → 一个像素都不重采样
    const small = refToRgba(img(10, 10));
    eq("aivision.ref.no-scale", [small.w, small.h, small.scale, small.algo, small.exactDivisor], [10, 10, 1, "none", 0]);
    eq("aivision.ref.no-scale-values", at(small.px, 10, 9, 9), [9, 9, 128, 255]);

    // 整数倍缩小 → 最近邻：结果必须**逐格等于原图对应的那一格**（硬边还是硬的）
    // 128×64 夹到 64 = 每边 2 倍，抽掉奇数行 / 奇数列，颜色是原图里真有的那个（不插值）
    const q = refToRgba(img(128, 64), 64);
    eq("aivision.ref.nearest-size", [q.w, q.h, q.exactDivisor, q.algo], [64, 32, 2, "nearest"]);
    eq("aivision.ref.nearest-px0", at(q.px, 64, 0, 0), [0, 0, 128, 255]);
    // 第 1 格取原图 (2,2)（不是 (1,1)、更不是插值出来的中间色）
    eq("aivision.ref.nearest-px1", at(q.px, 64, 1, 1), [2, 2, 128, 255]);

    // 350×120 夹到 100 → 100×34，两边倍数不同（3.5 / 3.53）→ **不算整数倍**，走双线性
    // （这条钉的是「非整数比例必须重采样，不能拿最近邻冒充」）
    const non = refToRgba(img(350, 120), 100);
    eq("aivision.ref.bilinear-size", [non.w, non.h, non.exactDivisor, non.algo], [100, 34, 0, "bilinear"]);
    eq("aivision.ref.bilinear-len", non.px.length, 100 * 34 * 4);

    // 300×120 夹到 100 → 两边都是 3 倍 → 整数倍，走最近邻（同一族图，只是长宽比不同）
    const exact3 = refToRgba(img(300, 120), 100);
    eq("aivision.ref.exact3", [exact3.w, exact3.h, exact3.exactDivisor, exact3.algo], [100, 40, 3, "nearest"]);

    // `maxEdge` 有**下限 64**（`AI_VISION_MIN_EDGE`）：比它小的值会被抬到 64，
    // 所以「比 64 还小」的图**一个像素都不动**（只缩不放，这条同时防了「缩到看不见」）
    eq("aivision.ref.edge-floor", clampImageSize(8, 4, 2), { w: 8, h: 4, scale: 1 });

    // 源像素缓冲区不够长（坏数据）：不抛异常，给一张全透明的图让后面的体积判定兜住
    const bad = refToRgba({ w: 8, h: 8, px: new Uint8ClampedArray(4) });
    eq("aivision.ref.short-buffer", [bad.w, bad.h, bad.px.length], [8, 8, 8 * 8 * 4]);
    ok("aivision.ref.short-buffer-transparent", bad.px[0] === 0 && bad.px[3] === 0);

    // 默认上限就是 768（契约 §2 的硬口径）
    const big = refToRgba(img(2000, 1000));
    eq("aivision.ref.default-max-edge", [big.w, big.h], [AI_VISION_MAX_EDGE, AI_VISION_MAX_EDGE / 2]);
    // 光比宽高是不够的：2000×1000 的源**超出** `engine/resample.ts` 的 1024 契约，
    // 修之前这里拿回的是一块等长但全 0 的缓冲区（尺寸对、像素全空）。成套回归见下面的 3b。
    const bigColors = new Set<string>();
    for (let i = 0; i < big.px.length; i += 404) bigColors.add(big.px[i] + "," + big.px[i + 1] + "," + big.px[i + 2]);
    ok("aivision.ref.default-max-edge-pixels", bigColors.size > 2, "2000x1000 → 采样到 " + bigColors.size + " 种颜色");
  }

  // ================================================================ 3b. 超契约源图（回归：不许编成空白图）
  {
    // 这一组钉的是一个**真发生过的失败**：源图任一边超过 1024 时，`resamplePixels()` 会
    // 静默返回全透明的等长缓冲区（`dimsOk()` / `MAX_SIZE`，见 `src/engine/resample.ts`），
    // 于是「参考图与文本一起发给模型」实际发出的是一张**空白图**，而附件条上还写着「已缩到 …」。
    // 断言口径必须是**像素级**的：宽高对得上完全不能说明图还在。
    const shapes: Array<[number, number]> = [
      [1200, 1200], [1400, 700], [1600, 1600], [2048, 2048], [2400, 600], [4000, 3000], [1025, 100],
    ];
    for (const [w, h] of shapes) {
      const r = refToRgba(img(w, h));
      const tag = w + "x" + h;
      eq("aivision.ref.huge.len." + tag, r.px.length, r.w * r.h * 4);
      ok("aivision.ref.huge.edge." + tag, r.w === AI_VISION_MAX_EDGE || r.h === AI_VISION_MAX_EDGE, r.w + "x" + r.h);
      const colors = new Set<string>();
      let alpha = 0;
      for (let i = 0; i < r.px.length; i += 404) {
        colors.add(r.px[i] + "," + r.px[i + 1] + "," + r.px[i + 2]);
        alpha += r.px[i + 3];
      }
      ok("aivision.ref.huge.colors." + tag, colors.size > 2, tag + " 只有 " + colors.size + " 种颜色");
      ok("aivision.ref.huge.alpha." + tag, alpha > 0, tag + " alpha 合计 " + alpha);
      ok("aivision.ref.huge.path." + tag, r.algo === "area" || r.algo === "nearest", "algo=" + r.algo);
    }
    // 整数倍（1536 = 768×2）在超契约路径上仍然是**抽点**：像素画的硬边不被插值糊掉
    const exact = refToRgba(img(1536, 1536));
    eq("aivision.ref.huge-exact2", [exact.w, exact.h, exact.algo, exact.exactDivisor], [768, 768, "nearest", 2]);
    // 恰好 1024（契约边界）仍然走引擎：非整数比例 → bilinear（既有行为一个字没改）
    const edge = refToRgba(img(1024, 1024));
    eq("aivision.ref.edge-in-contract", [edge.w, edge.h, edge.algo], [768, 768, "bilinear"]);
    const edgeColors = new Set<string>();
    for (let i = 0; i < edge.px.length; i += 404) edgeColors.add(edge.px[i] + "," + edge.px[i + 1] + "," + edge.px[i + 2]);
    ok("aivision.ref.edge-in-contract-pixels", edgeColors.size > 2, "1024x1024 → " + edgeColors.size + " 种颜色");
  }

  // ================================================================ 4. 编码与体积
  {
    eq("aivision.url.prefix", SMALL_URL.slice(0, AI_VISION_DATA_URL_PREFIX.length), AI_VISION_DATA_URL_PREFIX);
    eq("aivision.url.prefix-const", AI_VISION_DATA_URL_PREFIX, "data:image/png;base64,");
    // base64 往返：解码回来的字节数与编码前一致（端到端那条断言用的就是这个等式）
    eq("aivision.url.roundtrip-len", b64ToBytes(SMALL_URL.slice(AI_VISION_DATA_URL_PREFIX.length)).length, SMALL_PNG.length);
    // **逐字节相同**（不只是长度）：图真的传出去了，不是一串等长的零
    const back = b64ToBytes(SMALL_URL.slice(AI_VISION_DATA_URL_PREFIX.length));
    let same = back.length === SMALL_PNG.length;
    for (let i = 0; same && i < back.length; i++) if (back[i] !== SMALL_PNG[i]) same = false;
    ok("aivision.url.roundtrip-bytes", same, back.length + " vs " + SMALL_PNG.length);

    // 两个名字容易搞混，各钉一次：`dataUrlBytes()` 是**解码后的字节数**（= 原始 PNG 长度），
    // `dataUrlBytesFor()` 是**data URL 那一串会有多长**（base64 之后，约 4/3 + 前缀）
    eq("aivision.url.parse-len", dataUrlBytes(SMALL_URL), SMALL_PNG.length);
    eq("aivision.url.estimate-matches", dataUrlBytesFor(SMALL_PNG.length), SMALL_URL.length);
    ok("aivision.url.estimate-bigger-than-raw", dataUrlBytesFor(SMALL_PNG.length) > SMALL_PNG.length,
      dataUrlBytesFor(SMALL_PNG.length) + " > " + SMALL_PNG.length);

    // 解析的三种失败形状都回 0（**从不抛异常**：坏数据不该让整个面板崩）
    eq("aivision.url.parse-not-data", dataUrlBytes("https://example.test/a.png"), 0);
    eq("aivision.url.parse-no-base64", dataUrlBytes("data:image/png,abc"), 0);
    eq("aivision.url.parse-empty", dataUrlBytes("data:image/png;base64,"), 0);
    eq("aivision.url.parse-blank", dataUrlBytes(""), 0);
    // 三类 padding 都不许把长度算错
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      eq("aivision.url.roundtrip-" + n, dataUrlBytes("data:image/png;base64," + bytesToB64(pngLike(n))), n);
    }

    // 软 / 硬两条线
    const tiny = visionBudgetOf(1024);
    eq("aivision.budget.tiny", [tiny.ok, tiny.overSoft, tiny.overHard], [true, false, false]);
    ok("aivision.budget.tiny-no-reason", tiny.reason === undefined);
    const soft = visionBudgetOf(Math.ceil(AI_VISION_SOFT_DATA_URL_BYTES * 3 / 4));
    eq("aivision.budget.soft-ok", [soft.ok, soft.overSoft, soft.overHard], [true, true, false]);
    const hard = visionBudgetOf(AI_VISION_HARD_BYTES + 1);
    eq("aivision.budget.hard", [hard.ok, hard.overSoft, hard.overHard], [false, true, true]);
    ok("aivision.budget.hard-reason", !!hard.reason && hard.reason.indexOf("KiB") > 0, String(hard.reason));
    // 原因里必须点出「1 MiB 的壳上限」这件事 —— 否则用户不知道这个数是从哪来的
    ok("aivision.budget.hard-reason-names-shell", !!hard.reason && hard.reason.indexOf("1 MiB") > 0, String(hard.reason));
    // **边界无例外**（`AI_VISION_HARD_BYTES` 的 -1 就是为这条）：硬线以内一律放行，
    // 多 1 个字节一律拦下 —— 三个余数档都扫一遍，免得只有 n%3===0 的那一档是对的
    for (const n of [AI_VISION_HARD_BYTES - 3, AI_VISION_HARD_BYTES - 2, AI_VISION_HARD_BYTES - 1, AI_VISION_HARD_BYTES]) {
      const b = visionBudgetOf(n);
      eq("aivision.budget.at-hard-" + n, [b.overHard, b.ok], [false, true]);
      ok("aivision.budget.at-hard-fits-" + n, b.dataUrlBytes <= AI_VISION_HARD_DATA_URL_BYTES,
        b.dataUrlBytes + " <= " + AI_VISION_HARD_DATA_URL_BYTES);
    }
    eq("aivision.budget.over-hard-by-one", visionBudgetOf(AI_VISION_HARD_BYTES + 1).overHard, true);
    eq("aivision.budget.exactly-soft", visionBudgetOf(Math.ceil(AI_VISION_SOFT_DATA_URL_BYTES * 3 / 4)).ok, true);

    // 两条线的关系（口径自洽：硬线 > 软线 > 0，且都远小于壳的 1 MiB）
    ok("aivision.budget.lines-ordered",
      AI_VISION_HARD_DATA_URL_BYTES > AI_VISION_SOFT_DATA_URL_BYTES && AI_VISION_SOFT_DATA_URL_BYTES > 0
      && AI_VISION_HARD_DATA_URL_BYTES < 1024 * 1024,
      AI_VISION_SOFT_DATA_URL_BYTES + " / " + AI_VISION_HARD_DATA_URL_BYTES);
    eq("aivision.budget.hard-bytes-consistent", dataUrlBytesFor(AI_VISION_HARD_BYTES) <= AI_VISION_HARD_DATA_URL_BYTES + 4, true);
  }

  // ================================================================ 5. 放不下时怎么收场
  {
    // 放得下 → 直接用，不给 next
    const fits = fitEncodedImage(SMALL_PNG.length, { w: 768, h: 768 });
    eq("aivision.fit.ok", [fits.ok, fits.next], [true, null]);

    // 放不下 → 给一个**严格更小**的尺寸，且不报错（还没到放弃的时候）
    const over = fitEncodedImage(AI_VISION_HARD_BYTES * 4, { w: 768, h: 768 });
    eq("aivision.fit.shrinks", over.ok, false);
    ok("aivision.fit.next-smaller", !!over.next && over.next.w < 768 && over.next.h < 768,
      JSON.stringify(over.next));
    ok("aivision.fit.next-positive", !!over.next && over.next.w >= 1 && over.next.h >= 1, JSON.stringify(over.next));

    // **`next` 必须等比**（不是把两个边长各算一遍）：1600×400 的下一档也得是 4:1。
    // 早先的实现直接由字节比例算出 `{w: 900, h: 900}` 这种正方形 —— 调用方拿它去编码
    // 就等于**把图裁掉一半**（这条是探测脚本量出来的，不是推演）。
    const wide = fitEncodedImage(AI_VISION_HARD_BYTES * 8, { w: 1600, h: 400 });
    eq("aivision.fit.wide-shrinks", wide.ok, false);
    ok("aivision.fit.wide-keeps-aspect",
      !!wide.next && Math.abs(wide.next.w / wide.next.h - 4) < 0.08,
      JSON.stringify(wide.next) + " 应为 4:1");
    ok("aivision.fit.wide-not-square", !!wide.next && wide.next.w !== wide.next.h, JSON.stringify(wide.next));
    // 长条同理：短边不许被算成跟长边一样长
    const tall = fitEncodedImage(AI_VISION_HARD_BYTES * 8, { w: 300, h: 1200 });
    ok("aivision.fit.tall-keeps-aspect", !!tall.next && Math.abs(tall.next.w / tall.next.h - 0.25) < 0.06,
      JSON.stringify(tall.next) + " 应为 1:4");
    ok("aivision.fit.tall-shorter", !!tall.next && tall.next.w < 300 && tall.next.h < 1200, JSON.stringify(tall.next));

    // 已经缩到下限还放不下 → 明确放弃 + 一句中文原因（**绝不静默截断 base64**）
    const tiny = fitEncodedImage(AI_VISION_HARD_BYTES * 4, { w: AI_VISION_MIN_EDGE, h: AI_VISION_MIN_EDGE });
    eq("aivision.fit.gives-up-at-min", [tiny.ok, tiny.next], [false, null]);
    ok("aivision.fit.gives-up-reason", !!tiny.reason && tiny.reason.indexOf("裁小") > 0, String(tiny.reason));

    // 轮数用尽 → 也放弃（防死循环；每一轮必须真的变小，否则永远收敛不了）
    const exhausted = fitEncodedImage(AI_VISION_HARD_BYTES * 4, { w: 700, h: 700 }, { round: 6 });
    eq("aivision.fit.gives-up-at-rounds", [exhausted.ok, exhausted.next], [false, null]);
    ok("aivision.fit.rounds-reason", !!exhausted.reason && exhausted.reason.indexOf("轮") > 0, String(exhausted.reason));

    // 单调收敛：**按真实调用方的用法**跑一遍（`encodeAttachment()` 传的是「目标最长边」，
    // 再由 `clampImageSize` 夹成等比尺寸），模拟字节数按面积正比造。要求：每轮严格变小、
    // 长宽比全程不跑偏、最多 6 轮一定有结论。
    for (const [sw, sh] of [[2048, 1024], [1000, 2000], [768, 768], [1600, 400]] as Array<[number, number]>) {
      let edge = AI_VISION_MAX_EDGE;
      const ratio = sw / sh;
      const trail: string[] = [];
      let concluded = "";
      for (let round = 0; round <= 12; round++) {
        const size = clampImageSize(sw, sh, edge);
        const fakeBytes = Math.round((size.w * size.h) / 4);   // 「PNG 压不动」的最坏情况
        trail.push(size.w + "x" + size.h);
        ok("aivision.fit.converge-aspect-" + sw + "x" + sh + "-r" + round,
          Math.abs(size.w / size.h - ratio) < 0.06, size.w + "/" + size.h + " vs " + ratio.toFixed(3));
        const step = fitEncodedImage(fakeBytes, size, { round });
        if (step.ok) { concluded = "ok@" + size.w + "x" + size.h; break; }
        if (!step.next) { concluded = "stop@" + size.w + "x" + size.h; break; }
        ok("aivision.fit.converge-monotone-" + sw + "x" + sh + "-r" + round,
          step.next.w < size.w && step.next.h < size.h, trail.join(" → "));
        edge = Math.max(AI_VISION_MIN_EDGE, Math.max(step.next.w, step.next.h));
        if (round === 12) concluded = "runaway@" + size.w + "x" + size.h;
      }
      ok("aivision.fit.converge-terminates-" + sw + "x" + sh, concluded.startsWith("ok@") || concluded.startsWith("stop@"),
        concluded + " 轨迹 " + trail.join(" → "));
    }
  }

  // ================================================================ 6. 能力门控（模型表）
  {
    eq("aivision.model.flash-yes", visionOfModel("deepseek-flash"), "yes");
    eq("aivision.model.pro-no", visionOfModel("deepseek-v4-pro"), "no");
    eq("aivision.model.legacy-experimental-yes", visionOfModel("deepseek-v4-flash-vision-exp"), "yes");
    eq("aivision.model.unknown-random", visionOfModel("my-local-gateway-model"), "unknown");
    eq("aivision.model.unknown-empty", visionOfModel(""), "unknown");
    eq("aivision.model.unknown-undefined", visionOfModel(undefined as unknown as string), "unknown");
    // 大小写与首尾空白容忍（模型名是用户手填的自由文本）
    eq("aivision.model.trim-case", visionOfModel("  DeepSeek-Flash  "), "yes");
    // **绝不模糊匹配**：多一个字就是另一个模型
    eq("aivision.model.no-fuzzy", visionOfModel("deepseek-flash-v2"), "unknown");

    eq("aivision.model.accepts-flash", modelAcceptsImages("deepseek-flash"), true);
    eq("aivision.model.accepts-pro", modelAcceptsImages("deepseek-v4-pro"), false);
    // unknown **放行**（「不知道」不是「不行」；拦死会让自建网关的用户全用不了）
    eq("aivision.model.accepts-unknown", modelAcceptsImages("whatever-llm"), true);

    const capable = visionCapableModels();
    ok("aivision.model.capable-list", capable.indexOf("deepseek-flash") >= 0, capable.join(","));
    ok("aivision.model.capable-excludes-pro", capable.indexOf("deepseek-v4-pro") < 0, capable.join(","));

    const gateNo = visionGate("deepseek-v4-pro", true);
    eq("aivision.gate.no.denied", gateNo.allow, false);
    eq("aivision.gate.no.vision", gateNo.vision, "no");
    ok("aivision.gate.no.reason-names-model", !!gateNo.reason && gateNo.reason.indexOf("deepseek-v4-pro") >= 0, String(gateNo.reason));
    // 提示必须**点出该换哪个模型**（契约 §4 原话）
    ok("aivision.gate.no.reason-suggests-flash", !!gateNo.reason && gateNo.reason.indexOf("deepseek-flash") >= 0, String(gateNo.reason));
    ok("aivision.gate.no.reason-names-http400", !!gateNo.reason && gateNo.reason.indexOf("400") >= 0, String(gateNo.reason));

    const gateYes = visionGate("deepseek-flash", true);
    eq("aivision.gate.yes", [gateYes.allow, gateYes.vision, gateYes.reason, gateYes.note], [true, "yes", undefined, undefined]);

    const gateUnknown = visionGate("my-gateway-v9", true);
    eq("aivision.gate.unknown.allowed", gateUnknown.allow, true);
    ok("aivision.gate.unknown.note", !!gateUnknown.note && gateUnknown.note.indexOf("my-gateway-v9") >= 0, String(gateUnknown.note));

    // 没挂图时门控**永远放行**（`vision:"no"` 也不许挡住纯文本对话）
    for (const m of ["deepseek-v4-pro", "deepseek-flash", "whatever", ""]) {
      const g = visionGate(m, false);
      eq("aivision.gate.no-image-allows-" + (m || "empty"), [g.allow, g.reason, g.note], [true, undefined, undefined]);
    }

    // 预设清单里的能力位与查表**必须一致**（两处漂移是最容易发生的事）
    for (const preset of AI_CHAT_PRESETS) {
      for (const m of preset.models) {
        eq("aivision.preset.vision-matches-" + preset.id + "-" + m.id, m.vision, visionOfModel(m.id));
      }
    }
    // 默认模型（deepseek-v4-pro）在清单里，且能力位是 no —— 挂图会被拦下并提示换 flash
    eq("aivision.preset.default-model", AI_CHAT_DEFAULT_MODEL, "deepseek-v4-pro");
    eq("aivision.preset.default-model-vision", visionOfModel(AI_CHAT_DEFAULT_MODEL), "no");
    ok("aivision.preset.model-ids-are-strings",
      AI_CHAT_PRESETS.every((p) => p.models.every((m) => typeof m.id === "string" && m.id.length > 0)));
  }

  // ================================================================ 7. 报文形状（契约 §3）
  {
    // 没有图 → **纯字符串**（硬口径：非视觉端点与老网关收到数组会直接 400）
    const plain = userContentParts("画一只猫");
    eq("aivision.parts.plain-is-string", typeof plain, "string");
    eq("aivision.parts.plain-value", plain, "画一只猫");

    const withImg = userContentParts("画一只猫", SMALL_URL) as ChatContentPart[];
    ok("aivision.parts.image-is-array", Array.isArray(withImg));
    eq("aivision.parts.image-count", withImg.length, 2);
    // **顺序是死的**：文本先、图后（官方原文的形状）
    eq("aivision.parts.image-first-type", withImg[0].type, "text");
    eq("aivision.parts.image-first-text", (withImg[0] as { text: string }).text, "画一只猫");
    eq("aivision.parts.image-second-type", withImg[1].type, "image_url");
    eq("aivision.parts.image-second-url", (withImg[1] as { image_url: { url: string } }).image_url.url, SMALL_URL);
    ok("aivision.parts.image-second-data-url", (withImg[1] as { image_url: { url: string } }).image_url.url.startsWith(AI_VISION_DATA_URL_PREFIX));

    // 空串 / 空白 / undefined / null 都当「没有图」（面板传的就是空串）
    for (const v of ["", "   ", undefined, null]) {
      eq("aivision.parts.blank-is-string-" + String(v), typeof userContentParts("x", v as string), "string");
    }
    // 图前后不许偷加空 text 块（有的网关会因为空 text 块报错）
    const onlyImg = userContentParts("", SMALL_URL) as ChatContentPart[];
    eq("aivision.parts.empty-text-still-text-block", [onlyImg.length, onlyImg[0].type], [2, "text"]);

    // 两种块各自能被认出来
    eq("aivision.parts.has-image", hasImagePart(withImg), true);
    eq("aivision.parts.has-image-plain", hasImagePart(plain), false);
    eq("aivision.parts.has-image-undefined", hasImagePart(undefined), false);

    // 从数组里取文本（`defaultTurnLabel` / 系统提示词合并都要它；`String(content)` 会拍成 [object Object]）
    eq("aivision.text.from-parts", contentText(withImg), "画一只猫");
    eq("aivision.text.from-string", contentText("abc"), "abc");
    eq("aivision.text.from-empty", contentText(undefined), "");

    // userMessage 是唯一的入口，签名向后兼容（第二参数省略 = 逐字节与从前相同）
    const m1 = userMessage("你好");
    eq("aivision.user-message.plain", m1, { role: "user", content: "你好" });
    const m2 = userMessage("你好", SMALL_URL);
    eq("aivision.user-message.image", [m2.role, Array.isArray(m2.content)], ["user", true]);

    // 历史标签从 parts 数组里取**文本块**（挂图那条消息的 content 是数组）
    eq("aivision.label.from-image-message", defaultTurnLabel([systemMessage(), m2]), "你好");
    eq("aivision.label.plain-fallback", defaultTurnLabel([{ role: "user", content: userContentParts("", SMALL_URL) }]),
      "对话");
    ok("aivision.system-prompt-is-string", typeof systemMessage().content === "string");
    eq("aivision.system-prompt-keeps-builtin", (systemMessage() as { content: string }).content.startsWith(AI_CHAT_SYSTEM_PROMPT.slice(0, 20)), true);
  }

  // ================================================================ 8. runChatTurn：有图 → 数组
  {
    const s = new Session();
    s.history.clear();
    const { fn, seen } = fakeFetch([say("看到了。")]);
    const r = await runChatTurn(opts(s, fn, { imageDataUrl: SMALL_URL, imageNote: "参考图已从 2048×2048 缩到 768×768" }));
    eq("aivision.turn.image.ok", r.ok, true);
    eq("aivision.turn.image.rounds", r.rounds, 1);
    eq("aivision.turn.image.one-request", seen.length, 1);

    const msgs = seen[0].body.messages as ChatMessage[];
    const user = msgs.filter((m) => m.role === "user");
    eq("aivision.turn.image.one-user", user.length, 1);
    const parts = user[0].content as ChatContentPart[];
    ok("aivision.turn.image.content-array", Array.isArray(parts), JSON.stringify(user[0].content).slice(0, 80));
    eq("aivision.turn.image.part-count", parts.length, 2);
    eq("aivision.turn.image.part0", parts[0].type, "text");
    eq("aivision.turn.image.part1", parts[1].type, "image_url");
    // 文本块里既有用户那句话，也有 `imageNote`（让模型知道这张图不是原尺寸）
    const text0 = (parts[0] as { text: string }).text;
    ok("aivision.turn.image.text-keeps-words", text0.indexOf("照这张参考图画一个角色") >= 0, text0);
    ok("aivision.turn.image.text-keeps-note", text0.indexOf("2048×2048") > 0, text0);
    eq("aivision.turn.image.url", (parts[1] as { image_url: { url: string } }).image_url.url, SMALL_URL);

    // system 消息**永远不带图**（带图上游 400）
    const sys = msgs.filter((m) => m.role === "system");
    eq("aivision.turn.image.system-count", sys.length, 1);
    eq("aivision.turn.image.system-string", typeof sys[0].content, "string");
    eq("aivision.turn.image.system-no-image", hasImagePart(sys[0].content), false);

    // 整条请求体 < 1 MiB（壳的 `MAX_BODY_BYTES`）—— 这是「体积夹取有没有意义」的现场证据
    const bodyText = String(seen[0].init.body ?? "");
    ok("aivision.turn.image.body-under-1mib", bodyText.length < 1024 * 1024, bodyText.length + " 字节");
  }

  // ================================================================ 9. runChatTurn：无图 → 字符串（回归）
  {
    const s = new Session();
    s.history.clear();
    const { fn, seen } = fakeFetch([say("好。")]);
    const r = await runChatTurn(opts(s, fn));
    eq("aivision.turn.plain.ok", r.ok, true);
    const msgs = seen[0].body.messages as ChatMessage[];
    const user = msgs.filter((m) => m.role === "user");
    eq("aivision.turn.plain.user-string", typeof user[0].content, "string");
    eq("aivision.turn.plain.user-text", user[0].content, "照这张参考图画一个角色");
    eq("aivision.turn.plain.no-image", hasImagePart(user[0].content), false);
    // 只传 note（没有图）时**也不该**变成数组（note 只是文本）
    const s2 = new Session();
    s2.history.clear();
    const f2 = fakeFetch([say("好。")]);
    await runChatTurn(opts(s2, f2.fn, { imageNote: "参考图已缩到 512×512" }));
    const u2 = (f2.seen[0].body.messages as ChatMessage[]).filter((m) => m.role === "user");
    eq("aivision.turn.note-only-string", typeof u2[0].content, "string");
    ok("aivision.turn.note-only-merged", String(u2[0].content).indexOf("512×512") > 0, String(u2[0].content));
  }

  // ================================================================ 10. runChatTurn：能力门控
  {
    const s = new Session();
    s.history.clear();
    const { fn, seen } = fakeFetch([say("不该被请求")]);
    const r = await runChatTurn(opts(s, fn, { model: "deepseek-v4-pro", imageDataUrl: SMALL_URL }));
    eq("aivision.turn.gate.ok", r.ok, false);
    // **一个请求都没发**（不是「发了再报错」）：这就是本地门控的全部价值
    eq("aivision.turn.gate.no-request", seen.length, 0);
    eq("aivision.turn.gate.rounds", r.rounds, 0);
    ok("aivision.turn.gate.error-names-model", !!r.error && r.error.indexOf("deepseek-v4-pro") >= 0, String(r.error));
    ok("aivision.turn.gate.error-suggests-flash", !!r.error && r.error.indexOf("deepseek-flash") >= 0, String(r.error));
    eq("aivision.turn.gate.no-history", s.history.list().labels.length, 0);
    eq("aivision.turn.gate.turn-closed", s.aiTurnOpen(), false);

    // 同一个模型**不带图**照样能聊（门控只挡挂图，不挡这个模型）
    const f2 = fakeFetch([say("好。")]);
    const r2 = await runChatTurn(opts(s, f2.fn, { model: "deepseek-v4-pro" }));
    eq("aivision.turn.gate.plain-still-works", r2.ok, true);
    eq("aivision.turn.gate.plain-requested", f2.seen.length, 1);

    // unknown 模型挂图**放行**
    const f3 = fakeFetch([say("好。")]);
    const r3 = await runChatTurn(opts(s, f3.fn, { model: "my-gateway-v9", imageDataUrl: SMALL_URL }));
    eq("aivision.turn.gate.unknown-allowed", r3.ok, true);
    eq("aivision.turn.gate.unknown-requested", f3.seen.length, 1);
    const u3 = (f3.seen[0].body.messages as ChatMessage[]).filter((m) => m.role === "user");
    eq("aivision.turn.gate.unknown-array", Array.isArray(u3[0].content), true);
  }

  // ================================================================ 11. 多轮：图只跟那一条 user 消息走
  {
    const s = new Session();
    s.history.clear();
    // 第一轮模型要调一个只读工具，第二轮才回文本（图必须留在**第一轮的 user 消息**上）
    const toolReply = JSON.stringify({
      choices: [{
        index: 0, finish_reason: "tool_calls",
        message: {
          role: "assistant", content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "doc_digest", arguments: "{}" } }],
        },
      }],
    });
    const { fn, seen } = fakeFetch([toolReply, say("读完了。")]);
    const r = await runChatTurn(opts(s, fn, { imageDataUrl: SMALL_URL }));
    eq("aivision.turn.multi.ok", r.ok, true);
    eq("aivision.turn.multi.rounds", r.rounds, 2);
    eq("aivision.turn.multi.requests", seen.length, 2);
    // 两轮的请求体里那条 user 消息都带着图（历史是原样回传的）
    for (let i = 0; i < 2; i++) {
      const msgs = seen[i].body.messages as ChatMessage[];
      const user = msgs.filter((m) => m.role === "user");
      eq("aivision.turn.multi.round" + i + "-one-user", user.length, 1);
      const parts = user[0].content as ChatContentPart[];
      eq("aivision.turn.multi.round" + i + "-image", Array.isArray(parts) && parts[1].type === "image_url", true);
      // 回灌的 assistant / tool 消息**绝不能**是数组（上游对非 user 带图回 400）
      for (const m of msgs) {
        if (m.role === "user") continue;
        eq("aivision.turn.multi.round" + i + "-" + m.role + "-no-image", hasImagePart(m.content), false);
      }
    }
  }

  // ================================================================ 12. 源码级口径（静态扫描）
  {
    // `ai-vision.ts` 必须**保持无 DOM**：它要在 Node 里跑单测（页面侧只做 canvas + 编码）
    const visionSrc = readFile("src/app/ai-vision.ts");
    ok("aivision.src.no-dom", visionSrc.indexOf("document") < 0 && visionSrc.indexOf("window.") < 0);
    ok("aivision.src.uses-repo-b64", readFile("src/ui/AiPanel.tsx").indexOf('from "../engine/b64"') > 0);
    ok("aivision.src.uses-repo-png", readFile("src/ui/AiPanel.tsx").indexOf('from "../io/exporters"') > 0);
    // 体积上限的**唯一来源**是壳的 1 MiB（改壳的常量时这里会提醒）
    const shellSrc = readFile("toolchain/pc-shell.mjs");
    ok("aivision.src.shell-1mib", shellSrc.indexOf("const MAX_BODY_BYTES = 1024 * 1024;") > 0);
    ok("aivision.src.hard-under-1mib", AI_VISION_HARD_DATA_URL_BYTES < 1024 * 1024);
    // 面板装配图的那一行（`imageDataUrl`）必须真的在 `runChatTurn` 的入参里
    const panelSrc = readFile("src/ui/AiPanel.tsx");
    ok("aivision.src.panel-passes-image", panelSrc.indexOf("imageDataUrl: attach ? attach.dataUrl : \"\"") > 0);
    ok("aivision.src.panel-gates-before-send", panelSrc.indexOf("visionGate(model, true)") > 0);
    ok("aivision.src.panel-input-accept", panelSrc.indexOf('accept="image/png,image/jpeg,image/webp,image/gif"') > 0);
  }
}

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");
/** 已编译的 src/ 目录（用例跑在 <app>/tests/.ts-out/tests） */
const readFile = (rel: string): string => fs.readFileSync(path.resolve(__dirname, "../../../" + rel), "utf8") as string;
