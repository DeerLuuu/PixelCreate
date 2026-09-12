/** Minimal shared test helpers (no DOM / no node types required). */
export let fails = 0;

/** assertions that ran (eq + ok). Printed by finish(), so the docs can quote a
 *  number that is actually reproducible instead of a hand-counted one. */
export let total = 0;

export function eq(name: string, a: unknown, b: unknown): void {
  total++;
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) {
    fails++;
    console.log("FAIL " + name + "\n  got: " + JSON.stringify(a) + "\n  want: " + JSON.stringify(b));
  } else {
    console.log("ok  " + name);
  }
}

export function ok(name: string, cond: boolean, detail = ""): void {
  total++;
  if (!cond) {
    fails++;
    console.log("FAIL " + name + (detail ? "  " + detail : ""));
  } else {
    console.log("ok  " + name);
  }
}

export function finish(): void {
  if (fails > 0) throw new Error(fails + " failure(s)");
  console.log("assertions: " + total);
  console.log("ALL PASS");
}
