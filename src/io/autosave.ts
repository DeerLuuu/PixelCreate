// 自动保存：IndexedDB 优先（大画布没有 4MB 上限），localStorage 兜底（只能存最新一版）。
//
// 多版本（1.1.1.9 起）——**环形槽位 + 一份小索引**：
//   · IDB 里固定 16 个槽位（`h0`..`h15`），每存一次只写**一个**槽位，不搬动旧数据；
//   · `index` 存版本表（新的在前，每条只有几十字节），排序与列表都只读它；
//   · 淘汰 = 从索引尾部删掉旧版本、并删它占的槽位：条数上限是设置里的「保留版本数」
//     （1..12），另有历史总字节上限（`AUTOSAVE_HISTORY_BYTES`）；
//   · 槽位数（16）比最大保留数（12）多，所以**新槽位永远压不到在册版本的数据**；
//   · 内容没变（哈希相同）时只更新「最近一次保存时间」，不占新版本、也不写大对象 ——
//     否则每 5 分钟的定时保存会在半小时内把 5 个槽位全填成同一份内容。
//
// 兼容：旧版本只写 `KEY`（`current`）。第一次读到时把它迁移成第 1 版并删掉 `current`，
// 所以升级后原来的自动保存不会丢。localStorage 兜底路径仍是单槽位（没有历史）。
export interface AutosaveMeta {
  savedAt: number;
  bytes: number;
  name: string;
  w: number;
  h: number;
  frames: number;
  layers: number;
}

export interface AutosaveRecord {
  text: string;
  meta: AutosaveMeta;
}

/** 这一版是谁存的（历史面板上显示，方便判断"哪个时间点值得回"） */
export type AutosaveReason = "start" | "timer" | "hide" | "manual";

/** 一条历史版本（不含像素，读列表不需要碰大对象） */
export interface AutosaveVersion {
  /** 全局递增序号（同毫秒也能分先后；恢复/删除都按它定位） */
  seq: number;
  /** 环形槽位下标，数据存在 `h<slot>` */
  slot: number;
  savedAt: number;
  bytes: number;
  hash: string;
  name: string;
  w: number;
  h: number;
  frames: number;
  layers: number;
  reason: AutosaveReason;
}

export interface AutosaveIndex {
  /** 已分配的最大序号 */
  seq: number;
  /** 新的在前 */
  versions: AutosaveVersion[];
}

const DB_NAME = "pixelcraft";
const STORE = "autosave";
/** 旧版本的单一 key；迁移用，新代码不再写它 */
const KEY = "current";
const KEY_INDEX = "index";
const slotKey = (n: number): string => "h" + n;
/** 环形槽位数（必须大于 AUTOSAVE_KEEP_MAX，见文件头「新槽位压不到在册版本」） */
const RING = 16;

const LS_TEXT = "pc.autosave2";
const LS_META = "pc.autosave2.meta";
/** 「上次是不是正常退出」的标记：启动时写 0（运行中），隐藏/卸载时写 1 */
const LS_CLEAN = "pc.autosave.clean";

/** refuse absurd payloads that would blow up memory when parsing (~32MB) */
export const AUTOSAVE_MAX_BYTES = 32 * 1024 * 1024;
/** 保留版本数的上限（设置里的滑杆范围就是 1..这个数） */
export const AUTOSAVE_KEEP_MAX = 12;
export const AUTOSAVE_KEEP_DEFAULT = 5;
/** 历史占用的总字节上限：超了就淘汰最旧的（大画布上可能只留得下 1–2 版） */
export const AUTOSAVE_HISTORY_BYTES = 64 * 1024 * 1024;

const emptyMeta = (text: string): AutosaveMeta => ({
  savedAt: 0, bytes: text.length, name: "", w: 0, h: 0, frames: 0, layers: 0,
});

/**
 * 存储后端：环形版本的逻辑（`pushVersion` / `readIndex` / …）与后端无关，
 * 所以能用内存后端直接测（见 `tests/autosave.test.ts`）。
 */
export interface AutosaveKv {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<boolean>;
  del(key: string): Promise<void>;
}

/** FNV-1a 32 位 + 长度：判断「这一版是不是白存的」，不用真比对几 MB 文本 */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16) + ":" + s.length;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      if (typeof indexedDB === "undefined") return res(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
      req.onblocked = () => res(null);
    } catch { res(null); }
  });
}

