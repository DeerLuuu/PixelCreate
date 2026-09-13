// 等距图形的**参数条**（iso 模式开着时浮在画布上方）。
//
// 为什么是「条」而不是弹窗：这个模式的全部手感都在画布上（拖抓手改尺寸 / 拖顶面调高 /
// 拖整块移动），面板一旦铺满屏幕就看不见自己在拖什么了。所以：
//   · 常驻一条紧凑参数条（形状 chips + 尺寸 + 图块 + 生成 / 新图层 / 完成）；
//   · 外观（颜色 / 明暗 / 阴影 / 描边）折叠在「外观」里，展开也只占一行多一点；
//   · 读数（`W×D×H · 像素尺寸`）与「超出画布」提示就贴在条的右侧。
import { useMemo, useState } from "react";
import { SESSION } from "./singleton";
import { makeT } from "./i18n";
import { FEATURE_ICONS } from "./feature-icons";
import { Btn, useSession } from "./base";
import { ChipGroup, ScrubNum, Switch } from "./kit";
import { isoRender, isoShapeVoxels, ISO_SHAPES, ISO_TILES, type IsoShapeId } from "../engine/iso";
import { chipCss, rgbaToHex, hexToRgba } from "../engine/color";
import * as bridge from "../io/bridge";

export function IsoBar({ t, onOpenPalette }: { t: ReturnType<typeof makeT>; onOpenPalette: () => void }) {
  const snap = useSession();
  const p = SESSION.prefs.iso;
  const [look, setLook] = useState(false);
  const set = (patch: Partial<typeof p>) => SESSION.setIsoPref(patch);

  // 只在参数 / 原点 / 画布尺寸变了才重算（大形状下别每次 UI 刷新都跑一遍渲染）
  const stats = useMemo(() => {
    const r = isoRender(isoShapeVoxels(SESSION.isoShape()), SESSION.isoLook());
    const org = SESSION.isoOrigin ?? { x: 0, y: 0 };
    const ox = org.x - r.originAt.x, oy = org.y - r.originAt.y;
    const clipped = ox < 0 || oy < 0 || ox + r.w > SESSION.doc.w || oy + r.h > SESSION.doc.h;
    return { w: r.w, h: r.h, voxels: r.voxels, clipped };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, p.shape, p.w, p.d, p.h, p.steps, p.axis, p.dir, p.radius, p.hollow, p.topW, p.topD,
    p.thickness, p.tile, p.colorMode, p.faceTop, p.faceRight, p.faceLeft, p.intensity, p.peak, p.sway,
    p.shadow, p.outline, SESSION.isoOrigin?.x, SESSION.isoOrigin?.y]);

  const generate = (target: "layer" | "new") => {
    const r = SESSION.isoGenerate(target);
    if (!r.ok) {
      bridge.toast(r.reason === "locked" ? t("iso.errLocked") : r.reason === "outside" ? t("iso.errOutside") : t("iso.errNone"));
      return;
    }
    SESSION.hapticTick("等距生成", 0.6);
    bridge.toast(t("iso.done") + r.pixels + " px" + (r.clipped ? " · " + t("iso.clipped") + r.clipped : ""));
  };

  const pickFace = (which: "faceTop" | "faceRight" | "faceLeft") => {
    SESSION.awaitColorPick((c) => set({ [which]: rgbaToHex(c).slice(0, 7), colorMode: "custom" } as Partial<typeof p>));
    onOpenPalette();
  };
  const faceChip = (which: "faceTop" | "faceRight" | "faceLeft", label: string) => (
    <button
      type="button"
      className="iso-face"
      style={{ background: chipCss(hexToRgba(p[which])) }}
      title={label + " · " + p[which]}
      data-guide={"iso-" + which}
      onClick={() => pickFace(which)}
    />
  );

  return (
    <div className="iso-bar" data-guide="iso-bar">
      <div className="iso-row iso-shapes" data-guide="iso-shapes">
        <ChipGroup<IsoShapeId>
          value={p.shape}
          options={ISO_SHAPES.map((id) => ({ id, label: t("iso.shape." + id), guide: "iso-shape-" + id }))}
          onChange={(v) => set({ shape: v })}
        />
      </div>

      <div className="iso-row">
        <label className="iso-num">{t("iso.w")}
          <ScrubNum value={p.w} min={1} max={64} onChange={(v) => set({ w: parseInt(v, 10) || 1 })} />
        </label>
        <label className="iso-num">{t("iso.d")}
          <ScrubNum value={p.d} min={1} max={64} onChange={(v) => set({ d: parseInt(v, 10) || 1 })} />
        </label>
        <label className="iso-num">{t("iso.h")}
          <ScrubNum value={p.h} min={1} max={64} onChange={(v) => set({ h: parseInt(v, 10) || 1 })} />
        </label>
        <ChipGroup<string>
          className="iso-tile"
          value={String(p.tile)}
          options={ISO_TILES.map((v) => ({ id: String(v), label: v + "px" }))}
          onChange={(v) => set({ tile: Number(v) as typeof p.tile })}
        />
        <span className={"iso-read" + (stats.clipped ? " warn" : "")} data-guide="iso-read">
          {p.w}×{p.d}×{p.h} · {stats.w}×{stats.h}px · {stats.voxels} {t("iso.voxels")}
          {stats.clipped ? " · " + t("iso.clippedWarn") : ""}
        </span>
      </div>

      {look && (
        <div className="iso-row iso-look">
          <ChipGroup<"mono" | "fg" | "custom">
            value={p.colorMode}
            options={[
              { id: "mono", label: t("iso.mono"), guide: "iso-mode-mono" },
              { id: "fg", label: t("iso.fg"), guide: "iso-mode-fg" },
              { id: "custom", label: t("iso.custom"), guide: "iso-mode-custom" },
            ]}
            onChange={(v) => set({ colorMode: v })}
          />
          {p.colorMode === "custom" && (
            <span className="iso-faces" data-guide="iso-faces">
              {faceChip("faceTop", t("iso.faceTop"))}
              {faceChip("faceRight", t("iso.faceRight"))}
              {faceChip("faceLeft", t("iso.faceLeft"))}
            </span>
          )}
          <label className="iso-num">{t("iso.intensity")}
            <ScrubNum value={p.intensity} min={0} max={100} onChange={(v) => set({ intensity: parseInt(v, 10) || 0 })} />
          </label>
          <label className="iso-num">{t("iso.peak")}
            <ScrubNum value={p.peak} min={0} max={100} onChange={(v) => set({ peak: parseInt(v, 10) || 0 })} />
          </label>
          <label className="iso-num">{t("iso.sway")}
            <ScrubNum value={p.sway} min={0} max={100} onChange={(v) => set({ sway: parseInt(v, 10) || 0 })} />
          </label>
          <label className="iso-sw">
            <Switch checked={p.shadow === "contact"} onChange={(v) => set({ shadow: v ? "contact" : "off" })} label={t("iso.shadow")} />
            <span>{t("iso.shadow")}</span>
          </label>
          <label className="iso-sw">
            <Switch checked={p.outline} onChange={(v) => set({ outline: v })} label={t("iso.outline")} />
            <span>{t("iso.outline")}</span>
          </label>
          {p.shape === "cylinder" && (
            <label className="iso-sw">
              <Switch checked={p.hollow} onChange={(v) => set({ hollow: v })} label={t("iso.hollow")} />
              <span>{t("iso.hollow")}</span>
            </label>
          )}
          {(p.shape === "steps" || p.shape === "wedge") && (
            <>
              <label className="iso-num">{t("iso.steps")}
                <ScrubNum value={p.steps} min={2} max={Math.max(2, Math.max(p.w, p.d))} onChange={(v) => set({ steps: parseInt(v, 10) || 2 })} />
              </label>
              <label className="iso-sw">
                <Switch checked={p.axis === "y"} onChange={(v) => set({ axis: v ? "y" : "x" })} label={t("iso.axis")} />
                <span>{t("iso.axis")}</span>
              </label>
              <label className="iso-sw">
                <Switch checked={p.dir === -1} onChange={(v) => set({ dir: v ? -1 : 1 })} label={t("iso.dir")} />
                <span>{t("iso.dir")}</span>
              </label>
            </>
          )}
          {p.shape === "pyramid" && (
            <label className="iso-num">{t("iso.top")}
              <ScrubNum value={p.topW} min={0} max={p.w} onChange={(v) => set({ topW: parseInt(v, 10) || 0, topD: parseInt(v, 10) || 0 })} />
            </label>
          )}
          {p.shape === "frame" && (
            <label className="iso-num">{t("iso.thickness")}
              <ScrubNum value={p.thickness} min={1} max={Math.max(1, Math.floor(Math.min(p.w, p.d) / 2))} onChange={(v) => set({ thickness: parseInt(v, 10) || 1 })} />
            </label>
          )}
        </div>
      )}

      <div className="iso-row iso-acts">
        <Btn icon={FEATURE_ICONS.isoBar.generate} label={t("iso.generate")} className="primary" onClick={() => generate("layer")} guide="iso-generate" />
        <Btn icon={FEATURE_ICONS.isoBar.newLayer} label={t("iso.newLayerShort")} title={t("iso.newLayer")} onClick={() => generate("new")} guide="iso-new-layer" />
        <Btn icon={FEATURE_ICONS.isoBar.look} label={t(look ? "iso.lookHide" : "iso.look")} onClick={() => setLook((v) => !v)} active={look} guide="iso-look" />
        <Btn label={t("iso.exit")} onClick={() => SESSION.exitIso()} guide="iso-exit" />
      </div>
      <div className="iso-hint">{t("iso.hint")}</div>
    </div>
  );
}
