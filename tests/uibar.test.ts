// Editable UI: bar/orb ordering + hiding and the layout toggles
// (src/app/uibar.ts + the Session wrappers).
import {
  CBAR_ACTIONS, DEFAULT_LAYOUT, LAYOUT_KEYS, ORB_IDS, TOPBAR_ACTIONS,
  dropIndexAt, fullOrder, isDefaultLayout, moveId, nearestSlotIndex, normalizeLayout, orderedActions,
  stepsBetween, toggleHidden, visibleCount,
} from "../src/app/uibar";
import { Session } from "../src/app/session";
import { eq, ok } from "./common";

export function testUibar(): void {
  // ---- registries are complete and free of duplicates ----
  for (const [name, list] of [["top", TOPBAR_ACTIONS], ["cbar", CBAR_ACTIONS]] as const) {
    const ids = list.map((a) => a.id);
    eq("uibar." + name + ".unique-ids", ids.length, new Set(ids).size);
    ok("uibar." + name + ".nonempty", ids.length >= 4, name + "=" + ids.length);
    // every entry needs an icon or a text label, plus an i18n label key
    for (const a of list) {
      ok("uibar." + name + ".label." + a.id, !!a.label);
      ok("uibar." + name + ".glyph." + a.id, !!a.icon || a.id === "colors" || a.id === "swap" || a.id === "symmetry");
    }
    // the anchors the onboarding tour uses must survive customisation
    ok("uibar." + name + ".guides", list.every((a) => !!a.guide), name);
  }
  eq("uibar.orbs", ORB_IDS.length, 5);
  eq("uibar.layout.keys", LAYOUT_KEYS.length, 6);

  // ---- layout normalisation ----
  eq("uibar.layout.default", normalizeLayout(undefined), DEFAULT_LAYOUT);
  eq("uibar.layout.partial", normalizeLayout({ top: false }), { ...DEFAULT_LAYOUT, top: false });
  eq("uibar.layout.junk", normalizeLayout("nope"), DEFAULT_LAYOUT);
  eq("uibar.layout.typed", normalizeLayout({ top: 0, bar: "yes" }), DEFAULT_LAYOUT);
  ok("uibar.layout.is-default", isDefaultLayout({ ...DEFAULT_LAYOUT }));
  ok("uibar.layout.not-default", !isDefaultLayout({ ...DEFAULT_LAYOUT, orbs: false }));

  // ---- ordering / hiding ----
  {
    const all = TOPBAR_ACTIONS;
    eq("uibar.order.registry", orderedActions(all).map((a) => a.id), all.map((a) => a.id));
    // explicit order wins; ids missing from it are appended in registry order
    eq("uibar.order.custom", orderedActions(all, ["save", "undo"]).map((a) => a.id),
      ["save", "undo", ...all.map((a) => a.id).filter((id) => id !== "save" && id !== "undo")]);
    // hidden ids disappear but keep their slot in the order
    const order = fullOrder(all, ["save", "undo", "menu"]);
    eq("uibar.full-order", order, ["save", "undo", "menu", ...all.map((a) => a.id).filter((id) => !["save", "undo", "menu"].includes(id))]);
    eq("uibar.order.hidden", orderedActions(all, order, ["undo"]).map((a) => a.id).indexOf("undo"), -1);
    // unknown ids in the stored order are ignored, new registry entries still show
    eq("uibar.order.unknown", orderedActions(all, ["ghost", "save"]).length, all.length);
    // a stale order cannot drop an action
    eq("uibar.order.never-loses", orderedActions(all, ["save"], []).length, all.length);
    // moving respects hidden neighbours (moves inside the FULL list)
    eq("uibar.move.up", moveId(all, order, "menu", -1), ["save", "menu", "undo", ...order.filter((id) => !["save", "menu", "undo"].includes(id))]);
    eq("uibar.move.clamp-top", moveId(all, order, "save", -5)[0], "save");
    eq("uibar.move.clamp-bottom", moveId(all, order, order[order.length - 1], 5).pop(), order[order.length - 1]);
    eq("uibar.move.unknown", moveId(all, order, "ghost", 1), order);
    // hidden list toggling
    eq("uibar.hidden.on", toggleHidden([], "undo"), ["undo"]);
    eq("uibar.hidden.off", toggleHidden(["undo", "save"], "undo"), ["save"]);
    eq("uibar.visible-count", visibleCount(all, ["undo", "save"]), all.length - 2);
  }

  // ---- 动作注册表 + 互搬 + 位置 ----
  {
    const s = new Session();
    const ran: string[] = [];
    s.registerActions({
      "fx.glow": { icon: "i-star", label: "Glow", run: () => { ran.push("glow"); } },
      "sel.invert": { icon: "i-sel-invert", label: "Invert", run: () => { ran.push("invert"); } },
    });
    eq("uibar.registry.find", s.actionById("fx.glow")?.label, "Glow");
    eq("uibar.registry.missing", s.actionById("nope"), null);
    s.actionById("fx.glow")?.run();
    eq("uibar.registry.run", ran, ["glow"]);
    // 浮动球 → 工具栏（同时把它从原球里隐藏）
    s.registerOrbCatalog("fx", [{ id: "fx.glow", label: "Glow" }]);
    s.moveActionToBar("top", "fx.glow", "fx");
    eq("uibar.move.to-bar", s.barExtras("top"), ["fx.glow"]);
    eq("uibar.move.hidden-in-orb", s.isOrbItemHidden("fx", "fx.glow"), true);
    eq("uibar.move.orb-item-gone", s.orbItems([{ id: "fx.glow" }, { id: "fx.gray" }], "fx").map((i) => i.id), ["fx.gray"]);
    // 重复搬运不会加两条
    s.moveActionToBar("top", "fx.glow", "fx");
    eq("uibar.move.idempotent", s.barExtras("top"), ["fx.glow"]);
    // 注册表里没有的 id 不显示
    s.moveActionToBar("top", "ghost");
    eq("uibar.move.unknown-hidden", s.barExtras("top"), ["fx.glow"]);
    s.removeBarExtra("top", "fx.glow");
    eq("uibar.move.bar-removed", s.barExtras("top"), []);
    // 工具栏 → 浮动球（同时从工具栏移除）
    s.moveActionToBar("bar", "sel.invert");
    s.moveActionToOrb("sel", "sel.invert", "bar");
    eq("uibar.move.to-orb", s.orbExtras("sel"), ["sel.invert"]);
    eq("uibar.move.bar-cleared", s.barExtras("bar"), []);
    s.removeOrbExtra("sel", "sel.invert");
    eq("uibar.move.orb-removed", s.orbExtras("sel"), []);
    // 位置：可设可清
    s.setDockPos({ x: 40, y: 90 });
    s.setPieSlotPos({ x: 200, y: 300 });
    eq("uibar.pos.set", [s.prefs.dockPos, s.prefs.pieSlotPos], [{ x: 40, y: 90 }, { x: 200, y: 300 }]);
    s.resetAllUi();
    eq("uibar.pos.reset", [s.prefs.dockPos, s.prefs.pieSlotPos], [null, null]);
    eq("uibar.reset.extras", [s.prefs.barExtra, s.prefs.orbExtra], [{}, {}]);
  }

  // ---- 直接拖动：落点判定（栏内按坐标、圆环按最近槽位）----
  {
    const centers = [10, 50, 90, 130];
    eq("uibar.drop.left-edge", dropIndexAt(centers, 0), 0);
    eq("uibar.drop.mid", dropIndexAt(centers, 88), 2);
    eq("uibar.drop.right-edge", dropIndexAt(centers, 999), 3);
    eq("uibar.drop.between", dropIndexAt(centers, 69), 1);
    eq("uibar.drop.empty", dropIndexAt([], 5), -1);
    // 圆环：0 号在正上方，顺时针
    eq("uibar.ring.top", nearestSlotIndex(100, 0, 100, 100, 4), 0);
    eq("uibar.ring.right", nearestSlotIndex(200, 100, 100, 100, 4), 1);
    eq("uibar.ring.bottom", nearestSlotIndex(100, 200, 100, 100, 4), 2);
    eq("uibar.ring.left", nearestSlotIndex(0, 100, 100, 100, 4), 3);
    eq("uibar.ring.none", nearestSlotIndex(0, 0, 0, 0, 0), -1);
    eq("uibar.ring.near-top-of-8", nearestSlotIndex(100, -50, 100, 100, 8), 0);
    eq("uibar.steps", [stepsBetween(0, 2), stepsBetween(3, 1)], [2, -2]);
  }

  // ---- Session wrappers persist and refuse to hide everything ----
  {
    const s = new Session();
    eq("uibar.session.default-layout", s.layoutOn("top"), true);
    s.setLayout("top", false);
    eq("uibar.session.layout-off", s.layoutOn("top"), false);
    s.resetLayout();
    eq("uibar.session.layout-reset", isDefaultLayout(s.prefs.layout), true);

    // bar: reorder + hide + reset
    s.resetBar(CBAR_ACTIONS);
    eq("uibar.session.bar-default", s.barActions(CBAR_ACTIONS).map((a) => a.id), CBAR_ACTIONS.map((a) => a.id));
    s.moveBarAction(CBAR_ACTIONS, CBAR_ACTIONS[1].id, -1);
    eq("uibar.session.bar-moved", s.barActions(CBAR_ACTIONS).map((a) => a.id)[0], CBAR_ACTIONS[1].id);
    ok("uibar.session.bar-hide", s.toggleBarAction(CBAR_ACTIONS, "adjust"));
    eq("uibar.session.bar-hidden", s.isBarHidden("adjust"), true);
    eq("uibar.session.bar-visible", s.barActions(CBAR_ACTIONS).some((a) => a.id === "adjust"), false);
    s.toggleBarAction(CBAR_ACTIONS, "adjust");
    eq("uibar.session.bar-shown-again", s.barActions(CBAR_ACTIONS).some((a) => a.id === "adjust"), true);
    // 至少留一个
    for (const a of CBAR_ACTIONS.slice(1)) s.toggleBarAction(CBAR_ACTIONS, a.id);
    eq("uibar.session.last-one-guard", s.toggleBarAction(CBAR_ACTIONS, CBAR_ACTIONS[0].id), false);
    eq("uibar.session.one-left", visibleCount(CBAR_ACTIONS, s.prefs.barHidden), 1);
    s.resetBar(CBAR_ACTIONS);
    eq("uibar.session.bar-reset", [s.prefs.barHidden.length, s.prefs.barOrder.length], [0, CBAR_ACTIONS.length]);

    // orbs: the catalog comes from the app, the order/hidden prefs from the user
    const orbItems = [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }];
    s.registerOrbCatalog("main", orbItems.map((i) => ({ id: i.id, label: i.label })));
    eq("uibar.session.orb-catalog", s.orbCatalogOf("main").map((i) => i.id), ["a", "b", "c"]);
    eq("uibar.session.orb-default", s.orbItems(orbItems, "main").map((i) => i.id), ["a", "b", "c"]);
    s.moveOrbItem(orbItems, "main", "c", -1);
    eq("uibar.session.orb-moved", s.orbItems(orbItems, "main").map((i) => i.id), ["a", "c", "b"]);
    s.toggleOrbItem(orbItems, "main", "c");
    eq("uibar.session.orb-hidden", s.orbItems(orbItems, "main").map((i) => i.id), ["a", "b"]);
    eq("uibar.session.orb-per-ball", s.orbPref("sel").hidden, []);
    s.resetOrb("main");
    eq("uibar.session.orb-reset", s.prefs.orbPrefs, {});
    // 全部恢复默认
    s.setLayout("orbs", false);
    s.toggleBarAction(TOPBAR_ACTIONS, "undo");
    s.toggleOrbItem(orbItems, "main", "a");
    s.resetAllUi();
    eq("uibar.session.reset-all", [isDefaultLayout(s.prefs.layout), s.prefs.barHidden.length, Object.keys(s.prefs.orbPrefs).length], [true, 0, 0]);
  }
}