let dbCache: IDBDatabase | null | undefined;

/** IDB 后端（连接在整个页面生命周期里复用；不可用返回 null） */
export async function idbKv(): Promise<AutosaveKv | null> {
  if (dbCache === undefined) dbCache = await openDb();
  const db = dbCache;
  if (!db) return null;
  return {
    get: (k) => new Promise((res) => {
      try {
        const t = db.transaction(STORE, "readonly");
        const rq = t.objectStore(STORE).get(k);
        rq.onsuccess = () => res((rq.result as unknown) ?? null);
        rq.onerror = () => res(null);
        t.onabort = () => res(null);
      } catch { res(null); }
    }),
    put: (k, v) => new Promise((res) => {
      try {
        const t = db.transaction(STORE, "readwrite");
        t.objectStore(STORE).put(v, k);
        t.oncomplete = () => res(true);
        t.onerror = () => res(false);
        t.onabort = () => res(false);
      } catch { res(false); }
    }),
    del: (k) => new Promise((res) => {
      try {
        const t = db.transaction(STORE, "readwrite");
        t.objectStore(STORE).delete(k);
        t.oncomplete = () => res();
        t.onerror = () => res();
        t.onabort = () => res();
      } catch { res(); }
    }),
  };
}

// ---------------------------------------------------------------- 版本表逻辑

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 认一条记录（字段不全也认，坏数据只影响显示不影响恢复） */
function asRecord(raw: unknown): AutosaveRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<AutosaveRecord>;
  if (typeof r.text !== "string" || r.text.length < 120) return null;
  return { text: r.text, meta: (r.meta && typeof r.meta === "object" ? r.meta : emptyMeta(r.text)) as AutosaveMeta };
}

/** 认一份索引：任何一条不合法就整份丢弃（宁可当没有历史，也不能让坏数据卡住写入） */
function parseIndex(raw: unknown): AutosaveIndex | null {
  if (!raw || typeof raw !== "object") return null;
  const i = raw as Partial<AutosaveIndex>;
  if (!isNum(i.seq) || !Array.isArray(i.versions)) return null;
  const out: AutosaveVersion[] = [];
  for (const v of i.versions) {
    if (!v || typeof v !== "object") return null;
    const e = v as AutosaveVersion;
    if (!isNum(e.seq) || !isNum(e.slot) || !isNum(e.savedAt)) return null;
    out.push({
      seq: e.seq, slot: e.slot, savedAt: e.savedAt,
      bytes: isNum(e.bytes) ? e.bytes : 0, hash: typeof e.hash === "string" ? e.hash : "",
      name: typeof e.name === "string" ? e.name : "",
      w: isNum(e.w) ? e.w : 0, h: isNum(e.h) ? e.h : 0,
      frames: isNum(e.frames) ? e.frames : 0, layers: isNum(e.layers) ? e.layers : 0,
      reason: (["start", "timer", "hide", "manual"] as string[]).includes(e.reason) ? e.reason : "timer",
    });
  }
  return { seq: i.seq, versions: out };
}

function entryOf(seq: number, rec: AutosaveRecord, reason: AutosaveReason): AutosaveVersion {
  const m = rec.meta;
  return {
    seq, slot: ((seq % RING) + RING) % RING, savedAt: m?.savedAt || Date.now(),
    bytes: m?.bytes || rec.text.length, hash: hashText(rec.text),
    name: m?.name || "", w: m?.w || 0, h: m?.h || 0,
    frames: m?.frames || 0, layers: m?.layers || 0, reason,
  };
}

const totalBytes = (list: AutosaveVersion[]): number => list.reduce((n, v) => n + v.bytes, 0);

/** 读版本表；旧版本只写的 `current` 会在这里迁移成第 1 版（并删掉它） */
export async function readIndex(kv: AutosaveKv): Promise<AutosaveIndex> {
  const idx = parseIndex(await kv.get(KEY_INDEX));
  if (idx) return idx;
  const legacy = asRecord(await kv.get(KEY));
  const fresh: AutosaveIndex = { seq: 0, versions: [] };
  if (!legacy) return fresh;
  const e = entryOf(1, legacy, "start");
  fresh.seq = 1;
  fresh.versions = [e];
  await kv.put(slotKey(e.slot), legacy);
  await kv.put(KEY_INDEX, fresh);
  await kv.del(KEY);
  return fresh;
}

