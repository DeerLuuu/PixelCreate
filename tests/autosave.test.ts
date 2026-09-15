// 自动保存的多版本环形逻辑（`src/io/autosave.ts`）—— 用内存后端直接驱动。
//
// 这里刻意不碰 IndexedDB：版本逻辑（迁移 / 追加 / 同内容不占版本 / 条数与字节淘汰 /
// 配额不足时"旧版本让位"）都在 `AutosaveKv` 之上，所以内存 Map 就能完整覆盖。
// 真机上 IDB 只是把这套逻辑落到一个 object store 里（同一个 store、key 区分槽位）。
import {
  AUTOSAVE_HISTORY_BYTES, AUTOSAVE_KEEP_DEFAULT, AUTOSAVE_KEEP_MAX,
  dropVersion, hashText, listVersions, pushVersion, readIndex, readVersion,
  type AutosaveKv, type AutosaveRecord,
} from "../src/io/autosave";
import { eq, ok } from "./common";

/** 内存后端：put 走 JSON 往返，模拟 IDB 的"结构化克隆"（写进去后再改原对象不影响存储） */
function memKv(): AutosaveKv & { map: Map<string, unknown>; puts: number } {
  const map = new Map<string, unknown>();
  const self = {
    map,
    puts: 0,
    get: async (k: string): Promise<unknown> => (map.has(k) ? map.get(k) : null),
    put: async (k: string, v: unknown): Promise<boolean> => {
      self.puts++;
      map.set(k, JSON.parse(JSON.stringify(v)));
      return true;
    },
    del: async (k: string): Promise<void> => { map.delete(k); },
  };
  return self;
}

/** 模拟"配额只够放 N 份工程数据"：第 N+1 份写不进去（删掉旧的之后又能写） */
function quotaKv(maxRecords: number): AutosaveKv & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  const isRecord = (v: unknown): boolean => {
    const r = v as { text?: unknown } | null;
    return !!r && typeof r === "object" && typeof r.text === "string";
  };
  const live = (): number => [...map.values()].filter(isRecord).length;
  return {
    map,
    get: async (k) => (map.has(k) ? map.get(k) : null),
    put: async (k, v) => {
      // 覆盖已有 key 不算新增；新 key 且已经放满 → 失败
      if (isRecord(v) && !map.has(k) && live() >= maxRecords) return false;
      map.set(k, JSON.parse(JSON.stringify(v)));
      return true;
    },
    del: async (k) => { map.delete(k); },
  };
}

const text = (tag: string): string => "PXC1" + tag + "x".repeat(200);
const rec = (tag: string, savedAt = 1000): AutosaveRecord => ({
  text: text(tag),
  meta: { savedAt, bytes: text(tag).length, name: "art", w: 64, h: 64, frames: 1, layers: 1 },
});
const slots = (kv: { map: Map<string, unknown> }): string[] =>
  [...kv.map.keys()].filter((k) => k.startsWith("h")).sort();

