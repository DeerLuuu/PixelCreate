// Dependency resolver that installs .so files for requested termux packages.
// Pure JS + explicit-binary spawn (no reliance on /bin/sh).
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const BASH = "/data/data/com.dsharnessmobile.shell/files/usr/bin/bash";
const TAR = "/data/data/com.dsharnessmobile.shell/files/usr/bin/tar";
const XZ = "/data/data/com.dsharnessmobile.shell/files/usr/bin/xz";
const CURL = "/data/data/com.dsharnessmobile.shell/files/usr/bin/curl";

const PREFIX = process.env.PREFIX;
const CACHE = process.env.DEBCACHE;
const REPO = process.env.REPO;
const pkgData = JSON.parse(fs.readFileSync(process.env.PKGSJSON, "utf8"));

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write((r.stderr || "") + (r.stdout || ""));
    process.exit(4);
  }
  return (r.stdout || "");
}

function debToDataTar(deb) {
  const buf = fs.readFileSync(deb);
  if (buf.slice(0, 8).toString() !== "!<arch>\n") throw new Error("not ar: " + deb);
  let off = 8;
  while (off + 60 <= buf.length) {
    const name = buf.slice(off, off + 16).toString().replace(/\s+$/g, "");
    const size = parseInt(buf.slice(off + 48, off + 58).toString().trim(), 10);
    const start = off + 60;
    if (name.startsWith("data.tar")) {
      const p = deb + ".data.tar.xz";
      fs.writeFileSync(p, buf.slice(start, start + size));
      return p;
    }
    off = start + size + (size % 2);
  }
  throw new Error("no data.tar in " + deb);
}

function install(deb) {
  const tar = debToDataTar(deb);
  const tmp = path.join(CACHE, "x-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmp, { recursive: true });
  const { spawnSync: sp } = require("child_process");
  const r2 = sp(XZ, ["-dc", tar], { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 });
  fs.writeFileSync(path.join(tmp, "data.tar"), r2.stdout);
  run(TAR, ["-xf", path.join(tmp, "data.tar"), "-C", tmp]);
  const libs = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.so(\.|$)/.test(e.name)) libs.push(p);
      else if (e.isSymbolicLink() && /\.so(\.|$)/.test(e.name)) {
        // resolve link target then copy real file if it points to a file in tree
        const real = fs.realpathSync(p);
        if (fs.statSync(real).isFile()) libs.push(real);
      }
    }
  })(tmp);
  let n = 0;
  for (const so of libs) {
    const base = path.basename(so);
    if (base.startsWith("libandroid-shmem")) continue;
    fs.copyFileSync(so, path.join(PREFIX, "lib", base));
    n++;
  }
  console.log("  -> installed", n, "libs");
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tar, { force: true });
}

function fetch(pkg) {
  const entry = pkgData[pkg];
  if (!entry || !entry.Filename) { console.error("SKIP (no entry):", pkg); return null; }
  const fname = path.basename(entry.Filename);
  const dest = path.join(CACHE, fname);
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1000) {
    console.log("DL", pkg, entry.Version);
    const r = spawnSync(CURL, ["-sL", "-o", dest, REPO + "/" + entry.Filename], { stdio: "inherit" });
    if (r.status !== 0) process.exit(5);
  }
  return dest;
}

const queue = process.argv.slice(2);
const done = new Set();
while (queue.length) {
  const p = queue.shift();
  if (done.has(p)) continue;
  done.add(p);
  const deb = fetch(p);
  if (!deb) continue;
  console.log("== install", p);
  install(deb);
  const entry = pkgData[p];
  const deps = (entry.Depends || "").split(",")
    .map(s => s.trim().split(" ")[0])
    .filter(s => /^[a-z0-9.+-]+$/.test(s));
  for (const d of deps) if (!done.has(d)) queue.push(d);
}
console.log("RESOLVE DONE");