/**
 * 追加一版并淘汰多余的版本。
 * `stored=false` 表示**数据没写进去**（配额不足且重试也失败）——调用方应当提示用户。
 */
export async function pushVersion(
  kv: AutosaveKv,
  rec: AutosaveRecord,
  reason: AutosaveReason,
  opts: { keep?: number; maxBytes?: number } = {},
): Promise<{ index: AutosaveIndex; added: boolean; stored: boolean }> {
  const idx = await readIndex(kv);
  const hash = hashText(rec.text);
  const newest = idx.versions[0];
  // 内容没变：只把"最近一次保存时间"和原因挪到最新，不占版本（定时保存的常态）
  if (newest && newest.hash === hash) {
    newest.savedAt = rec.meta?.savedAt || Date.now();
    newest.reason = reason;
    newest.bytes = rec.meta?.bytes || rec.text.length;
    await kv.put(KEY_INDEX, idx);
    return { index: idx, added: false, stored: true };
  }
  const seq = idx.seq + 1;
  let slot = ((seq % RING) + RING) % RING;
  let stored = await kv.put(slotKey(slot), rec);
  let dropped: AutosaveVersion[] = [];
  if (!stored && idx.versions.length > 1) {
    // 配额不足：改成**覆盖最旧那一版占的槽位**（它本来就要被淘汰）——不新增占用，所以写得进去；
    // 而不是"先删旧的再重试"：删了再失败就白丢历史
    const n = Math.ceil(idx.versions.length / 2);
    dropped = idx.versions.slice(idx.versions.length - n);
    const reuse = dropped[dropped.length - 1];
    idx.versions = idx.versions.slice(0, idx.versions.length - n);
    stored = await kv.put(slotKey(reuse.slot), rec);
    if (stored) {
      slot = reuse.slot;
      dropped = dropped.filter((v) => v.slot !== slot);   // 这个槽位现在是新数据，别删
    } else {
      idx.versions = idx.versions.concat(dropped);        // 还是写不进去：旧版本一个都不动
      dropped = [];
    }
  }
  if (!stored) return { index: idx, added: false, stored: false };
  for (const v of dropped) await kv.del(slotKey(v.slot));
  idx.seq = seq;
  const entry = entryOf(seq, rec, reason);
  entry.slot = slot;
  idx.versions.unshift(entry);
  const keep = Math.max(1, Math.min(AUTOSAVE_KEEP_MAX, Math.round(opts.keep ?? AUTOSAVE_KEEP_DEFAULT)));
  const maxBytes = opts.maxBytes ?? AUTOSAVE_HISTORY_BYTES;
  // 淘汰：条数与总字节双上限；**最后一条（最新那版）永远留着**
  while (idx.versions.length > keep || (idx.versions.length > 1 && totalBytes(idx.versions) > maxBytes)) {
    const dead = idx.versions.pop();
    if (!dead) break;
    await kv.del(slotKey(dead.slot));
  }
  await kv.put(KEY_INDEX, idx);
  return { index: idx, added: true, stored: true };
}

/** 版本列表（新的在前） */
export async function listVersions(kv: AutosaveKv): Promise<AutosaveVersion[]> {
  return (await readIndex(kv)).versions;
}

/** 读某一版的数据（恢复 / 导出用） */
export async function readVersion(kv: AutosaveKv, seq: number): Promise<AutosaveRecord | null> {
  const e = (await readIndex(kv)).versions.find((v) => v.seq === seq);
  if (!e) return null;
  return asRecord(await kv.get(slotKey(e.slot)));
}

/** 删掉某一版 */
export async function dropVersion(kv: AutosaveKv, seq: number): Promise<void> {
  const idx = await readIndex(kv);
  const i = idx.versions.findIndex((v) => v.seq === seq);
  if (i < 0) return;
  const [dead] = idx.versions.splice(i, 1);
  await kv.del(slotKey(dead.slot));
  await kv.put(KEY_INDEX, idx);
}

// ---------------------------------------------------------- 干净退出（崩溃判定）

