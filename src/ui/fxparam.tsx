// Parameter dialog for the magic-ball effects.
//
// An effect that needs values (blur radius, shadow offset, outline width …) is
// described by one FxRun: a title, a list of typed parameters and a pure
// apply() function. The dialog edits the parameters and the host re-applies the
// effect to a snapshot of the cel on every change, so the canvas shows a live
// preview; Cancel restores the snapshot, Apply records one history step.
import { makeT } from "./i18n";
import type { Lang } from "./i18n";
import { Btn, Icon, ScrubNum } from "./base";
import { SESSION } from "./singleton";
import type { Doc } from "../engine/doc";

export interface FxParamDef {
  key: string;
  kind: "int" | "color" | "enum";
  /** i18n key of the row label */
  label: string;
  min?: number;
  max?: number;
  unit?: string;
  options?: Array<{ value: string; label: string }>;
  def: number | string;
}

export type FxVals = Record<string, number | string>;

export interface FxRun {
  /** history label (see modals.tsx histName) */
  label: string;
  /** i18n key of the dialog title */
  title: string;
  /** i18n key of the one-line description */
  desc?: string;
  params: FxParamDef[];
  /** mutate a fresh copy of the original cel pixels */
  apply: (data: Uint8ClampedArray, w: number, h: number, v: FxVals) => void;
  /** optional custom commit, for effects that cannot simply bake into the cel
   *  (e.g. drop shadow -> new layer). It receives the pristine pixels, undoes
   *  the live preview itself and returns true when it recorded history. */
  commit?: (doc: Doc, li: number, fi: number, before: Uint8ClampedArray, v: FxVals) => boolean;
}

/** parameter values a run starts with */
export function fxDefaults(run: FxRun): FxVals {
  const out: FxVals = {};
  for (const p of run.params) out[p.key] = p.def;
  return out;
}

export function FxParamDialog({ run, vals, onChange, onApply, onCancel }: {
  run: FxRun;
  vals: FxVals;
  onChange: (key: string, v: number | string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const t = makeT(SESSION.prefs.lang as Lang);
  return (
    <>
      <div className="dlg-mask" onClick={onCancel} />
      <div className="dlg fxdlg">
        <div className="dlg-head">
          <span>{t(run.title)}</span>
          <div className="grow" />
          <button className="btn small" onClick={onCancel}><Icon id="i-x" size={16} /></button>
        </div>
        <div className="dlg-body">
          {run.desc && <div className="row-note">{t(run.desc)}</div>}
          {run.params.map((p) => (
            <div key={p.key} className="fxp-row">
              <label className="fxp-label">{t(p.label)}</label>
              {p.kind === "int" && (
                <div className="fxp-ctl">
                  <ScrubNum min={p.min} max={p.max} value={vals[p.key] as number}
                    onChange={(v) => onChange(p.key, Number(v) || 0)} />
                  {p.unit && <span className="fxp-unit">{p.unit}</span>}
                </div>
              )}
              {p.kind === "color" && (
                <div className="fxp-ctl">
                  <input type="color" value={String(vals[p.key])} onChange={(e) => onChange(p.key, e.target.value)} />
                  <span className="fxp-unit">{String(vals[p.key])}</span>
                </div>
              )}
              {p.kind === "enum" && (
                <div className="chips">
                  {(p.options ?? []).map((o) => (
                    <button key={o.value} type="button" className={"chip" + (vals[p.key] === o.value ? " on" : "")}
                      onClick={() => onChange(p.key, o.value)}>{t(o.label)}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="dlg-foot">
          <Btn label={t("cancel")} onClick={onCancel} />
          <Btn label={t("ok")} className="primary" onClick={onApply} />
        </div>
      </div>
    </>
  );
}
