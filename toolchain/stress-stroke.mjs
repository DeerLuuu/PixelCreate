// 笔迹性能基线：量「一次 pointermove 到底花多久」，以及合成次数与耗时。
//
// 为什么要有这个工具：曾经把「笔迹 overlay 层」列成性能上的最后一块，理由是
// "每移动一次都要重合成"。真去量之后发现**合成本身只有 0.3–0.8ms**（见 docs/COMPARISON.md
// 的性能基线表），做覆盖层省下的不到一帧预算的 5% —— 结论是不值得做。这类判断只能靠量，
// 所以把量法固化下来，改渲染管线之后跑一遍就能看出有没有真退化。
//
// 用法（需要两个东西在跑：静态服务 + 一个开着的 CDP 端口）：
//   node toolchain/devserver.js &                       # app2/www，8090
//   msedge --headless=new --remote-debugging-port=9222 \
//          --user-data-dir=/tmp/edge-perf about:blank & # 任意 Chromium 都行
//   node toolchain/stress-stroke.mjs                    # 默认 9222 + 8090
//
// 选项：
//   --cdp <url>      CDP 端点（默认 http://127.0.0.1:9222）
//   --page <url>    页面地址（默认 http://127.0.0.1:8090/index.html）
//   --steps <n>     一笔走多少步（默认 60）
//   --doc <px>      新建文档边长（默认 512）
//   --brush <px>    笔刷尺寸（默认 64）
//   --layers <n>    图层数（默认 12）
//   --plain         不做最坏配置（不加图层、不开平铺与洋葱皮）
//   --json          只输出 JSON（给脚本/CI 用）
//
// 输出两行数字，两行都重要：
//   · 同步耗时 = 事件派发到处理完（手势 + 落笔 + 标记脏区）—— 这是"跟手"的部分；
//   · 合成 = 之后 rAF 里做的重合成 + blit，读应用自己的渲染调试计数（设置 → 显示 → 渲染调试）。
const CDP_DEFAULT = "http://127.0.0.1:9222";
const PAGE_DEFAULT = "http://127.0.0.1:8090/index.html";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const flag = (name) => argv.includes("--" + name);
const CDP = arg("cdp", CDP_DEFAULT).replace(/\/$/, "");
const PAGE = arg("page", PAGE_DEFAULT);
const STEPS = Math.max(1, Number(arg("steps", 60)) | 0);
const DOC = Math.max(8, Math.min(1024, Number(arg("doc", 512)) | 0));
const BRUSH = Math.max(1, Math.min(64, Number(arg("brush", 64)) | 0));
const LAYERS = Math.max(1, Math.min(32, Number(arg("layers", 12)) | 0));
const PLAIN = flag("plain");
const JSON_ONLY = flag("json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(CDP + "/json/list")).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("CDP 上没有 page 目标：" + CDP);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === "Runtime.exceptionThrown") {
      errors.push((m.params.exceptionDetails?.exception?.description ?? "").split("\n")[0]);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const js = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error("页面里报错：" + (r.result.exceptionDetails.exception?.description ?? ""));
    return r.result?.result?.value;
  };
  return { send, js, errors, close: () => ws.close() };
}

/** 在页面里装计时器：包住 dispatchEvent，统计"处理一次事件"的耗时 */
const INSTALL_TIMER = `(() => {
  window.__ms = { n: 0, sum: 0, max: 0 };
  window.__timeMove = (fn) => {
    const t0 = performance.now(); fn();
    const dt = performance.now() - t0, s = window.__ms;
    s.n++; s.sum += dt; if (dt > s.max) s.max = dt;
    return dt;
  };
  return 1;
})()`;

const TAP = (expr) => `(() => {
  const el = ${expr};
  if (!el) return "missing";
  const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  for (const [t, ex] of [["pointerdown", { buttons: 1 }], ["pointerup", { buttons: 0 }]]) {
    el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: "touch", isPrimary: true, ...ex }));
  }
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  return "ok";
})()`;

/** 页面上"非透明像素的包围盒"= 文档在屏幕上的位置（棋盘格只铺在文档范围内） */
const DOC_RECT = `(() => {
  const c = [...document.querySelectorAll("canvas")].filter((x) => x.width > 200 && x.height > 200)[0];
  if (!c) return null;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y += 2) {
    for (let x = 0; x < c.width; x += 2) {
      if (d[(y * c.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const r = c.getBoundingClientRect();
  return { cx: Math.round(r.left + (x0 + x1) / 2 / (c.width / r.width)),
           cy: Math.round(r.top + (y0 + y1) / 2 / (c.height / r.height)) };
})()`;