/** 启动自检：标记「本进程正在运行」。必须在 `wasCleanExit()` 之后调用 */
export function markSessionRunning(): void {
  try { localStorage.setItem(LS_CLEAN, "0"); } catch { /* ignore */ }
}
/** 正常退出（切到后台 / 页面卸载）：写干净标记，下次启动就不提示恢复 */
export function markCleanExit(): void {
  try { localStorage.setItem(LS_CLEAN, "1"); } catch { /* ignore */ }
}
/** 上次是不是正常退出（没有标记 = 老版本或首次运行，按"不干净"处理会误报，所以当干净） */
export function wasCleanExit(): boolean {
  try { return localStorage.getItem(LS_CLEAN) !== "0"; } catch { return true; }
}

// ------------------------------------------------------------ 对外的读写入口

function readLsMeta(): AutosaveMeta | null {
  try {
    const m = JSON.parse(localStorage.getItem(LS_META) ?? "null");
    return m && typeof m === "object" && typeof m.savedAt === "number" ? (m as AutosaveMeta) : null;
  } catch { return null; }
}
function writeLsMeta(meta: AutosaveMeta): void {
  try { localStorage.setItem(LS_META, JSON.stringify(meta)); } catch { /* ignore */ }
}

/**
 * store the serialized project; returns which backend took it
 * `keep` = 保留版本数（设置项 data.autosaveKeep）
 */
export async function saveAutosave(
  text: string, meta: AutosaveMeta, reason: AutosaveReason = "timer", keep = AUTOSAVE_KEEP_DEFAULT,
): Promise<"idb" | "local" | "too-big" | "fail"> {
  if (text.length > AUTOSAVE_MAX_BYTES) return "too-big";
  const kv = await idbKv();
  if (kv) {
    const r = await pushVersion(kv, { text, meta }, reason, { keep });
    if (r.stored) {
      writeLsMeta(meta);
      return "idb";
    }
  }
  // 没有 IDB（或写不进去）：退回单槽位 localStorage，没有历史
  try {
    localStorage.setItem(LS_TEXT, text);
    writeLsMeta(meta);
    return "local";
  } catch {
    return "fail";
  }
}

/** 最新一版（IDB 环形槽位，或 localStorage 兜底） */
export async function loadAutosave(): Promise<AutosaveRecord | null> {
  const kv = await idbKv();
  if (kv) {
    const list = (await readIndex(kv)).versions;
    if (list.length) {
      const rec = await readVersion(kv, list[0].seq);
      if (rec) return rec;
    }
  }
  try {
    const text = localStorage.getItem(LS_TEXT);
    if (!text || text.length < 120) return null;
    return { text, meta: readLsMeta() ?? emptyMeta(text) };
  } catch { return null; }
}

/** lightweight info for the settings screen (no project parsing) */
export async function autosaveMeta(): Promise<AutosaveMeta | null> {
  const ls = readLsMeta();
  if (ls) return ls;
  const rec = await loadAutosave();
  return rec ? rec.meta : null;
}

/** 历史版本（新的在前）；没有 IDB 时返回空数组（面板据此提示"此环境不支持历史"） */
export async function autosaveVersions(): Promise<AutosaveVersion[]> {
  const kv = await idbKv();
  if (!kv) return [];
  return listVersions(kv);
}

export async function readAutosaveVersion(seq: number): Promise<AutosaveRecord | null> {
  const kv = await idbKv();
  if (!kv) return null;
  return readVersion(kv, seq);
}

export async function dropAutosaveVersion(seq: number): Promise<void> {
  const kv = await idbKv();
  if (!kv) return;
  await dropVersion(kv, seq);
}

/** 当前环境支不支持历史版本（= IndexedDB 可用） */
export async function historySupported(): Promise<boolean> {
  return (await idbKv()) !== null;
}

/** 清掉最新一版与全部历史 */
export async function clearAutosave(): Promise<void> {
  const kv = await idbKv();
  if (kv) {
    const idx = await readIndex(kv);
    for (const v of idx.versions) await kv.del(slotKey(v.slot));
    await kv.put(KEY_INDEX, { seq: idx.seq, versions: [] });
  }
  try {
    localStorage.removeItem(LS_TEXT);
    localStorage.removeItem(LS_META);
  } catch { /* ignore */ }
}
