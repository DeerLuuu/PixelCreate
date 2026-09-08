// Reference-image persistence (IndexedDB): the floating reference picture and
// its window geometry survive a restart, so the same trace stays available.
export interface RefImg {
  w: number;
  h: number;
  px: Uint8ClampedArray;
  name: string;
}

export interface RefState extends RefImg {
  /** window position (CSS px, relative to the viewport element) */
  x: number;
  y: number;
  /** window edge length in CSS px */
  size: number;
  /** 10..100 percent */
  opacity: number;
}

const DB_NAME = "pixelcraft-ref";
const STORE = "ref";
const KEY = "current";
/** keep the stored image reasonable (a 4MP RGBA image is ~16MB) */
export const REF_MAX_BYTES = 12 * 1024 * 1024;

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

export async function saveRef(state: RefState): Promise<boolean> {
  const bytes = state.w * state.h * 4;
  if (!state.w || !state.h || bytes > REF_MAX_BYTES) return false;
  const db = await openDb();
  if (!db) return false;
  return new Promise((res) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(state, KEY);
      tx.oncomplete = () => { db.close(); res(true); };
      tx.onerror = () => { db.close(); res(false); };
      tx.onabort = () => { db.close(); res(false); };
    } catch { db.close(); res(false); }
  });
}

export async function loadRef(): Promise<RefState | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((res) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => {
        const v = req.result as RefState | undefined;
        db.close();
        if (!v || typeof v.w !== "number" || typeof v.h !== "number" || !v.px) return res(null);
        // IndexedDB may hand back a plain array after a structured-clone round trip
        const px = v.px instanceof Uint8ClampedArray ? v.px : new Uint8ClampedArray(v.px as ArrayLike<number>);
        if (px.length !== v.w * v.h * 4) return res(null);
        res({ ...v, px });
      };
      req.onerror = () => { db.close(); res(null); };
    } catch { db.close(); res(null); }
  });
}

export async function clearRef(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((res) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => { db.close(); res(); };
      tx.onabort = () => { db.close(); res(); };
    } catch { db.close(); res(); }
  });
}
