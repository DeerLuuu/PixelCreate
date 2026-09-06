// Global long-press tooltip: one host renders at the bottom-centre of the
// screen; any control (buttons, floating orbs, radial items, draggables) can
// show a {title, desc} bubble by holding still ~450ms.
export interface Tip {
  title: string;
  desc?: string;
}

let current: Tip | null = null;
let hideTimer: number | null = null;
const subs = new Set<(t: Tip | null) => void>();

export function showTip(tip: Tip, autoHideMs = 0): void {
  current = tip;
  if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
  if (autoHideMs > 0) hideTimer = window.setTimeout(() => { current = null; emit(); }, autoHideMs);
  emit();
}

export function hideTip(): void {
  if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
  if (current) { current = null; emit(); }
}

function emit(): void {
  for (const f of subs) { try { f(current); } catch { /* ignore */ } }
}

export function subscribeTip(fn: (t: Tip | null) => void): () => void {
  subs.add(fn);
  fn(current);
  return () => { subs.delete(fn); };
}
