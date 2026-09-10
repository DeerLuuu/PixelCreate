// Drag a colour out of the palette fan, or off the toolbar colour chip, and drop
// it on a canvas: the point is bucket-filled with that colour.
//
// Shared by PalBalls (src/ui/App.tsx) and ColorHoldChip (src/ui/hold.tsx) so the
// threshold, the floating ball, the feedback and the fill call exist once. The
// actual painting is View.quickFill / Session.quickFill (see docs/API.md §18.7b).
import React, { useRef, useState } from "react";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import * as bridge from "../io/bridge";
import { showTip, hideTip } from "./tooltip";
import { chipCss } from "../engine/color";
import type { RGBA } from "../engine/types";

/** screen px of travel before a press counts as a drag (below: still a tap) */
export const DRAG_START = 8;
/** long-press delay before the hint appears (same as Btn's tooltip) */
export const TIP_MS = 450;

/**
 * What a press on a colour control means once it has been held for `elapsed` ms
 * having travelled `moved` px. Pure and unit tested — the toolbar chip opens its
 * quick colour wheel on a HOLD, so there only a move made BEFORE the hold fires
 * may turn into a fill drag.
 *
 * `holdMs = Infinity` = the control has no hold action (the palette fan), where
 * any movement past the threshold is a drag.
 */
export function gestureIntent(moved: number, elapsed: number, holdMs: number, threshold = DRAG_START): "hold" | "drag" | "pending" {
  if (elapsed >= holdMs) return "hold";    // the long-press action owns the gesture
  if (moved >= threshold) return "drag";   // moved early enough: fill gesture
  return "pending";
}

export interface ColorDragApi {
  /** the floating ball while dragging (render anywhere: it is position:fixed) */
  ghost: React.ReactNode;
  /** true while a fill drag is in progress */
  dragging: boolean;
  /** call from onPointerDown */
  begin: (ev: React.PointerEvent, color?: RGBA) => void;
  /** call from onPointerMove; true = this gesture is a drag */
  move: (ev: React.PointerEvent) => boolean;
  /** call from onPointerUp; true = it was a drag (skip the tap action) */
  end: (ev: React.PointerEvent) => boolean;
  /** call from onPointerCancel / lost capture */
  cancel: () => void;
}

export function useColorDragFill(opts: {
  /** colour used when begin() is called without one (e.g. the active FG/BG) */
  color: () => RGBA;
  /** long-press hint for the colour being dragged (omit where a hold does
   *  something else — the toolbar chip opens its quick wheel on a hold) */
  tip?: (c: RGBA) => { title: string; desc?: string };
  /** long-press delay of the CALLER's own hold action (see gestureIntent) */
  holdMs?: number;
  /** after a successful fill (e.g. close the palette fan) */
  onFilled?: (canvasIndex: number) => void;
}): ColorDragApi {
  const drag = useRef<{ id: number; sx: number; sy: number; t0: number; c: RGBA; moved: boolean } | null>(null);
  const tipT = useRef<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number; c: RGBA } | null>(null);
  const stopTip = () => {
    if (tipT.current !== null) { window.clearTimeout(tipT.current); tipT.current = null; }
    hideTip();
  };
  const begin = (ev: React.PointerEvent, color?: RGBA) => {
    stopTip();
    const c = color ?? opts.color();
    drag.current = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, t0: Date.now(), c, moved: false };
    if (opts.tip) {
      const info = opts.tip(c);
      tipT.current = window.setTimeout(() => {
        tipT.current = null;
        showTip({ title: info.title, desc: info.desc });
      }, TIP_MS);
    }
  };
  const move = (ev: React.PointerEvent): boolean => {
    const d = drag.current;
    if (!d || d.id !== ev.pointerId) return false;
    if (!d.moved) {
      const travel = Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy);
      const holdMs = opts.holdMs ?? Number.POSITIVE_INFINITY;
      if (gestureIntent(travel, Date.now() - d.t0, holdMs) !== "drag") return false;
      d.moved = true;
      stopTip();
    }
    setPos({ x: ev.clientX, y: ev.clientY, c: d.c });
    return true;
  };
  const finish = (ev: React.PointerEvent): boolean => {
    const d = drag.current;
    drag.current = null;
    stopTip();
    setPos(null);
    if (!d || !d.moved) return false;
    const col: RGBA = [d.c[0], d.c[1], d.c[2], 255];
    const hit = SESSION.quickFill(ev.clientX, ev.clientY, col);
    const t = makeT(SESSION.prefs.lang as Lang);
    if (hit >= 0) {
      SESSION.hapticTick("quick-fill", 0.9);
      bridge.toast(t("palDropFill"));
      opts.onFilled?.(hit);
    } else {
      bridge.toast(t("palDropMiss"));
    }
    return true;
  };
  const cancel = () => {
    drag.current = null;
    stopTip();
    setPos(null);
  };
  const ghost = pos
    ? <div className="pal-drag" style={{ left: pos.x, top: pos.y, background: chipCss(pos.c) }} />
    : null;
  return { ghost, dragging: !!pos, begin, move, end: finish, cancel };
}
