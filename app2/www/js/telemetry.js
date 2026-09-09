/* PixelCraft telemetry: POST js errors/logs to local dev server if reachable */
(function () {
  function send(kind, msg, extra) {
    try {
      const payload = { kind: kind, msg: String(msg || "").slice(0, 600), extra: extra || {} };
      if (window.navigator && navigator.sendBeacon) {
        navigator.sendBeacon("/log", new Blob([JSON.stringify(payload)], { type: "application/json" }));
      } else {
        fetch("/log", { method: "POST", body: JSON.stringify(payload), keepalive: true }).catch(function () { });
      }
    } catch (e) { }
  }
  window.__tel = function (kind, msg, extra) {
    try { if (location.hostname === "127.0.0.1" || location.hostname === "localhost" || location.protocol === "http:") send(kind, msg, extra); } catch (e) { }
  };
  window.addEventListener("error", function (e) {
    window.__tel("err", (e && (e.message || e.error && e.error.message)) || "unknown", { stack: e && e.error && e.error.stack ? String(e.error.stack).slice(0, 800) : "" });
  });
  window.addEventListener("unhandledrejection", function (e) {
    const r = e && e.reason;
    window.__tel("rej", r && (r.message || String(r)) || "rejection");
  });
  var origErr = console.error;
  console.error = function () {
    try { window.__tel("cerr", Array.prototype.slice.call(arguments).map(String).join(" ").slice(0, 400)); } catch (e) { }
    origErr && origErr.apply(console, arguments);
  };
  window.__tel("boot", "page loaded " + location.href);
})();

/* layout diagnostics dumped shortly after load */
(function () {
  function rect(sel) {
    var e = document.querySelector(sel);
    if (!e) return null;
    var r = e.getBoundingClientRect();
    return { id: sel, l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
  }
  function dump() {
    try {
      var de = document.documentElement, body = document.body;
      var parts = [];
      // current React shell selectors (the old vanilla ids are long gone)
      var sels = [".app-root", ".topbar", ".workspace", ".view-canvas", ".ctrlbar", ".tline-wrap", ".ase-scroll", ".dlg", ".panel"];
      for (var i = 0; i < sels.length; i++) { var r = rect(sels[i]); if (r) parts.push(r); }
      var info = {
        kind: "layout",
        innerW: window.innerWidth, innerH: window.innerHeight,
        dpr: window.devicePixelRatio,
        docEl: { cw: de.clientWidth, sw: de.scrollWidth },
        body: { cw: body ? body.clientWidth : null, sw: body ? body.scrollWidth : null },
        scroll: { x: window.scrollX || de.scrollLeft || 0 },
        visual: window.visualViewport ? { w: window.visualViewport.width, h: window.visualViewport.height, offL: window.visualViewport.offsetLeft } : null,
        rects: parts,
        zoom: window.devicePixelRatio,
        lang: (navigator.language || "")
      };
      try {
        var payload = JSON.stringify(info);
        if (navigator.sendBeacon) navigator.sendBeacon("/log", new Blob([payload], { type: "application/json" }));
        else fetch("/log", { method: "POST", body: payload }).catch(function () { });
      } catch (e) { }
    } catch (e) { }
  }
  setTimeout(dump, 800);
  window.addEventListener("load", function () { setTimeout(dump, 600); });
})();
