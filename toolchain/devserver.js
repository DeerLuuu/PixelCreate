// PixelCraft dev server: static www + log beacon + /diag
const http = require("http");
const fs = require("fs");
const path = require("path");

const WWW = "/storage/emulated/0/Download/ds文件夹/pixelcraft/app2/www";
const LOGF = "/storage/emulated/0/Download/ds文件夹/pixelcraft/web.log";
const PORT = 8090;
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".json": "application/json", ".gif": "image/gif", ".ico": "image/x-icon"
};

const DIAG_HTML = `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:monospace;padding:16px;background:#111;color:#ddd}pre{white-space:pre-wrap}</style>
<h3>PixelCraft /diag</h3>
<pre id="o">loading…</pre>
<script>
function dump(){
  var d=document.documentElement,b=document.body;
  var s="";
  s+="userAgent="+navigator.userAgent.slice(0,140)+"\\n";
  s+="innerWidth="+window.innerWidth+" innerHeight="+window.innerHeight+"\\n";
  s+="outerWidth="+window.outerWidth+" outerHeight="+window.outerHeight+"\\n";
  s+="screen="+(window.screen?window.screen.width+"x"+window.screen.height:"?")+"\\n";
  s+="dpr="+(window.devicePixelRatio||1)+"\\n";
  s+="docEl.clientWidth="+d.clientWidth+" scrollWidth="+d.scrollWidth+"\\n";
  s+="body.clientWidth="+(b?b.clientWidth:"?")+" scrollWidth="+(b?b.scrollWidth:"?")+"\\n";
  s+="orientation="+(window.screen&&window.screen.orientation?window.screen.orientation.type:"?")+"\\n";
  s+="visualViewport="+(window.visualViewport?(window.visualViewport.width+"x"+window.visualViewport.height):"?");
  document.getElementById("o").textContent=s;
  try{window.__tel&&window.__tel("diag",s)}catch(e){}
}
setTimeout(dump,150);window.addEventListener("resize",dump);window.addEventListener("load",dump);
<\/script>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  if (req.method === "POST" && p === "/log") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const entry = JSON.parse(body);
        entry.t = Date.now();
        fs.appendFileSync(LOGF, JSON.stringify(entry) + "\n");
      } catch (e) { }
      res.writeHead(200); res.end("ok");
    });
    return;
  }
  if (p === "/log" && req.method === "GET") {
    try {
      const txt = fs.readFileSync(LOGF, "utf8");
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(txt.slice(-120000));
    } catch (e) { res.writeHead(200); res.end("(empty)"); }
    return;
  }
  if (p === "/diag") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(DIAG_HTML);
    return;
  }
  let rel = p === "/" ? "/index.html" : p;
  const file = path.normalize(path.join(WWW, rel));
  if (!file.startsWith(WWW)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });
});
server.listen(PORT, "0.0.0.0", () => {
  console.log("PixelCraft dev server on http://127.0.0.1:" + PORT);
});
