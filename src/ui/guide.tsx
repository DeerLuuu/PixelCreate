// Spotlight onboarding overlay.
//
// The engine is content-free: it walks the declared steps (src/app/guide.ts),
// highlights the real control each step points at and asks the app to perform
// the step's before/after actions. Steps whose target never shows up are
// skipped so the tour always finishes.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GUIDE_MODULES, guideProgress, type GuideAction, type GuideActionList, type GuideStep } from "../app/guide";
import { guideBubblePosAvoiding, shrinkHole, type GuideRect } from "./guide-layout";
import { GuideDemo } from "./guide-demo";
import { makeT } from "./i18n";
import { SESSION } from "./singleton";
import { Btn } from "./base";

/** REALLY tap a control: dispatch the same pointer/click sequence a finger
 *  would, so both onClick and onPointerDown handlers react */
/** REALLY tap a control (also used by the app for its own guide demos) */
export function simulateTap(selector: string): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const base: PointerEventInit = {
    bubbles: true, cancelable: true, composed: true, isPrimary: true,
    pointerId: 1, pointerType: "touch", clientX: cx, clientY: cy, button: 0,
  };
  try {
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
  } catch {
    el.click();
  }
  return true;
}

function rectOf(el: Element): GuideRect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

export function GuideOverlay({ steps, actions, onDone }: {
  steps: GuideStep[];
  actions?: Partial<Record<GuideAction, () => void>>;
  onDone: (shown: string[]) => void;
}) {
  const t = useMemo(() => makeT(SESSION.prefs.lang), []);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<GuideRect | null>(null);
  const [nonce, setNonce] = useState(0);
  const shownRef = useRef<string[]>([]);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [bubbleH, setBubbleH] = useState(0);
  const step = steps[i];

  /** run one declared action, or a list of them in order */
  const runActions = (list: GuideActionList | undefined): void => {
    if (!list) return;
    for (const a of Array.isArray(list) ? list : [list]) actions?.[a]?.();
  };

  // measure the card so it can be flipped and clamped inside the viewport;
  // offsetHeight ignores any CSS transform, so an entrance animation can never
  // skew the measurement
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    if (h > 0 && Math.abs(h - bubbleH) > 0.5) setBubbleH(h);
  }, [step, nonce, bubbleH]);

  // every step counts as seen the moment it is displayed (including skipped ones)
  useEffect(() => {
    if (step && !shownRef.current.includes(step.id)) shownRef.current.push(step.id);
  }, [step]);

  // run the step's "before" action, then measure its target (panels animate in)
  useLayoutEffect(() => {
    if (!step) return;
    runActions(step.before);
    // really tap the control so the app performs the action being taught
    if (step.click) window.setTimeout(() => simulateTap(step.click!), 60);
    const measure = () => {
      const el = step.target ? document.querySelector(step.target) : null;
      setRect(el ? rectOf(el) : null);
    };
    measure();
    const t1 = window.setTimeout(measure, 220);
    const t2 = window.setTimeout(measure, 560);
    window.addEventListener("resize", measure);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.removeEventListener("resize", measure);
    };
  }, [step, actions, nonce]);

  const leaveStep = (st?: GuideStep) => {
    if (!st) return;
    if (st.closeClick) simulateTap(st.closeClick);
    runActions(st.after);
  };
  const finish = (upto: number) => {
    const last = steps[Math.min(upto, steps.length - 1)];
    leaveStep(last);
    onDone(shownRef.current.slice());
  };
  const next = () => {
    if (i + 1 >= steps.length) { finish(i); return; }
    leaveStep(step);
    setI(i + 1);
    setRect(null);
  };
  const back = () => {
    if (i <= 0) return;
    leaveStep(step);
    setI(i - 1);
    setRect(null);
  };
  /** skip every remaining step of the current section (module) */
  const skipModule = () => {
    const mod = step.module;
    let j = i;
    while (j < steps.length && steps[j].module === mod) {
      leaveStep(steps[j]); // undo whatever those steps set up
      if (!shownRef.current.includes(steps[j].id)) shownRef.current.push(steps[j].id);
      j++;
    }
    if (j >= steps.length) { finish(steps.length - 1); return; }
    setI(j);
    setRect(null);
  };

  // Android back leaves the tour instead of the app
  useEffect(() => {
    const onBack = (e: Event) => {
      const d = (e as CustomEvent<{ handled: boolean }>).detail;
      if (!d || d.handled) return;
      d.handled = true;
      finish(i);
    };
    window.addEventListener("pc-back", onBack);
    return () => window.removeEventListener("pc-back", onBack);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, steps]);

  // a target that never appears is skipped so the tour keeps moving
  useEffect(() => {
    if (!step || !step.target || rect) return;
    const id = window.setTimeout(() => {
      if (document.querySelector(step.target!)) setNonce((n) => n + 1);
      else next();
    }, 700);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, rect]);

  if (!step) return null;

  const vv = window.visualViewport;
  const vw = Math.round(vv?.width ?? window.innerWidth);
  const vh = Math.round(vv?.height ?? window.innerHeight);
  const PAD = 8;
  // a huge target (the whole canvas) would swallow the card: shrink the hole to
  // its centre so the card can sit outside the highlighted area
  const holeRect = rect ? shrinkHole(rect, vw, vh) : null;
  const hole = holeRect ? { left: holeRect.x - PAD, top: holeRect.y - PAD, width: holeRect.w + PAD * 2, height: holeRect.h + PAD * 2 } : null;
  const BW = Math.min(320, vw - 24);
  // the real bubble height is measured after render; the placement helper flips
  // the card when the preferred side has no room, clamps it on BOTH axes and
  // prefers a spot that does not cover the highlighted area at all
  const BH = bubbleH || 150;
  const pos = guideBubblePosAvoiding(holeRect, BW, BH, vw, vh, step.place);
  const modLabel = t(GUIDE_MODULES.find((m) => m.id === step.module)?.label ?? "");

  return (
    <div className={"guide-layer" + (step.peek ? " peek" : "")}>
      {hole ? <div className="guide-hole" style={hole} /> : <div className="guide-shade" />}
      {step.demo && <GuideDemo kind={step.demo} area={holeRect} />}
      <div ref={bubbleRef} className="guide-bubble" style={{ left: pos.left, top: pos.top, width: BW }}>
        <div className="guide-meta">
          <span className="guide-mod">{modLabel}</span>
          <button type="button" className="guide-skipmod" onClick={skipModule}>{t("guideSkipModule")}</button>
          <span className="guide-step">{guideProgress(i, steps.length)}</span>
        </div>
        <div className="guide-title">{t(step.title)}</div>
        <div className="guide-body">{t(step.body)}</div>
        <div className="guide-foot">
          <Btn label={t("guideSkip")} onClick={() => finish(i)} />
          {i > 0 && <Btn label={t("guideBack")} onClick={back} />}
          <Btn label={i + 1 >= steps.length ? t("guideDone") : t("guideNext")} className="primary" onClick={next} />
        </div>
      </div>
    </div>
  );
}
