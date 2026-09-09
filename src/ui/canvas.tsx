// Multi-canvas layer: a game-style title bar above every canvas in the space.
//
// The canvases themselves are painted by View (which owns pan/zoom); these DOM
// bars are positioned from the same view transform so they stay glued to their
// canvas. Dragging a bar moves that canvas (and everything snapped to it)
// inside the infinite space, tapping it focuses that canvas.
import { useRef } from "react";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import { useSession, Icon } from "./base";
import { showTip, hideTip } from "./tooltip";
import type { Lang } from "./i18n";
import type { View } from "../render/view";

/** fallback magnetic range in screen px (Settings -> Canvas -> snap range) */
const SNAP_SCREEN_PX = 14;

export function CanvasTitles({ view, tick }: { view: View | null; tick: number }) {
  void tick; // re-render on view changes (pan / zoom / resize)
  useSession(); // and whenever the canvases themselves change
  const t = makeT(SESSION.prefs.lang as Lang);
  const drag = useRef<{ i: number; x: number; y: number; x0: number; y0: number; moved: boolean; hit: number | null; locked: boolean; warned: boolean } | null>(null);
  /** the snap target we already flashed for this drag (feedback once per engage) */
  const pulsed = useRef<number | null>(null);
  /** last tap on a title bar, for the double-tap "zoom to this canvas" */
  const lastTap = useRef<{ i: number; t: number } | null>(null);
  const tipT = useRef<number | null>(null);
  const stopTip = () => {
    if (tipT.current !== null) { window.clearTimeout(tipT.current); tipT.current = null; }
    hideTip();
  };
  if (!view || SESSION.docs.length <= 1) return null;
  const focus = SESSION.docs[SESSION.docIdx];
  if (!focus) return null;
  const z = view.zoom;
  const snapTol = (SESSION.prefs.snapRange || SNAP_SCREEN_PX) / z;
  return (
    <>
      {SESSION.docs.map((e, i) => {
        // the bar is positioned from the canvas rect mapped through the view
        // (which may be rotated): use the bounding box of its four corners, so
        // the bar stays glued above the canvas at every rotation
        const lx = view.ox + (e.x - focus.x) * z;
        const ly = view.oy + (e.y - focus.y) * z;
        const cw = e.doc.w * z, ch = e.doc.h * z;
        const cs = [view.toSurface(lx, ly), view.toSurface(lx + cw, ly),
          view.toSurface(lx, ly + ch), view.toSurface(lx + cw, ly + ch)];
        const minX = Math.min(cs[0].x, cs[1].x, cs[2].x, cs[3].x);
        const maxX = Math.max(cs[0].x, cs[1].x, cs[2].x, cs[3].x);
        const minY = Math.min(cs[0].y, cs[1].y, cs[2].y, cs[3].y);
        const boxW = maxX - minX;               // canvas width on screen
        const narrow = boxW < 118;              // canvas narrower than the bar
        const width = narrow ? 118 : boxW;
        // when the bar is wider than the canvas it stays centred on it
        const left = (minX + maxX) / 2 - width / 2;
        const top = minY - 30;
        const on = i === SESSION.docIdx;
        return (
          <div
            key={i}
            className={"cv-title" + (on ? " on" : "") + (e.locked ? " locked" : "")}
            style={{ left, top, width }}
            data-guide={"canvas-title-" + i}
            title={on ? t("canvasFocused") : t("canvasFocusHint")}
            onPointerDown={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              stopTip();
              // only the buttons inside own the press; the name/labels drag
              if ((ev.target as HTMLElement).closest("button")) return;
              try { (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId); } catch { /* ignore */ }
              drag.current = {
                i, x: ev.clientX, y: ev.clientY, x0: e.x, y0: e.y,
                moved: false, hit: null, locked: e.locked === true, warned: false,
              };
            }}
            onPointerMove={(ev) => {
              const d = drag.current;
              if (!d || d.i !== i) return;
              const dx = ev.clientX - d.x;
              const dy = ev.clientY - d.y;
              if (!d.moved && Math.hypot(dx, dy) < 4) return;
              if (d.locked) {
                if (!d.warned) {
                  d.warned = true;
                  SESSION.hapticTick("锁定", 0.6);
                  showTip({ title: t("canvasLocked"), desc: t("canvasLockedHint") });
                }
                return;
              }
              d.moved = true;
              ev.preventDefault();
              // magnetically align with the other canvases (and their groups);
              // a rotated view turns the screen delta into a space delta
              const sp = view.surfaceDelta(dx, dy);
              const want = { x: d.x0 + sp.x, y: d.y0 + sp.y };
              const snap = SESSION.prefs.snapOn
                ? SESSION.snapPosition(i, want.x, want.y, snapTol)
                : { x: want.x, y: want.y, hit: null, zones: [] };
              // entering a zone: tick + a flash, then the zone stays lit while
              // the finger keeps it in range; leaving it flashes once more
              if (snap.hit !== null && pulsed.current !== snap.hit) {
                pulsed.current = snap.hit;
                SESSION.hapticTick("吸附", 0.9);
              } else if (snap.hit === null) pulsed.current = null;
              d.hit = snap.hit;
              SESSION.moveCanvas(i, snap.x, snap.y);
              // light up EVERY zone that is satisfied at the position the
              // canvas actually took (several can be active at once)
              SESSION.setSnapZones(snap.zones.length || snap.hit !== null
                ? SESSION.snapPosition(i, snap.x, snap.y, snapTol).zones
                : []);
            }}
            onPointerUp={(ev) => {
              const d = drag.current;
              drag.current = null;
              stopTip();
              try { (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
              if (!d) return;
              if (!d.moved) {
                // tap = focus; double tap = smoothly zoom this canvas to fit
                const now = Date.now();
                const prev = lastTap.current;
                lastTap.current = { i, t: now };
                SESSION.focusCanvas(i);
                if (prev && prev.i === i && now - prev.t < 340) {
                  lastTap.current = null;
                  SESSION.fitCanvas();
                }
                return;
              }
              SESSION.setSnapZones([], false); // the grouped highlight takes over
              SESSION.finishCanvasDrag(i, d.hit);
            }}
            onPointerCancel={() => { drag.current = null; stopTip(); SESSION.setSnapZones([]); }}
          >
            {narrow ? null : (
            <button className={"cv-btn" + (SESSION.hasPreview(i) ? " on" : "")}
              title={SESSION.hasPreview(i) ? t("canvasPreviewOff") : t("canvasPreview")}
              onPointerDown={(ev) => ev.stopPropagation()}
              onClick={(ev) => { ev.stopPropagation(); SESSION.togglePreview(i); }}>
              <Icon id="i-preview" size={13} />
            </button>
            )}
            {narrow ? null : <span className="cv-dot" />}
            <span className="cv-name">{e.doc.name || "untitled"}</span>
            {!narrow && e.locked && <span className="cv-lock" title={t("canvasLocked")}><Icon id="i-pin" size={11} /></span>}
            {!narrow && e.group && (
              <button className="cv-btn cv-unlink" title={t("canvasUnlink")}
                onPointerDown={(ev) => ev.stopPropagation()}
                onClick={(ev) => { ev.stopPropagation(); SESSION.unlinkCanvas(i); }}>
                <Icon id="i-unlink" size={13} />
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}
