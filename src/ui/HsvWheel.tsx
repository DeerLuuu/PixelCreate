// Circular HSV color wheel: hue = angle, saturation = radius, value slider.
import React, { useEffect, useRef } from "react";
import type { RGBA } from "../engine/types";
import { rgbaToHex } from "../engine/color";

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHsv(c: [number, number, number]): [number, number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  const s = max === 0 ? 0 : d / max;
  return [h, s, max];
}

interface Props {
  color: RGBA;
  onChange: (c: RGBA) => void;
}

export function HsvWheel({ color, onChange }: Props) {
  const diskRef = useRef<HTMLCanvasElement | null>(null);
  const barRef = useRef<HTMLCanvasElement | null>(null);
  const size = 210;

  const [h, s] = (() => {
    const [hh, ss] = rgbToHsv([color[0], color[1], color[2]]);
    return [hh, ss];
  })();

  useEffect(() => {
    const cv = diskRef.current;
    if (!cv) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const N = Math.round(size * dpr);
    cv.width = N;
    cv.height = N;
    const ctx = cv.getContext("2d")!;
    const cx = N / 2, cy = N / 2, R = Math.max(1, (size / 2 - 2) * dpr);
    const img = ctx.createImageData(N, N);
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > R) continue;
        const hue = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
        const sat = Math.min(1, dist / R);
        const [rr, gg, bb] = hsvToRgb(hue < 0 ? hue + 360 : hue, sat, 1);
        const i = (py * N + px) * 4;
        img.data[i] = rr; img.data[i + 1] = gg; img.data[i + 2] = bb; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // marker in CSS pixel space
    const cssCx = size / 2, cssCy = size / 2;
    const cssR = size / 2 - 2;
    const ang = ((h - 90) * Math.PI) / 180;
    const mr = Math.max(3, s * cssR);
    const mx = cssCx + Math.cos(ang) * mr;
    const my = cssCy + Math.sin(ang) * mr;
    ctx.beginPath();
    ctx.arc(mx, my, 7, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(mx, my, 7, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,.6)";
    ctx.stroke();
  }, [h, s, size]);

  useEffect(() => {
    const cv = barRef.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = 18 * dpr;
    cv.height = size * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [rr, gg, bb] = hsvToRgb(h, s, 1);
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, "rgb(" + rr + "," + gg + "," + bb + ")");
    grad.addColorStop(1, "#000000");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 18, size);
    // value marker: value in rgb max/255
    const [r2, g2, b2] = [color[0], color[1], color[2]];
    const v = Math.max(r2, g2, b2) / 255;
    const my = size - v * size;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, my - 5, 18, 2.5);
    ctx.strokeStyle = "rgba(0,0,0,.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0, my - 6, 18, 12);
  }, [h, s, color, size]);

  const applyFromDisk = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = diskRef.current!;
    const rect = cv.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2, R = rect.width / 2 - 2;
    const dx = e.clientX - rect.left - cx;
    const dy = e.clientY - rect.top - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > rect.width / 2) return;
    let hue = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    if (hue < 0) hue += 360;
    const sat = Math.min(1, dist / R);
    const v = Math.max(color[0], color[1], color[2]) / 255;
    const [rr, gg, bb] = hsvToRgb(hue, sat, v);
    onChange([rr, gg, bb, color[3]]);
  };
  const applyFromBar = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = barRef.current!;
    const rect = cv.getBoundingClientRect();
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const v = 1 - y;
    const [hh, ss] = rgbToHsv([color[0], color[1], color[2]]);
    const [rr, gg, bb] = hsvToRgb(hh, ss, v);
    onChange([rr, gg, bb, color[3]]);
  };

  return (
    <div className="wheel-row">
      <canvas
        ref={diskRef}
        className="wheel-disk"
        style={{ width: size, height: size }}
        onPointerDown={(e) => { e.preventDefault(); applyFromDisk(e); }}
        onPointerMove={(e) => { if (e.buttons > 0) applyFromDisk(e); }}
      />
      <canvas
        ref={barRef}
        className="wheel-bar"
        style={{ width: 18, height: size }}
        onPointerDown={(e) => { e.preventDefault(); applyFromBar(e); }}
        onPointerMove={(e) => { if (e.buttons > 0) applyFromBar(e); }}
      />
    </div>
  );
}

export function colorToHex6(c: RGBA): string {
  return rgbaToHex([c[0], c[1], c[2], 255]);
}
