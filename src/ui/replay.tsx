import React, { useEffect, useRef, useState } from "react";
import { SESSION } from "./singleton";
import type { Snapshot } from "../app/session";
import { makeT } from "./i18n";

function RIcon({ id, size = 18 }: { id: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <use href={"#" + id} />
    </svg>
  );
}

/** small click-only button styled like .btn (no long-press tooltip needed) */
function RBtn({ icon, label, onClick, title, className = "" }: { icon?: string; label?: string; onClick: () => void; title?: string; className?: string }) {
  return (
    <button type="button" className={"btn " + className} onClick={onClick} title={title ?? label ?? ""} aria-label={title ?? label ?? ""}>
      {icon ? <RIcon id={icon} /> : null}
      {label ? <span>{label}</span> : null}
    </button>
  );
}

/**
 * ReplayOverlay: replays the whole recorded edit process from the initial
 * (blank) state forward to the newest history entry, stepping the live
 * document so the canvas is redrawn at every step. Closing returns the doc
 * to the history index it had when the replay began.
 */
export function ReplayOverlay({
  t, snap, nameFn, onClose,
}: {
  t: ReturnType<typeof makeT>;
  snap: Snapshot;
  nameFn: (label: string) => string;
  onClose: () => void;
}) {
  const startIdx = useRef(SESSION.history.list().index);
  const total = SESSION.history.list().labels.length;
  const [playing, setPlaying] = useState(true);
  const [spd, setSpd] = useState<"slow" | "med" | "fast">("med");
  const [idx, setIdx] = useState(0);
  const playingRef = useRef(true);
  const timerRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // start: reset the document to the recorded initial state, then step forward
  useEffect(() => {
    playingRef.current = true;
    setPlaying(true);
    SESSION.setReplayMode(true);
    SESSION.jumpHistory(0);
    return () => {
      playingRef.current = false;
      SESSION.setReplayMode(false);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!playingRef.current) return;
    if (idx >= total) {
      // natural end of the recording: step back to the pre-replay state and close
      playingRef.current = false;
      setPlaying(false);
      exit();
      return;
    }
    const ms = spd === "slow" ? 900 : spd === "fast" ? 170 : 400;
    const id = window.setTimeout(() => {
      if (!playingRef.current) return;
      const n = idx + 1;
      if (n > total) {
        playingRef.current = false;
        setPlaying(false);
        exit();
        return;
      }
      SESSION.jumpHistory(n);
      setIdx(n);
    }, ms);
    timerRef.current = id;
    return () => {
      if (timerRef.current === id) timerRef.current = null;
    };
  }, [playing, idx, spd, total]);

  const toggle = () => {
    if (playingRef.current) {
      playingRef.current = false;
      setPlaying(false);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    } else if (idx >= total) {
      SESSION.jumpHistory(0);
      setIdx(0);
      playingRef.current = true;
      setPlaying(true);
    } else {
      playingRef.current = true;
      setPlaying(true);
    }
  };
  const restart = () => {
    playingRef.current = true;
    setPlaying(true);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    SESSION.jumpHistory(0);
    setIdx(0);
  };
  const exit = () => {
    playingRef.current = false;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    SESSION.jumpHistory(startIdx.current);
    onCloseRef.current();
  };

  const { labels } = SESSION.history.list();
  const curLabel = idx === 0
    ? t("historyStart")
    : labels[idx - 1]
      ? nameFn(labels[idx - 1])
      : t("historyStart");
  const spdLabel = spd === "slow" ? t("spdSlow") : spd === "med" ? t("spdMed") : t("spdFast");

  return (
    <div className="replay-wrap">
      <div className="replay-shade" />
      <div className="replay-hud">
        <div className="rh-head">
          <span className="rh-title">{t("replay")}</span>
          <span className="rh-prog">{Math.min(idx, total)}/{total}</span>
          <div className="grow" />
          <button type="button" className="btn small" onClick={exit} title={t("close")}><RIcon id="i-x" /></button>
        </div>
        <div className="rh-cur" title={curLabel}>{curLabel}</div>
        <div className="rh-btns">
          <RBtn icon={playing ? "i-pause" : "i-play"} className="mini primary" title={playing ? t("pause") : t("play")} onClick={toggle} />
          <RBtn label="↺" className="mini" title={t("replayRestart")} onClick={restart} />
          <RBtn label={spdLabel} className="mini" title={t("replaySpeed")} onClick={() => setSpd(spd === "slow" ? "med" : spd === "med" ? "fast" : "slow")} />
          <div className="grow" />
          <button type="button" className="btn mini" onClick={exit} title={t("replayBack")}>{t("replayBack")}</button>
        </div>
        <div className="rh-note">{t("replayNote")}</div>
      </div>
    </div>
  );
}

/** true when the history contains at least one recorded step */
export function canReplay(): boolean {
  return SESSION.history.list().labels.length > 0;
}