export async function testAutosave(): Promise<void> {
  // --- 常量口径 ---
  eq("autosave.keep.default", AUTOSAVE_KEEP_DEFAULT, 5);
  eq("autosave.keep.max", AUTOSAVE_KEEP_MAX, 12);
  eq("autosave.history.bytes", AUTOSAVE_HISTORY_BYTES, 64 * 1024 * 1024);
  // 环形槽位数必须大于最大保留数，否则新槽位会压到在册版本的数据（文件头的硬约束）
  ok("autosave.ring.headroom", AUTOSAVE_KEEP_MAX < 16, "keepMax=" + AUTOSAVE_KEEP_MAX);

  // --- 哈希：内容不同就不同，长度不同也一定不同 ---
  ok("autosave.hash.same", hashText(text("a")) === hashText(text("a")));
  ok("autosave.hash.diff", hashText(text("a")) !== hashText(text("b")));
  ok("autosave.hash.len", hashText("ab") !== hashText("ab "));

  // --- 迁移：旧版本只写 `current`，第一次读到时变成第 1 版，current 被删掉 ---
  {
    const kv = memKv();
    await kv.put("current", rec("legacy", 500));
    const idx = await readIndex(kv);
    eq("autosave.migrate.count", idx.versions.length, 1);
    eq("autosave.migrate.seq", idx.seq, 1);
    eq("autosave.migrate.reason", idx.versions[0].reason, "start");
    eq("autosave.migrate.current-gone", await kv.get("current"), null);
    const back = await readVersion(kv, 1);
    eq("autosave.migrate.text", back?.text, text("legacy"));
    eq("autosave.migrate.slot-written", slots(kv).length, 1);
  }

  // --- 追加：新的在前，序号递增，每一版都能按 seq 取回自己的内容 ---
  {
    const kv = memKv();
    await pushVersion(kv, rec("one", 1000), "timer", { keep: 5 });
    await pushVersion(kv, rec("two", 2000), "timer", { keep: 5 });
    const r3 = await pushVersion(kv, rec("three", 3000), "manual", { keep: 5 });
    eq("autosave.push.added", r3.added, true);
    eq("autosave.push.stored", r3.stored, true);
    const list = await listVersions(kv);
    eq("autosave.push.order", list.map((v) => v.seq).join(","), "3,2,1");
    eq("autosave.push.savedAt", list.map((v) => v.savedAt).join(","), "3000,2000,1000");
    eq("autosave.push.reason", list[0].reason, "manual");
    eq("autosave.push.meta", [list[0].name, list[0].w, list[0].h, list[0].layers].join(","), "art,64,64,1");
    eq("autosave.push.text2", (await readVersion(kv, 2))?.text, text("two"));
    eq("autosave.push.text1", (await readVersion(kv, 1))?.text, text("one"));
    eq("autosave.push.slots", slots(kv).length, 3);
  }

  // --- 内容没变：不占新版本，只把"最近保存时间/原因"挪到最新（定时保存的常态） ---
  {
    const kv = memKv();
    await pushVersion(kv, rec("same", 1000), "timer", { keep: 5 });
    const before = slots(kv).length;
    const again = await pushVersion(kv, rec("same", 9000), "manual", { keep: 5 });
    eq("autosave.same.added", again.added, false);
    eq("autosave.same.count", (await listVersions(kv)).length, 1);
    eq("autosave.same.savedAt", (await listVersions(kv))[0].savedAt, 9000);
    eq("autosave.same.reason", (await listVersions(kv))[0].reason, "manual");
    eq("autosave.same.slots", slots(kv).length, before);
  }

  // --- 条数淘汰：keep=2 时只留最新两版，被淘汰那一版的槽位数据真的删掉 ---
  {
    const kv = memKv();
    for (const t of ["a", "b", "c", "d"]) await pushVersion(kv, rec(t, 1000), "timer", { keep: 2 });
    const list = await listVersions(kv);
    eq("autosave.evict.count", list.length, 2);
    eq("autosave.evict.seq", list.map((v) => v.seq).join(","), "4,3");
    eq("autosave.evict.slots", slots(kv).length, 2);
    eq("autosave.evict.gone", await readVersion(kv, 1), null);
    eq("autosave.evict.gone2", await readVersion(kv, 2), null);
    eq("autosave.evict.kept", (await readVersion(kv, 4))?.text, text("d"));
  }

  // --- 字节淘汰：总容量很小 → 只留最新一版（最新的永远留着） ---
  {
    const kv = memKv();
    await pushVersion(kv, rec("big1", 1000), "timer", { keep: 5, maxBytes: 300 });
    await pushVersion(kv, rec("big2", 2000), "timer", { keep: 5, maxBytes: 300 });
    await pushVersion(kv, rec("big3", 3000), "timer", { keep: 5, maxBytes: 300 });
    const list = await listVersions(kv);
    eq("autosave.bytes.count", list.length, 1);
    eq("autosave.bytes.seq", list[0].seq, 3);
    eq("autosave.bytes.slots", slots(kv).length, 1);
  }

  // --- keep 越界会被夹到 1..AUTOSAVE_KEEP_MAX ---
  {
    const kv = memKv();
    for (let i = 0; i < 3; i++) await pushVersion(kv, rec("k" + i, 1000 + i), "timer", { keep: 0 });
    eq("autosave.keep.clamp-low", (await listVersions(kv)).length, 1);
    const kv2 = memKv();
    for (let i = 0; i < 3; i++) await pushVersion(kv2, rec("m" + i, 1000 + i), "timer", { keep: 999 });
    eq("autosave.keep.clamp-high", (await listVersions(kv2)).length, 3);
  }

  // --- 槽位不互相覆盖：连着存 8 版（keep 足够大）后每版都还读得出来 ---
  {
    const kv = memKv();
    for (let i = 0; i < 8; i++) await pushVersion(kv, rec("r" + i, 1000 + i), "timer", { keep: 12 });
    const list = await listVersions(kv);
    eq("autosave.ring.count", list.length, 8);
    let allOk = true;
    for (const v of list) if ((await readVersion(kv, v.seq))?.text !== text("r" + (v.seq - 1))) allOk = false;
    ok("autosave.ring.texts", allOk);
    eq("autosave.ring.slots", new Set(list.map((v) => v.slot)).size, 8);
  }

  // --- 配额不足：第一次写失败 → 让一半旧版本腾地方，重试成功 ---
  {
    const kv = quotaKv(3);
    for (const t of ["a", "b", "c"]) await pushVersion(kv, rec(t, 1000), "timer", { keep: 5 });
    eq("autosave.quota.full", slots(kv).length, 3);
    const r = await pushVersion(kv, rec("d", 2000), "timer", { keep: 5 });
    eq("autosave.quota.stored", r.stored, true);
    eq("autosave.quota.kept", (await listVersions(kv)).length, 2);
    eq("autosave.quota.newest", (await readVersion(kv, (await listVersions(kv))[0].seq))?.text, text("d"));
    eq("autosave.quota.slots", slots(kv).length, 2);
  }

  // --- 配额不足且腾不出地方（只剩一版时）：stored=false，旧版本原样不动 ---
  {
    const kv = quotaKv(1);
    await pushVersion(kv, rec("a", 1000), "timer", { keep: 5 });
    const before = slots(kv).join(",");
    const r = await pushVersion(kv, rec("b", 2000), "timer", { keep: 5 });
    eq("autosave.quota.fail", r.stored, false);
    eq("autosave.quota.fail-added", r.added, false);
    eq("autosave.quota.fail-count", (await listVersions(kv)).length, 1);
    eq("autosave.quota.untouched", slots(kv).join(","), before);
    eq("autosave.quota.old-intact", (await readVersion(kv, 1))?.text, text("a"));
  }

  // --- 删除某一版 ---
  {
    const kv = memKv();
    for (const t of ["a", "b", "c"]) await pushVersion(kv, rec(t, 1000), "timer", { keep: 5 });
    await dropVersion(kv, 2);
    eq("autosave.drop.count", (await listVersions(kv)).map((v) => v.seq).join(","), "3,1");
    eq("autosave.drop.gone", await readVersion(kv, 2), null);
    eq("autosave.drop.slots", slots(kv).length, 2);
    await dropVersion(kv, 99);   // 不存在：不炸
    eq("autosave.drop.unknown", (await listVersions(kv)).length, 2);
  }

  // --- 坏数据不崩：索引不是对象 / 版本表里混进非法条目 → 当没有历史 ---
  {
    const kv = memKv();
    await kv.put("index", "not an object");
    eq("autosave.corrupt.index", (await listVersions(kv)).length, 0);
    const kv2 = memKv();
    await kv2.put("index", { seq: 2, versions: [{ seq: 1, slot: "x" }] });
    eq("autosave.corrupt.entry", (await listVersions(kv2)).length, 0);
    // 索引在、数据槽位丢了：读出来是 null，但列表仍然可用
    const kv3 = memKv();
    await pushVersion(kv3, rec("a", 1000), "timer", { keep: 5 });
    kv3.map.delete("h1");
    const list = await listVersions(kv3);
    eq("autosave.lostslot.count", list.length, 1);
    eq("autosave.lostslot.read", await readVersion(kv3, 1), null);
  }

  // --- 记录字段的兜底：meta 不全也能存/读（只影响显示） ---
  {
    const kv = memKv();
    const bare: AutosaveRecord = { text: text("bare"), meta: undefined as unknown as AutosaveRecord["meta"] };
    const r = await pushVersion(kv, bare, "timer", { keep: 5 });
    eq("autosave.bare.stored", r.stored, true);
    const v = (await listVersions(kv))[0];
    eq("autosave.bare.bytes", v.bytes > 0, true);
    eq("autosave.bare.name", v.name, "");
    eq("autosave.bare.text", (await readVersion(kv, 1))?.text, text("bare"));
  }
}
