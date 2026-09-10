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
 * May a long press still fire its hold action? Pure and unit tested.
 *
 * The toolbar colour chip opens its quick colour wheel on a hold, while moving
 * the finger turns the same press into a fill drag. A hold is therefore refused
 * when the finger has travelled past the drag threshold (`moved`) or has left
 * the control (`inside = false`) — i.e. once the gesture is no longer a hold it
 * must not pop the wheel open from outside the button. The palette fan has no
 * hold action at all, so it never asks.
 */
export function holdAllowed(moved: number, elapsed: number, holdMs: number, inside = true, threshold = DRAG_START): boolean {
  if (elapsed < holdMs) return false;   // not due yet
  if (!inside) return false;            // the finger left the control
  return moved < threshold;             // moving means dragging, not holding
}

export interface RectBox { left: number; top: number; right: number; bottom: number }

/**
 * True when a point has left `rect` by more than `tol` px. A long press whose
 * finger wanders off its control must NOT fire its hold action any more (the
 * toolbar chip would otherwise open the quick colour wheel from outside the
 * button, which reads as "the drag opened the wheel"). A small tolerance keeps
 * an ordinary hold with a shaky finger working.
 */
export function leftRect(rect: RectBox, x: number, y: number, tol = 4): boolean {
  return x < rect.left - tol || x > rect.right + tol || y < rect.top - tol || y > rect.bottom + tol;
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
  /** true while the CALLER's own hold action owns the gesture (its quick wheel
   *  is open): the drag must not start then. Omit when there is no hold action. */
  holdActive?: () => boolean;
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
      if (opts.holdActive?.()) return false;   // the wheel owns the gesture
      if (Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < DRAG_START) return false;
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
