// Virtual touch visualisation for the onboarding guide: instead of only
// describing a gesture, this plays it with animated finger dots inside the
// highlighted area. Content-free — it only knows the demo kind.
import type { GuideDemoKind } from "../app/guide";
import type { GuideRect } from "./guide-layout";

const DOTS: Record<GuideDemoKind, number> = {
  tap: 1,
  doubleTap: 1,
  tripleTap: 1,
  oneFingerDraw: 1,
  twoFingerPinch: 2,
  twoFingerPan: 2,
  twoFingerDoubleTap: 2,
  fourFingerSwipe: 4,
  longPressDrag: 1,
};

/** where dot `i` starts inside the demo box (px relative to the box) */
function startPos(kind: GuideDemoKind, i: number, w: number, h: number): { x: number; y: number } {
  const cx = w / 2;
  const cy = h / 2;
  switch (kind) {
    case "twoFingerPinch":
      return { x: cx + (i === 0 ? -64 : 64), y: cy };
    case "twoFingerPan":
    case "twoFingerDoubleTap":
      return { x: cx + (i === 0 ? -52 : 52), y: cy };
    case "fourFingerSwipe":
      return { x: (w * (i + 1)) / 5, y: h - 52 };
    case "oneFingerDraw":
      return { x: w * 0.26, y: h * 0.66 };
    default:
      return { x: cx, y: cy };
  }
}

export function GuideDemo({ kind, area }: { kind: GuideDemoKind; area: GuideRect | null }) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = area ? Math.max(160, area.w) : Math.min(320, vw * 0.8);
  const h = area ? Math.max(120, area.h) : 220;
  const left = area ? area.x : (vw - w) / 2;
  const top = area ? area.y : Math.max(60, vh * 0.34);
  const n = DOTS[kind];
  return (
    <div className="guide-demo" style={{ left, top, width: w, height: h }}>
      {Array.from({ length: n }, (_, i) => {
        const p = startPos(kind, i, w, h);
        const style: Record<string, string | number> = {
          left: p.x,
          top: p.y,
          // both fingers of a two-finger double-tap move at the same time
          animationDelay: (kind === "twoFingerDoubleTap" ? 0 : i * 0.12).toFixed(2) + "s",
        };
        if (kind === "twoFingerPinch") style["--pinch"] = (i === 0 ? -36 : 36) + "px";
        return <span key={i} className={"gd-dot gd-" + kind + " gd-i" + i} style={style as React.CSSProperties} />;
      })}
    </div>
  );
}
