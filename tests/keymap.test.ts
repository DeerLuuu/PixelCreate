// Custom keyboard shortcuts: chord normalisation, conflict handling and the
// effect on the dispatcher (src/app/keymap.ts + app/shortcuts.ts).
import {
  PIE_DEFAULT, REBINDABLE, actionForChord, bindChord, chordForAction, chordLabel, chordOf,
  defaultChordOf, isOverridden, overrides, unbindChord,
} from "../src/app/keymap";
import { SHORTCUT_SHEET, shortcutFor } from "../src/app/shortcuts";
import { eq, ok } from "./common";

export function testKeymap(): void {
  // ---- chord normalisation ----
  eq("keymap.chord.plain", chordOf({ key: "z" }), "z");
  eq("keymap.chord.uppercase", chordOf({ key: "Z", shiftKey: true }), "shift+z");
  eq("keymap.chord.ctrl", chordOf({ key: "z", ctrlKey: true }), "ctrl+z");
  eq("keymap.chord.ctrl-shift", chordOf({ key: "Z", ctrlKey: true, shiftKey: true }), "ctrl+shift+z");
  eq("keymap.chord.alt", chordOf({ key: "v", ctrlKey: true, altKey: true }), "ctrl+alt+v");
  eq("keymap.chord.meta-is-ctrl", chordOf({ key: "s", metaKey: true }), "ctrl+s");
  eq("keymap.chord.arrow", chordOf({ key: "ArrowLeft", ctrlKey: true }), "ctrl+arrowleft");
  eq("keymap.chord.space", chordOf({ key: " " }), "space");
  eq("keymap.chord.f1", chordOf({ key: "F1", ctrlKey: true }), "ctrl+f1");
  eq("keymap.chord.plus", chordOf({ key: "+" }), "=");
  eq("keymap.chord.modifier-only", chordOf({ key: "Shift", shiftKey: true }), null);
  eq("keymap.chord.empty", chordOf({ key: "" }), null);

  // ---- labels ----
  eq("keymap.label.ctrl", chordLabel("ctrl+shift+z"), "Ctrl+Shift+Z");
  eq("keymap.label.arrow", chordLabel("ctrl+arrowleft"), "Ctrl+\u2190");
  eq("keymap.label.f", chordLabel("f"), "F");
  eq("keymap.label.delete", chordLabel("delete"), "Delete");
  eq("keymap.label.f1", chordLabel("ctrl+f1"), "Ctrl+F1");
  eq("keymap.label.empty", chordLabel(""), "");

  // ---- defaults come from the cheat sheet, so the panel never invents one ----
  eq("keymap.default.save", defaultChordOf("save"), "ctrl+s");
  eq("keymap.default.paste", defaultChordOf("paste"), "ctrl+v");
  eq("keymap.default.pasteLayer", defaultChordOf("pasteLayer"), "ctrl+shift+v");
  eq("keymap.default.hide", defaultChordOf("toggleUI"), "tab");
  eq("keymap.default.delete", defaultChordOf("delete"), "delete");
  eq("keymap.default.pie", defaultChordOf("pieLaunch"), PIE_DEFAULT);
  eq("keymap.default.tool-has-none", defaultChordOf("tool"), "b");     // sheet 里那一行是 B 的代表
  eq("keymap.default.unknown", defaultChordOf("nope"), null);

  // every rebindable action must have a default (otherwise the panel shows blank)
  for (const a of REBINDABLE) ok("keymap.rebindable-default." + a, !!defaultChordOf(a), a);
  // and every sheet row that advertises an action must be rebindable or a tool
  for (const g of SHORTCUT_SHEET) {
    for (const it of g.items) {
      if (!it.action || it.action === "tool" || it.action === "nudge") continue;
      ok("keymap.sheet-rebindable." + it.action, REBINDABLE.indexOf(it.action) >= 0, it.action);
    }
  }

  // ---- binding / conflicts ----
  {
    const r1 = bindChord("save", "ctrl+p", {});
    ok("keymap.bind.ok", r1.ok === true);
    const km = r1.ok ? r1.keymap : {};
    eq("keymap.bind.value", km.save, "ctrl+p");
    eq("keymap.bind.effective", chordForAction("save", km), "ctrl+p");
    ok("keymap.bind.overridden", isOverridden("save", km));
    // the chord it stole from nothing is free; the freed default is no longer save
    eq("keymap.bind.owner", actionForChord("ctrl+p", km), "save");
    eq("keymap.bind.default-freed", actionForChord("ctrl+s", km), null);
    // stealing another action's chord is refused
    const r2 = bindChord("redo", "ctrl+p", km);
    ok("keymap.bind.clash", r2.ok === false && (r2.ok === false ? r2.clash : "") === "save");
    // rebinding to its own default just clears the override
    const r3 = bindChord("save", "ctrl+s", km);
    ok("keymap.bind.back-to-default", r3.ok === true && overrides(r3.ok ? r3.keymap : {}).length === 0);
    // unknown / non-rebindable actions are refused
    ok("keymap.bind.unknown", bindChord("nope", "ctrl+p", {}).ok === false);
    ok("keymap.bind.tool-refused", bindChord("tool", "ctrl+p", {}).ok === false);
    // unbind restores the default
    const back = unbindChord("save", km);
    eq("keymap.unbind", [chordForAction("save", back), isOverridden("save", back)], ["ctrl+s", false]);
    // overrides() lists what is customised, sorted
    eq("keymap.overrides", overrides({ undo: "ctrl+u", save: "ctrl+p" }),
      [{ action: "save", chord: "ctrl+p" }, { action: "undo", chord: "ctrl+u" }]);
  }

  // ---- the dispatcher honours the map ----
  {
    const km = { save: "ctrl+p", undo: "ctrl+u" };
    eq("keymap.dispatch.new-chord", shortcutFor({ key: "p", ctrlKey: true }, false, km)?.action, "save");
    eq("keymap.dispatch.old-chord-dead", shortcutFor({ key: "s", ctrlKey: true }, false, km), null);
    eq("keymap.dispatch.other-action", shortcutFor({ key: "u", ctrlKey: true }, false, km)?.action, "undo");
    eq("keymap.dispatch.untouched", shortcutFor({ key: "c", ctrlKey: true }, false, km)?.action, "copy");
    // a rebound plain key stops acting as its default and never fires while typing
    const km2 = { toggleUI: "ctrl+alt+u" };
    eq("keymap.dispatch.tab-freed", shortcutFor({ key: "Tab" }, false, km2), null);
    eq("keymap.dispatch.tab-not-typing", shortcutFor({ key: "Tab" }, true, km2), null);
    eq("keymap.dispatch.new-plain", shortcutFor({ key: "u", ctrlKey: true, altKey: true }, false, km2)?.action, "toggleUI");
    // an empty map behaves exactly like the built-in mapping
    for (const probe of [{ key: "z", ctrlKey: true }, { key: "v", ctrlKey: true }, { key: "x" }, { key: "Delete" }]) {
      eq("keymap.dispatch.empty." + JSON.stringify(probe),
        shortcutFor(probe, false, {})?.action, shortcutFor(probe, false)?.action);
    }
  }
}
