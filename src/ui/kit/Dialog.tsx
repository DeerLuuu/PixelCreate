// Dialog — the one window shell every dialog in the app uses.
//
// DOM contract (do not change, styles/tests/guide anchors rely on it):
//   <div class="dlg-mask" aria-hidden="true"></div>
//   <div class="dlg [className]" role="dialog" aria-modal="true" aria-label data-guide>
//     <div class="dlg-head"><span>title</span><div class="grow"></div><button class="btn small"></div>
//     <div class="dlg-body [bodyClass]">children</div>
//     <div class="dlg-foot">footer</div>          ← only when footer is given
//   </div>
//
// It renders a fragment and never mounts/unmounts itself: callers keep wrapping
// it in <Keep on={…} el={<Dialog …/>} /> so the exit animation can run.
import React, { useEffect } from "react";
import { Icon } from "./primitives";

export interface DialogProps {
  /** header text; also used as aria-label when it is a plain string */
  title?: React.ReactNode;
  onClose?: () => void;
  children?: React.ReactNode;
  /** footer row (buttons); omit for a body-only dialog */
  footer?: React.ReactNode;
  /** content between .dlg-head and .dlg-body (e.g. the history note, ref-mode picker) */
  top?: React.ReactNode;
  /** content between .dlg-body and .dlg-foot (e.g. the replay line) */
  extra?: React.ReactNode;
  /** extra DOM props for .dlg-body (touch handlers for pinch-to-resize) */
  bodyProps?: React.HTMLAttributes<HTMLDivElement>;
  /** extra class on .dlg (fxdlg / tile-dlg / clg-dlg / dlg-top / …) */
  className?: string;
  /** extra class on .dlg-body (col / hist-body / fp-grid / …) */
  bodyClass?: string;
  bodyStyle?: React.CSSProperties;
  /** onboarding anchor → data-guide */
  guide?: string;
  /** show the × button (default true when onClose is given) */
  closeBtn?: boolean;
  /** clicking the backdrop closes (default true) */
  maskClose?: boolean;
  /** Escape closes (default true) */
  escClose?: boolean;
  /** aria-label of the × button */
  closeLabel?: string;
  /** explicit aria-label when `title` is not a plain string */
  label?: string;
}

export function Dialog({
  title, onClose, children, footer, top, extra, className = "", bodyClass = "", bodyStyle, bodyProps,
  guide, closeBtn = true, maskClose = true, escClose = true, closeLabel = "close", label,
}: DialogProps) {
  const close = onClose;
  useEffect(() => {
    if (!escClose || !close) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escClose, close]);
  const ariaLabel = label ?? (typeof title === "string" ? title : undefined);
  return (
    <>
      <div className="dlg-mask" aria-hidden="true" onClick={maskClose ? close : undefined} />
      <div
        className={"dlg" + (className ? " " + className : "")}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        data-guide={guide}
      >
        <div className="dlg-head">
          <span>{title}</span>
          <div className="grow" />
          {closeBtn && close ? (
            <button type="button" className="btn small" aria-label={closeLabel} onClick={close}>
              <Icon id="i-x" size={16} />
            </button>
          ) : null}
        </div>
        {top}
        <div className={"dlg-body" + (bodyClass ? " " + bodyClass : "")} style={bodyStyle} {...bodyProps}>{children}</div>
        {extra}
        {footer ? <div className="dlg-foot">{footer}</div> : null}
      </div>
    </>
  );
}
