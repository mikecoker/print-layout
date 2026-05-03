import { AUTO_MARGIN_IN } from "./constants";
import type { PageSettings, PrintElement } from "./types";

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function backPos(el: PrintElement, ps: PageSettings): { x: number; y: number } {
  const dx = ps.backOffsetX ?? 0;
  const dy = ps.backOffsetY ?? 0;
  if (ps.flipAxis === "long") {
    return { x: ps.widthIn - el.x - el.widthIn + dx, y: el.y + dy };
  }
  return { x: el.x + dx, y: ps.heightIn - el.y - el.heightIn + dy };
}

export function computeAutoSize(
  naturalW: number,
  naturalH: number,
  isSvg: boolean,
  page: PageSettings,
): { widthIn: number; heightIn: number; rotation: 0 | 90 | 180 | 270 } {
  const m = AUTO_MARGIN_IN;
  const availW = page.widthIn - 2 * m;
  const availH = page.heightIn - 2 * m;

  let wIn: number;
  let hIn: number;
  if (!naturalW || !naturalH) {
    wIn = 2.5;
    hIn = 3.5;
  } else if (isSvg) {
    wIn = naturalW;
    hIn = naturalH;
  } else {
    wIn = naturalW / 300;
    hIn = naturalH / 300;
  }

  const spP = Math.min(1, availW / wIn, availH / hIn);
  const spL = Math.min(1, availW / hIn, availH / wIn);
  const areaP = wIn * spP * hIn * spP;
  const areaL = hIn * spL * wIn * spL;

  const r2 = (v: number) => Math.round(v * 100) / 100;
  if (areaL > areaP) {
    return { widthIn: r2(hIn * spL), heightIn: r2(wIn * spL), rotation: 90 };
  }
  return { widthIn: r2(wIn * spP), heightIn: r2(hIn * spP), rotation: 0 };
}

export function svgNaturalDims(src: string): { w: number; h: number } {
  const [header, encoded] = src.split(",");
  const text = header.includes("base64") ? atob(encoded) : decodeURIComponent(encoded);
  const vb = text.match(/viewBox\s*=\s*"[^"]*?\s+[^"]*?\s+([0-9.]+)\s+([0-9.]+)"/);
  if (vb) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) };
  const wm = text.match(/\bwidth\s*=\s*"([0-9.]+)"/);
  const hm = text.match(/\bheight\s*=\s*"([0-9.]+)"/);
  if (wm && hm) return { w: parseFloat(wm[1]), h: parseFloat(hm[1]) };
  return { w: 0, h: 0 };
}
