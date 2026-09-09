// Multi-canvas layer: a game-style title bar above every canvas in the space.
//
// The canvases themselves are painted by View (which owns pan/zoom); these DOM
// bars are positioned from the same view transform so they stay glued to their
// canvas. Dragging a bar moves that canvas inside the infinite space, tapping
// it focuses that canvas.
import { useRef } from "react";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import { useSession } from "./base";
import type { Lang } from "./i18n";
import type { View } from "../render/view";

export function CanvasTitles({ view, tick }: { view: View | null; tick: number }) {
  void tick; // re-render on view changes (pan / zoom / resize)
  useSession(); // and whenever the canvases themselves change
  const t = makeT(SESSION.prefs.lang as Lang);
  const drag = useRef<{ i: number; x: number; y: number; x0: number; y0: number; moved: boolean } | null>(null);
  /** last tap on a title bar, for the double-tap "zoom to this canvas" */
  const lastTap = useRef<{ i: number; t: number } | null>(null);
  if (!view || SESSION.docs.length <= 1) return null;
  const focus = SESSION.docs[SESSION.docIdx];
  if (!focus) return null;
  const z = view.zoom;
  return (
    <>
      {SESSION.docs.map((e, i) => {
        const left = view.ox + (e.x - focus.x) * z;
        const top = view.oy + (e.y - focus.y) * z - 30;
        const width = Math.max(96, e.doc.w * z);
        const on = i === SESSION.docIdx;
        return (
          <div
            key={i}
            className={"cv-title" + (on ? " on" : "")}
            style={{ left, top, width }}
            data-guide={"canvas-title-" + i}
            title={on ? t("canvasFocused") : t("canvasFocusHint")}
            onPointerDown={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              try { (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId); } catch { /* ignore */ }
              drag.current = { i, x: ev.clientX, y: ev.clientY, x0: e.x, y0: e.y, moved: false };
            }}
            onPointerMove={(ev) => {
              const d = drag.current;
              if (!d || d.i !== i) return;
              const dx = ev.clientX - d.x;
              const dy = ev.clientY - d.y;
              if (!d.moved && Math.hypot(dx, dy) < 6) return;
              d.moved = true;
              ev.preventDefault();
              SESSION.moveCanvas(i, d.x0 + dx / z, d.y0 + dy / z);
            }}
            onPointerUp={(ev) => {
              const d = drag.current;
              drag.current = null;
              try { (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
              if (!d || d.moved) return;
              const now = Date.now();
              const prev = lastTap.current;
              lastTap.current = { i, t: now };
              SESSION.focusCanvas(i);
              // double tap = smoothly zoom this canvas to fill the screen
              if (prev && prev.i === i && now - prev.t < 340) {
                lastTap.current = null;
                SESSION.fitCanvas();
              }
            }}
            onPointerCancel={() => { drag.current = null; }}
          >
            <span className="cv-dot" />
            <span className="cv-name">{e.doc.name || "untitled"}</span>
            <span className="cv-meta">{e.doc.w + "\u00d7" + e.doc.h}</span>
          </div>
        );
      })}
    </>
  );
}
