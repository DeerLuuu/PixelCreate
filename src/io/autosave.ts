// Autosave persistence: IndexedDB first (large canvases, no 4MB cap), with
// localStorage as a fallback for environments without IDB — and as the source
// for migrating autosaves written by older versions.
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

const DB_NAME = "pixelcraft";
const STORE = "autosave";
const KEY = "current";
const LS_TEXT = "pc.autosave2";
const LS_META = "pc.autosave2.meta";

/** refuse absurd payloads that would blow up memory when parsing (~32MB) */
export const AUTOSAVE_MAX_BYTES = 32 * 1024 * 1024;

const emptyMeta = (text: string): AutosaveMeta => ({
  savedAt: 0, bytes: text.length, name: "", w: 0, h: 0, frames: 0, layers: 0,
});

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

function readLsMeta(): AutosaveMeta | null {
  try {
    const m = JSON.parse(localStorage.getItem(LS_META) ?? "null");
    return m && typeof m === "object" && typeof m.savedAt === "number" ? (m as AutosaveMeta) : null;
  } catch { return null; }
}
function writeLsMeta(meta: AutosaveMeta): void {
  try { localStorage.setItem(LS_META, JSON.stringify(meta)); } catch { /* ignore */ }
}

/** store the serialized project; returns which backend took it */
export async function saveAutosave(text: string, meta: AutosaveMeta): Promise<"idb" | "local" | "too-big" | "fail"> {
  if (text.length > AUTOSAVE_MAX_BYTES) return "too-big";
  const db = await openDb();
  if (db) {
    const ok = await new Promise<boolean>((res) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put({ text, meta } satisfies AutosaveRecord, KEY);
        tx.oncomplete = () => res(true);
        tx.onerror = () => res(false);
        tx.onabort = () => res(false);
      } catch { res(false); }
    });
    db.close();
    if (ok) {
      writeLsMeta(meta);
      return "idb";
    }
  }
  try {
    localStorage.setItem(LS_TEXT, text);
    writeLsMeta(meta);
    return "local";
  } catch {
    return "fail";
  }
}

/** newest autosave, from IDB or (migrating) localStorage */
export async function loadAutosave(): Promise<AutosaveRecord | null> {
  const db = await openDb();
  if (db) {
    const rec = await new Promise<AutosaveRecord | null>((res) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(KEY);
        req.onsuccess = () => res((req.result as AutosaveRecord | undefined) ?? null);
        req.onerror = () => res(null);
      } catch { res(null); }
    });
    db.close();
    if (rec && typeof rec.text === "string" && rec.text.length > 120) {
      return { text: rec.text, meta: rec.meta ?? emptyMeta(rec.text) };
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

export async function clearAutosave(): Promise<void> {
  const db = await openDb();
  if (db) {
    await new Promise<void>((res) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(KEY);
        tx.oncomplete = () => res();
        tx.onerror = () => res();
        tx.onabort = () => res();
      } catch { res(); }
    });
    db.close();
  }
  try {
    localStorage.removeItem(LS_TEXT);
    localStorage.removeItem(LS_META);
  } catch { /* ignore */ }
}