async function main() {
  const c = await connect();
  const { js, send } = c;
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });

  // 1) 把最坏配置写进 prefs（文档尺寸 / 笔刷 / 平铺 / 洋葱皮），再重载让它生效
  await js(`(() => {
    const p = JSON.parse(localStorage.getItem("pc.prefs") || "{}");
    p.newDocW = ${DOC}; p.newDocH = ${DOC}; p.brushSize = ${PLAIN ? 1 : BRUSH};
    ${PLAIN ? 'delete p.tileMode; delete p.onion;' : 'p.tileMode = "grid"; p.onion = true; p.onionBefore = 2; p.onionAfter = 2;'}
    localStorage.setItem("pc.prefs", JSON.stringify(p));
    return 1;
  })()`);
  await send("Page.navigate", { url: PAGE + "?perf=" + Date.now() });
  await sleep(2600);
  await js(`(() => { const s = document.createElement("style"); s.textContent = ".guide-layer,.guide-mask,.tip-host{display:none !important}"; document.head.appendChild(s); return 1; })()`);
  await js(`window.__pcRender && window.__pcRender.setEnabled(true)`);

  // 2) 新建文档（弹窗默认值就是刚写进去的尺寸）
  await js(TAP(`document.querySelector('[data-guide="btn-menu"]')`));
  await sleep(450);
  await js(TAP(`document.querySelector('[data-guide="menu-new"]')`));
  await sleep(900);
  await js(TAP(`[...document.querySelectorAll(".dlg-foot .btn")].find((b) => (b.textContent || "").includes("确定"))`));
  await sleep(1500);
  const docBox = await js(`(() => { const c = [...document.querySelectorAll("canvas")].filter((x) => x.width > 200)[0]; return c ? c.width + "x" + c.height : "?"; })()`);

  // 3) 图层 / 洋葱皮
  let layers = 1;
  if (!PLAIN) {
    await js(`(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "") === "显示时间轴"); if (b) b.click(); return 1; })()`);
    await sleep(700);
    for (let i = 1; i < LAYERS; i++) {
      const ok = await js(`(() => { const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "") === "新建图层"); if (!b) return false; b.click(); return true; })()`);
      if (ok) layers++;
      await sleep(100);
    }
    await js(TAP(`[...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "") === "洋葱皮")`));
    await sleep(400);
  }

  // 4) 一笔：每步之间 >1 帧，免得被 rAF 合并成一次（那样量不到每步代价）
  await js(INSTALL_TIMER);
  const rect = await js(DOC_RECT);
  if (!rect) throw new Error("找不到文档区域（画布还没画出来？）");
  const evIn = (type, x, y, buttons) => js(`(() => {
    const c = [...document.querySelectorAll("canvas")].filter((x) => x.width > 200 && x.height > 200)[0];
    return window.__timeMove(() => c.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
      bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y},
      pointerId: 5, pointerType: "touch", isPrimary: true, buttons: ${buttons}, pressure: ${buttons ? 0.6 : 0},
    })));
  })()`);
  const before = JSON.parse(await js(`JSON.stringify(window.__pcRender.totals)`));
  await evIn("pointerdown", rect.cx, rect.cy, 1);
  for (let i = 1; i <= STEPS; i++) {
    await evIn("pointermove", rect.cx + i * 4, rect.cy + Math.sin(i / 4) * 40, 1);
    await sleep(18);
  }
  await evIn("pointerup", rect.cx + STEPS * 4, rect.cy, 0);
  await sleep(700);
  const after = JSON.parse(await js(`JSON.stringify(window.__pcRender.totals)`));
  const ms = JSON.parse(await js(`JSON.stringify(window.__ms)`));

  const out = {
    rig: { doc: DOC, brush: PLAIN ? 1 : BRUSH, layers, tile: !PLAIN, onion: !PLAIN, steps: STEPS, canvas: docBox },
    perMoveSyncMs: { avg: +(ms.sum / Math.max(1, ms.n)).toFixed(3), max: +ms.max.toFixed(3), samples: ms.n },
    compose: {
      count: after.composes - before.composes,
      partials: after.partials - before.partials,
      rebuilds: after.rebuilds - before.rebuilds,
      lastMs: +after.lastMs.toFixed(3),
      maxMs: +after.maxMs.toFixed(3),
    },
    errors: c.errors,
  };
  if (JSON_ONLY) {
    console.log(JSON.stringify(out));
  } else {
    console.log("笔迹性能基线");
    console.log("  配置      : " + DOC + "² 文档 · " + out.rig.layers + " 图层 · 笔刷 " + out.rig.brush + "px"
      + (PLAIN ? " · 无平铺/洋葱皮" : " · 平铺九宫格 + 洋葱皮") + " · 画布 " + docBox);
    console.log("  每步同步  : 平均 " + out.perMoveSyncMs.avg + "ms · 最大 " + out.perMoveSyncMs.max + "ms（" + out.perMoveSyncMs.samples + " 次采样）");
    console.log("  一次一笔  : 重合成 " + out.compose.count + " 次（局部 " + out.compose.partials + " / 整幅 " + out.compose.rebuilds + "）"
      + " · 合成耗时 最近 " + out.compose.lastMs + "ms / 峰值 " + out.compose.maxMs + "ms");
    console.log("  参考      : 60fps 一帧 16.7ms；上面两个数加起来就是这一笔每帧的大致开销");
    if (c.errors.length) console.log("  页面报错  : " + c.errors.join(" | "));
  }
  c.close();
}
main().catch((e) => {
  console.error("FAIL " + (e?.message ?? e));
  process.exitCode = 1;
});
