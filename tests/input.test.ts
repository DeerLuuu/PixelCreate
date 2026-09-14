// InputServer（手势策略与算术）的回归 —— src/servers/input.ts。
//
// 这些规则以前散在 render/view.ts 的 onDown / onMove 里，只能靠"DOM 桩 + 合成指针事件"
// 间接覆盖。搬出来之后可以逐条钉死，尤其是两条曾经在真机上反复调过的：
//   · 双指缩放**中点是不动点**（缩的时候两指之间那处画面不能跑）
//   · 四指手势要「至少两根手指各自离开自己的落点」才算划动（晚落/早抬的手指不削弱判定）
import {
  FOUR_MOVE_PX_DEFAULT, TAP_SLOP_PX, fourFingerArmed, longPressAllowed, longPressNeedsDoc,
  modsOf, mouseButtonIntent, outsideDoc, pinchAround, pinchBaseOf, pinchNow, withinTapSlop,
  type PinchBase,
} from "../src/servers/input";
import { screenToPixel } from "../src/servers/viewport";
import { eq, ok } from "./common";

export function testInput(): void {
  // ------------------------------------------------------------ 修饰键
  {
    eq("input.mods.all", modsOf({ shiftKey: true, ctrlKey: true, altKey: true }, true),
      { shift: true, ctrl: true, alt: true, space: true });
    eq("input.mods.none", modsOf({}, false), { shift: false, ctrl: false, alt: false, space: false });
  }

  // ------------------------------------------------- 鼠标按键 → 意图
  {
    eq("input.mouse.left", mouseButtonIntent(0, false), "primary");
    eq("input.mouse.middle", mouseButtonIntent(1, false), "focus-fit");
    eq("input.mouse.right", mouseButtonIntent(2, false), "secondary");
    // 空格按住 + 左键 = 用另一个色槽绘制（PC 上的"背景色绘制"）
    eq("input.mouse.space-left", mouseButtonIntent(0, true), "secondary");
    // 其它键（后退/前进）当主色槽处理，与旧行为一致
    eq("input.mouse.other", mouseButtonIntent(3, false), "primary");
  }

  // ----------------------------------------------------------- 画布内外
  {
    eq("input.outside.inside", outsideDoc({ x: 0, y: 0 }, 32, 32), false);
    eq("input.outside.last-px", outsideDoc({ x: 31, y: 31 }, 32, 32), false);
    eq("input.outside.right-edge", outsideDoc({ x: 32, y: 0 }, 32, 32), true);
    eq("input.outside.bottom-edge", outsideDoc({ x: 0, y: 32 }, 32, 32), true);
    eq("input.outside.negative", outsideDoc({ x: -1, y: 5 }, 32, 32), true);
  }

  // ------------------------------------------------------- 长按策略
  {
    ok("input.long.needs-doc.pick", longPressNeedsDoc("pickColor"));
    ok("input.long.needs-doc.zoom", longPressNeedsDoc("zoomIn") && longPressNeedsDoc("zoomOut"));
    ok("input.long.menu-free", !longPressNeedsDoc("menu"));
    const base = { isPc: false, action: "pickColor", pickAllowed: true, insideDoc: true };
    ok("input.long.ok", longPressAllowed(base));
    ok("input.long.pc-off", !longPressAllowed({ ...base, isPc: true }));
    ok("input.long.outside-off", !longPressAllowed({ ...base, insideDoc: false }));
    ok("input.long.pick-blocked", !longPressAllowed({ ...base, pickAllowed: false }));
    // 不需要看像素的长按动作（例如菜单）不受 pickAllowed 影响
    ok("input.long.menu-anywhere", longPressAllowed({ ...base, action: "menu", pickAllowed: false }));
    // 但一样要在画布内
    ok("input.long.menu-outside", !longPressAllowed({ ...base, action: "menu", insideDoc: false }));
  }

  // ------------------------------------------------- 四指"已划动"判定
  {
    const starts = new Map([[1, { x: 0, y: 0 }], [2, { x: 100, y: 0 }], [3, { x: 200, y: 0 }], [4, { x: 300, y: 0 }]]);
    const at = (id: number, x: number, y = 0): [number, { x: number; y: number }] => [id, { x, y }];
    eq("input.four.none", fourFingerArmed([at(1, 0), at(2, 100)], starts, FOUR_MOVE_PX_DEFAULT), false);
    // 只有一根划动 → 不算（这就是"晚落的手指不削弱判定"的反面：一根不够）
    eq("input.four.one-moving",
      fourFingerArmed([at(1, 40), at(2, 100)], starts, FOUR_MOVE_PX_DEFAULT), false);
    // 两根各自离开自己的落点 → 算
    eq("input.four.two-moving",
      fourFingerArmed([at(1, 40), at(2, 140)], starts, FOUR_MOVE_PX_DEFAULT), true);
    // 方向不限：一上一下也算
    eq("input.four.any-direction",
      fourFingerArmed([at(1, 0, -40), at(2, 100, 40)], starts, FOUR_MOVE_PX_DEFAULT), true);
    // 阈值是严格大于：正好等于阈值不算，差一点点算
    eq("input.four.exactly-threshold",
      fourFingerArmed([at(1, 15), at(2, 115)], starts, 15), false);
    eq("input.four.just-over",
      fourFingerArmed([at(1, 15.5), at(2, 115.5)], starts, 15), true);
    // 没有落点记录的手指（理论上不该有）被忽略，不会误判
    eq("input.four.no-start", fourFingerArmed([[99, { x: 500, y: 500 }]], starts, 15), false);
  }

  // ------------------------------------------------------- 点击容差
  {
    ok("input.tap.inside", withinTapSlop({ x: 0, y: 0 }, { x: TAP_SLOP_PX, y: 0 }));
    ok("input.tap.outside", !withinTapSlop({ x: 0, y: 0 }, { x: TAP_SLOP_PX + 1, y: 0 }));
    ok("input.tap.diagonal", !withinTapSlop({ x: 0, y: 0 }, { x: TAP_SLOP_PX, y: TAP_SLOP_PX }));
    ok("input.tap.custom-slop", withinTapSlop({ x: 0, y: 0 }, { x: 30, y: 0 }, 40));
  }

  // --------------------------------------------------------------- pinch
  {
    const n = pinchNow({ x: 100, y: 200 }, { x: 140, y: 200 });
    eq("input.pinch.mid", [n.mx, n.my], [120, 200]);
    eq("input.pinch.dist", n.dist, 40);
    // 两指重叠：距离下限 1，避免后面除零
    eq("input.pinch.coincident", pinchNow({ x: 5, y: 5 }, { x: 5, y: 5 }).dist, 1);

    const base = pinchBaseOf({ x: 100, y: 200 }, { x: 140, y: 200 }, { zoom: 8, ox: 10, oy: 20 });
    eq("input.pinchbase.frozen", [base.zoom, base.ox, base.oy, base.mx, base.my, base.dist], [8, 10, 20, 120, 200, 40]);

    // 不动 → 视图完全不变，且不算"缩放过了"
    const same = pinchAround(base, pinchNow({ x: 100, y: 200 }, { x: 140, y: 200 }), 0.25, 64);
    eq("input.pinch.identity", [same.zoom, same.ox, same.oy, same.zoomed], [8, 10, 20, false]);

    // 距离翻倍 → 缩放 ×2，**中点那处画面不动**
    const zoomed = pinchAround(base, pinchNow({ x: 80, y: 200 }, { x: 160, y: 200 }), 0.25, 64);
    eq("input.pinch.double", [zoomed.zoom, zoomed.zoomed], [16, true]);
    const before = screenToPixel({ zoom: base.zoom, ox: base.ox, oy: base.oy }, base.mx, base.my);
    const after = screenToPixel({ zoom: zoomed.zoom, ox: zoomed.ox, oy: zoomed.oy }, base.mx, base.my);
    eq("input.pinch.anchor-fixed", [after.x, after.y], [before.x, before.y]);
    // 中点自己也在动的时候（手指整体平移）仍然以中点为锚
    const moved = pinchAround(base, pinchNow({ x: 180, y: 300 }, { x: 260, y: 300 }), 0.25, 64);
    const b2 = screenToPixel({ zoom: base.zoom, ox: base.ox, oy: base.oy }, base.mx, base.my);
    const a2 = screenToPixel({ zoom: moved.zoom, ox: moved.ox, oy: moved.oy }, 220, 300);
    eq("input.pinch.mid-moved", [a2.x, a2.y], [b2.x, b2.y]);

    // 夹到上限 / 下限：仍然按中点解算（不是"先夹后按原比例"）
    const capped = pinchAround(base, pinchNow({ x: 20, y: 200 }, { x: 220, y: 200 }), 0.25, 12);
    eq("input.pinch.clamp-max", capped.zoom, 12);
    const floor = pinchAround(base, pinchNow({ x: 115, y: 200 }, { x: 125, y: 200 }), 6, 64);
    eq("input.pinch.clamp-min", floor.zoom, 6);
    ok("input.pinch.clamp-zoomed", capped.zoomed && floor.zoomed);

    // 阈值口径（**与搬家前逐字一致，没动**）：zoom 的相对变化 > 0.001 才算"缩放过了"。
    // 注意这是绝对值阈值，所以在 zoom=8 时 0.01px 的两指距离抖动就会置位 ——
    // 「双指双击 = 重做」用的就是这个标志，真机上如果发现重做不好触发，
    // 要改的是这个阈值口径（例如改成相对比例或屏幕像素阈值），别在别处兜。
    const tiny = pinchAround(base, pinchNow({ x: 100, y: 200 }, { x: 140.01, y: 200 }), 0.25, 64);
    ok("input.pinch.eps.tiny-sets-flag", tiny.zoomed);
    const exact = pinchAround(base, pinchNow({ x: 100, y: 200 }, { x: 140, y: 200 }), 0.25, 64);
    ok("input.pinch.eps.identical-clears", !exact.zoomed);
    // 距离与中点都不变 → 缩放/平移一个比特都不许动
    const still = pinchAround(base, pinchNow({ x: 100, y: 200 }, { x: 140, y: 200 }), 0.25, 64);
    eq("input.pinch.no-drift", [still.ox, still.oy, still.zoom], [10, 20, 8]);
    // 中点整体移动（两指一起平移）＝同时平移视图：ox/oy 跟着中点走，缩放不变
    const twoPan = pinchAround(base, pinchNow({ x: 110, y: 210 }, { x: 150, y: 210 }), 0.25, 64);
    eq("input.pinch.two-finger-pan", [twoPan.ox, twoPan.oy, twoPan.zoom], [20, 30, 8]);
  }
}
