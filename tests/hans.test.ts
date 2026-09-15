// 文案语言检查：仓库里的中文一律**简体**。
//
// 用户明确要求过「请使用简体中文回答我」——这条先是给代理的交互约定（AGENTS.md §10.4），
// 其次才是仓库文本的要求。这个测试静态扫描源码/文档/脚本里的中文，发现**繁体专用字**就红：
// 混进注释、文档或更新日志的繁体字既不统一，也会让用户觉得「这不是写给我的」。
//
// 表里只放**只在繁体里出现**的字（简体写法不同）。两体同形的字（件 / 置 / 存 / 息 / 硬 / 幕 / 鼠 …）
// 一律不进表，否则全是误报。
import { eq, ok } from "./common";

declare const require: (m: string) => any;
declare const __dirname: string;
const fs = require("fs");
const path = require("path");

const TRADITIONAL = "這時們個為說會來對開關實現產樣種麼幾覺單雙邊間題變寫圖從讀儲節數據網體讓銀檔資後應於過還進點與樂學國語詞誤調認標準總結給線編終統經驗續絕聲聯聽職腦臉舊舉藝處號裝見觀規視計討記註許設訪訊試話詳誌請誰課談論講謝議護豐貝負財責貴買費貼質車較載輸轉輕軟適選遺鄰醫釋鐘鐵長門閉問聞陽隨隱難頁順預領頭願類風飛飯館馬驗髮鬥魚鳥麗黃齊齒龍寬簡內熒盤鍵網絡頻絡訊號碼視標";
const CHARS = [...new Set([...TRADITIONAL])];

/** 只看受版本管理的文本：产物目录、依赖、临时目录都跳过 */
const SKIP_DIR = new Set(["node_modules", ".git", ".ts-out", "js", "css", "icons", "build", "_scratch", "toolchain", "img"]);
const EXTS = /\.(md|ts|tsx|css|html|json|sh|java|xml|mjs|cjs)$/;
/** 这个文件自己就写着繁体字表，跳过 */
const SELF = "hans.test.ts";
/**
 * 行内豁免标记：只在**必须举出繁体字形**的地方用（例如 AGENTS.md §10.4 说明"这些繁体字不要写"）。
 * 别的场合不许拿它当挡箭牌 —— 真需要豁免说明理由。
 */
const ALLOW = "zh-hans-allow";

export function testHans(): void {
  const root = path.resolve(__dirname, "../../..");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!EXTS.test(e.name) || e.name === SELF) continue;
      files.push(p);
    }
  };
  walk(root);
  ok("hans.scanned", files.length > 80, "files=" + files.length);

  const bad: string[] = [];
  for (const f of files) {
    const rel = path.relative(root, f).replace(/\\/g, "/");
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((ln, i) => {
      if (ln.includes(ALLOW)) return;
      const hit = CHARS.filter((c) => ln.includes(c));
      if (hit.length) bad.push(rel + ":" + (i + 1) + " [" + hit.join("") + "]");
    });
  }
  // 只报前几条，够定位就行
  eq("hans.no-traditional", bad.slice(0, 8), []);
  ok("hans.clean", bad.length === 0, "共 " + bad.length + " 处");
}
