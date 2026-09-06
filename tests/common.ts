/** Minimal shared test helpers (no DOM / no node types required). */
export let fails = 0;

export function eq(name: string, a: unknown, b: unknown): void {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) {
    fails++;
    console.log("FAIL " + name + "\n  got: " + JSON.stringify(a) + "\n  want: " + JSON.stringify(b));
  } else {
    console.log("ok  " + name);
  }
}

export function ok(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    fails++;
    console.log("FAIL " + name + (detail ? "  " + detail : ""));
  } else {
    console.log("ok  " + name);
  }
}

export function finish(): void {
  if (fails > 0) throw new Error(fails + " failure(s)");
  console.log("ALL PASS");
}