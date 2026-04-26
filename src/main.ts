import { PDFDocument } from "pdf-lib";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ImportedFont, PrintElement, PageSettings, FlipAxis } from "./types";
import {
  AUTO_GAP_IN,
  AUTO_MARGIN_IN,
  DISPLAY_PPI,
  PDF_RASTER_DPI,
  PT_PER_IN,
  SNAP_THRESHOLD_IN,
} from "./constants";
import { buildAdjustedSrc, patchSvgStretch, printFilter, updateLevelsFilter } from "./image-utils";
import type { Adj } from "./image-utils";
import { backPos, clamp, computeAutoSize, escapeHtml, svgNaturalDims } from "./layout-utils";
import { setImportedFonts } from "./fonts";
import { basename, isDesktopApp, openFontPaths, openImagePaths, persistAssetPath, readBinaryPath, savePdfPath, writeBinaryPath } from "./desktop";
import {
  clearAllHandles,
  deleteHandle,
  hasMissingImages,
  loadFileIntoElement,
  loadProject as loadProjectFile,
  loadState,
  pickFileForElement,
  reconnectAll as reconnectAllImages,
  restoreAllHandles,
  restoreGlobalBacks as restoreGlobalBackImages,
  saveCachedImageData,
  saveHandle,
  saveProject as saveProjectFile,
  saveState,
} from "./persistence";

interface SnapLine { axis: "x" | "y"; pos: number }

// ─── State ────────────────────────────────────────────────────────────────────

let elements: PrintElement[] = [];
let pages: PageSettings[] = [{ widthIn: 8.5, heightIn: 11, flipAxis: "long" }];
let currentPageIndex = 0;
let page = pages[0]; // always points to pages[currentPageIndex]
let view: "front" | "back" = "front";
let selectedId: string | null = null;
let nextId = 1;
let importedFonts: ImportedFont[] = [];
// Print adjustments live in PageSettings per sheet — no global vars needed.
let zoomLevel = 1.0;
let drag: {
  id: string;
  startMouseX: number;
  startMouseY: number;
  startElX: number;
  startElY: number;
} | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAdj(ps: PageSettings = page, forBack = view === "back"): Adj {
  return forBack ? {
    brightness: ps.backBrightness ?? 1,
    saturation: ps.backSaturation ?? 1,
    contrast:   ps.backContrast   ?? 1,
    blackPoint: ps.backBlackPoint ?? 0,
    whitePoint: ps.backWhitePoint ?? 1,
  } : {
    brightness: ps.brightness ?? 1,
    saturation: ps.saturation ?? 1,
    contrast:   ps.contrast   ?? 1,
    blackPoint: ps.blackPoint ?? 0,
    whitePoint: ps.whitePoint ?? 1,
  };
}

function hasElementOverride(el: PrintElement, forBack: boolean): boolean {
  return forBack
    ? el.backBrightness !== undefined || el.backSaturation !== undefined ||
      el.backContrast !== undefined || el.backBlackPoint !== undefined || el.backWhitePoint !== undefined
    : el.brightness !== undefined || el.saturation !== undefined ||
      el.contrast !== undefined || el.blackPoint !== undefined || el.whitePoint !== undefined;
}

function getEffectiveAdj(el: PrintElement | null, ps: PageSettings = page, forBack = view === "back"): Adj {
  const sheet = getAdj(ps, forBack);
  if (!el || !hasElementOverride(el, forBack)) return sheet;
  return forBack ? {
    brightness: el.backBrightness ?? sheet.brightness,
    saturation: el.backSaturation ?? sheet.saturation,
    contrast:   el.backContrast   ?? sheet.contrast,
    blackPoint: el.backBlackPoint ?? sheet.blackPoint,
    whitePoint: el.backWhitePoint ?? sheet.whitePoint,
  } : {
    brightness: el.brightness ?? sheet.brightness,
    saturation: el.saturation ?? sheet.saturation,
    contrast:   el.contrast   ?? sheet.contrast,
    blackPoint: el.blackPoint ?? sheet.blackPoint,
    whitePoint: el.whitePoint ?? sheet.whitePoint,
  };
}

function selectedElement(): PrintElement | null {
  return selectedId ? (elements.find((e) => e.id === selectedId) ?? null) : null;
}

function applyZoom(): void {
  const canvas = document.getElementById("page-canvas")!;
  canvas.style.zoom = String(zoomLevel);
  (document.getElementById("zoom-val") as HTMLInputElement).value = String(Math.round(zoomLevel * 100));
}

function stepZoom(delta: number): void {
  zoomLevel = Math.max(0.25, Math.min(4, Math.round((zoomLevel + delta) * 20) / 20));
  applyZoom();
}

// Builds an SVG data URL with a filter injected that targets only <image> elements.
// Vector elements (paths, text, borders) are unaffected.
// For non-SVG src, returns the src unchanged — CSS filter handles it.
function uid(): string {
  return `el-${nextId++}`;
}

function getEffectiveBleed(
  el: PrintElement,
  ps: PageSettings = page,
  forBack = view === "back",
): { bleedIn: number; color: string } {
  return {
    bleedIn: el.bleedIn ?? ps.bleedIn ?? 0,
    color: forBack
      ? el.backBorderColor ?? ps.backBorderColor ?? el.borderColor ?? ps.borderColor ?? "#000000"
      : el.borderColor ?? ps.borderColor ?? "#000000",
  };
}

function hexToRgbTriplet(hex: string): [number, number, number] {
  const normalized = hex.trim().replace(/^#/, "");
  const full = normalized.length === 3
    ? normalized.split("").map((c) => c + c).join("")
    : normalized;
  const safe = /^[0-9a-fA-F]{6}$/.test(full) ? full : "000000";
  return [
    parseInt(safe.slice(0, 2), 16) / 255,
    parseInt(safe.slice(2, 4), 16) / 255,
    parseInt(safe.slice(4, 6), 16) / 255,
  ];
}

function bytesToDataUrl(bytes: Uint8Array, filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "svg") {
    return `data:image/svg+xml,${encodeURIComponent(new TextDecoder().decode(bytes))}`;
  }
  const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" } as Record<string, string>)[ext] ?? "image/png";
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}

async function sampleEdgeColor(src: string | null, edge: "top" | "bottom" | "left" | "right"): Promise<string | null> {
  if (!src) return null;
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); img.src = src; });
  if (!img.naturalWidth || !img.naturalHeight) return null;

  const sampleW = Math.min(64, img.naturalWidth);
  const sampleH = Math.min(64, img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = sampleW;
  canvas.height = sampleH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, sampleW, sampleH);
  const { data } = ctx.getImageData(0, 0, sampleW, sampleH);

  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < sampleH; y++) {
    for (let x = 0; x < sampleW; x++) {
      const matches = edge === "top"
        ? y === 0
        : edge === "bottom"
          ? y === sampleH - 1
          : edge === "left"
            ? x === 0
            : x === sampleW - 1;
      if (!matches) continue;
      const i = (y * sampleW + x) * 4;
      if (data[i + 3] < 32) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  if (!n) return null;
  const toHex = (v: number) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function render(): void {
  renderSidebar();
  renderCanvas();
  renderFontList();
  loadBorderUI();
  updateReconnectBtn();
  saveState({ elements, pages, currentPageIndex, nextId, importedFonts });
}

function renderSidebar(): void {
  const list = document.getElementById("element-list")!;
  list.innerHTML = "";

  const visibleEls = pageElements();
  if (visibleEls.length === 0) {
    list.innerHTML = `<p class="text-xs text-slate-500 text-center py-4">No elements on this sheet.<br/>Import or add one above.</p>`;
    return;
  }

  for (const el of visibleEls) {
    const sel = el.id === selectedId;
    const div = document.createElement("div");
    div.className = `p-3 rounded-xl border mb-3 cursor-pointer transition-all ${
      sel ? "border-amber-500 bg-slate-700" : "border-slate-600 bg-slate-800 hover:border-slate-500"
    }`;
    div.innerHTML = `
      <div class="flex items-center gap-2 mb-2">
        <input class="el-name bg-transparent text-sm font-bold text-white flex-1 outline-none border-b border-transparent focus:border-amber-500 min-w-0"
          value="${escapeHtml(el.name)}" data-id="${el.id}" />
        <button class="el-delete shrink-0 text-slate-400 hover:text-red-400 text-lg leading-none" data-id="${el.id}">×</button>
      </div>
      <div class="flex gap-2 mb-3">
        <label class="text-xs text-slate-400 flex items-center gap-1 flex-1">
          W<input class="el-w w-full bg-slate-700 rounded px-1 py-0.5 text-xs text-white outline-none focus:ring-1 ring-amber-500"
            type="number" min="0.25" max="20" step="0.25" value="${el.widthIn}" data-id="${el.id}" />"
        </label>
        <label class="text-xs text-slate-400 flex items-center gap-1 flex-1">
          H<input class="el-h w-full bg-slate-700 rounded px-1 py-0.5 text-xs text-white outline-none focus:ring-1 ring-amber-500"
            type="number" min="0.25" max="20" step="0.25" value="${el.heightIn}" data-id="${el.id}" />"
        </label>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div>
          <div class="text-[10px] text-slate-400 uppercase font-bold mb-1">Front</div>
          ${imgSlot(el.frontSrc, el.id, "front")}
        </div>
        <div>
          <div class="text-[10px] text-slate-400 uppercase font-bold mb-1">Back</div>
          ${imgSlot(el.backSrc, el.id, "back")}
        </div>
      </div>
      <div class="flex gap-1 mt-2">
        <button class="el-rot-l flex-1 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded text-sm text-slate-300 font-black transition-all" data-id="${el.id}" title="Rotate left 90°">↺</button>
        <button class="el-rot-r flex-1 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded text-sm text-slate-300 font-black transition-all" data-id="${el.id}" title="Rotate right 90°">↻</button>
        ${el.frontSrc ? `<button class="el-fit flex-1 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded text-[10px] text-slate-300 font-black uppercase tracking-wide transition-all" data-id="${el.id}" title="Fit element size to image aspect ratio">⊡ Fit</button>` : ""}
      </div>
      <div class="grid grid-cols-2 gap-2 mt-2">
        <div class="space-y-1 min-w-0">
          <label class="text-xs text-slate-400 flex items-center gap-1">
            Bleed
            <input class="el-border-w w-full min-w-0 bg-slate-700 rounded px-1 py-0.5 text-xs text-white outline-none focus:ring-1 ring-amber-500"
              type="number" min="0" max="0.5" step="0.005" value="${el.bleedIn ?? 0}" data-id="${el.id}" />
          </label>
          <div class="flex items-center gap-1 min-w-0">
            <span class="text-[10px] text-slate-500 uppercase">F</span>
            <input class="el-border-color h-7 w-10 rounded border border-slate-600 bg-slate-700" type="color"
              value="${el.borderColor ?? page.borderColor ?? "#000000"}" data-id="${el.id}" data-side="front" title="Front border color" />
          </div>
          <div class="grid grid-cols-4 gap-0.5">
            <button class="el-border-sample px-1 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded text-[10px] text-slate-300 font-black uppercase"
              data-id="${el.id}" data-side="front" data-edge="top" title="Sample front top edge">T</button>
            <button class="el-border-sample px-1 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded text-[10px] text-slate-300 font-black uppercase"
              data-id="${el.id}" data-side="front" data-edge="bottom" title="Sample front bottom edge">B</button>
            <button class="el-border-sample px-1 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded text-[10px] text-slate-300 font-black uppercase"
              data-id="${el.id}" data-side="front" data-edge="left" title="Sample front left edge">L</button>
            <button class="el-border-sample px-1 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded text-[10px] text-slate-300 font-black uppercase"
              data-id="${el.id}" data-side="front" data-edge="right" title="Sample front right edge">R</button>
          </div>
        </div>
        <div class="space-y-1 min-w-0">
          <div class="text-xs text-slate-400">&nbsp;</div>
          <div class="flex items-center gap-1 min-w-0">
            <span class="text-[10px] text-slate-500 uppercase">B</span>
            <input class="el-border-color h-7 w-10 rounded border border-slate-600 bg-slate-700" type="color"
              value="${el.backBorderColor ?? el.borderColor ?? page.backBorderColor ?? page.borderColor ?? "#000000"}" data-id="${el.id}" data-side="back" title="Back border color" />
          </div>
          <div class="grid grid-cols-4 gap-0.5">
            <button class="el-border-sample px-1 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded text-[10px] text-slate-300 font-black uppercase"
              data-id="${el.id}" data-side="back" data-edge="top" title="Sample back top edge">T</button>
            <button class="el-border-sample px-1 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded text-[10px] text-slate-300 font-black uppercase"
              data-id="${el.id}" data-side="back" data-edge="bottom" title="Sample back bottom edge">B</button>
            <button class="el-border-sample px-1 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded text-[10px] text-slate-300 font-black uppercase"
              data-id="${el.id}" data-side="back" data-edge="left" title="Sample back left edge">L</button>
            <button class="el-border-sample px-1 py-1 bg-slate-700 hover:bg-slate-600 border border-slate-600 rounded text-[10px] text-slate-300 font-black uppercase"
              data-id="${el.id}" data-side="back" data-edge="right" title="Sample back right edge">R</button>
          </div>
        </div>
      </div>
    `;
    div.addEventListener("click", () => { selectedId = el.id; render(); loadAdjustmentUI(); });
    list.appendChild(div);
  }

  attachSidebarEvents();
}

function imgSlot(src: string | null, id: string, side: "front" | "back"): string {
  if (src) {
    return `
      <div class="relative group">
        <img src="${src}" class="w-full aspect-[5/7] object-cover rounded border border-slate-600 block" />
        <button class="el-clear absolute top-0 right-0 bg-red-600 text-white text-[10px] font-bold rounded-bl px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
          data-id="${id}" data-side="${side}">×</button>
      </div>`;
  }
  return `
    <button class="el-upload flex items-center justify-center w-full aspect-[5/7] border-2 border-dashed border-slate-600 hover:border-amber-500 rounded cursor-pointer transition-colors text-center"
      data-id="${id}" data-side="${side}">
      <span class="text-slate-500 text-[10px] leading-tight px-1 pointer-events-none">Click or<br/>drop image</span>
    </button>`;
}

function attachSidebarEvents(): void {
  document.querySelectorAll<HTMLInputElement>(".el-name").forEach((inp) => {
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("change", () => {
      const el = elements.find((x) => x.id === inp.dataset.id);
      if (el) { el.name = inp.value; render(); }
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".el-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id!;
      elements = elements.filter((x) => x.id !== id);
      void deleteHandle(id, "front");
      void deleteHandle(id, "back");
      if (selectedId === id) selectedId = null;
      render();
    });
  });

  document.querySelectorAll<HTMLInputElement>(".el-w").forEach((inp) => {
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("change", () => {
      const el = elements.find((x) => x.id === inp.dataset.id);
      if (el) { el.widthIn = Math.max(0.25, parseFloat(inp.value) || 2.5); render(); }
    });
  });

  document.querySelectorAll<HTMLInputElement>(".el-h").forEach((inp) => {
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("change", () => {
      const el = elements.find((x) => x.id === inp.dataset.id);
      if (el) { el.heightIn = Math.max(0.25, parseFloat(inp.value) || 3.5); render(); }
    });
  });

  document.querySelectorAll<HTMLInputElement>(".el-border-w").forEach((inp) => {
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("change", async () => {
      const el = elements.find((x) => x.id === inp.dataset.id);
      if (el) {
        const prev = el.bleedIn ?? 0;
        el.bleedIn = Math.max(0, parseFloat(inp.value) || 0);
        if (prev <= 0 && el.bleedIn > 0) {
          if (!el.borderColor) el.borderColor = await sampleEdgeColor(el.frontSrc, "left") ?? page.borderColor ?? "#000000";
          if (!el.backBorderColor) el.backBorderColor = await sampleEdgeColor(el.backSrc, "left") ?? page.backBorderColor ?? el.borderColor ?? page.borderColor ?? "#000000";
        }
        render();
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>(".el-border-color").forEach((inp) => {
    inp.addEventListener("click", (e) => e.stopPropagation());
    inp.addEventListener("input", () => {
      const el = elements.find((x) => x.id === inp.dataset.id);
      if (el) {
        if (inp.dataset.side === "back") el.backBorderColor = inp.value;
        else el.borderColor = inp.value;
        render();
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".el-border-sample").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const el = elements.find((x) => x.id === btn.dataset.id);
      if (!el) return;
      const side = btn.dataset.side as "front" | "back";
      const edge = btn.dataset.edge as "top" | "bottom" | "left" | "right";
      const sampled = await sampleEdgeColor(side === "back" ? el.backSrc : el.frontSrc, edge);
      if (!sampled) return;
      if (side === "back") el.backBorderColor = sampled;
      else el.borderColor = sampled;
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".el-upload").forEach((btn) => {
    const id = btn.dataset.id!;
    const side = btn.dataset.side as "front" | "back";

    btn.addEventListener("click", (e) => { e.stopPropagation(); pickFile(id, side); });
    btn.addEventListener("dragover", (e) => { e.preventDefault(); btn.classList.add("!border-amber-500"); });
    btn.addEventListener("dragleave", () => btn.classList.remove("!border-amber-500"));
    btn.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.classList.remove("!border-amber-500");
      const f = e.dataTransfer?.files[0];
      if (f) loadImage(id, side, f);
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".el-clear").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const el = elements.find((x) => x.id === btn.dataset.id);
      if (!el) return;
      if (btn.dataset.side === "front") el.frontSrc = null;
      else el.backSrc = null;
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".el-rot-l, .el-rot-r").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const el = elements.find((x) => x.id === btn.dataset.id);
      if (!el) return;
      const delta = btn.classList.contains("el-rot-r") ? 90 : 270;
      el.rotation = (((el.rotation ?? 0) + delta) % 360) as 0 | 90 | 180 | 270;
      // Swap dimensions on 90/270 so the footprint on the page is correct
      [el.widthIn, el.heightIn] = [el.heightIn, el.widthIn];
      render();
    });
  });

  document.querySelectorAll<HTMLButtonElement>(".el-fit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      fitElementToImage(btn.dataset.id!);
    });
  });
}

async function fitElementToImage(id: string): Promise<void> {
  const el = elements.find((x) => x.id === id);
  if (!el || !el.frontSrc) return;
  const isSvg = el.frontSrc.startsWith("data:image/svg");
  let nw: number, nh: number;
  if (isSvg) {
    ({ w: nw, h: nh } = svgNaturalDims(el.frontSrc));
  } else {
    const img = new Image();
    await new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); img.src = el.frontSrc!; });
    nw = img.naturalWidth; nh = img.naturalHeight;
  }
  if (!nw || !nh) return;
  const rot = el.rotation ?? 0;
  // For 90/270, the image displays transposed, so aspect ratio is inverted
  if (rot === 0 || rot === 180) {
    el.heightIn = Math.round((el.widthIn * nh / nw) * 100) / 100;
  } else {
    el.heightIn = Math.round((el.widthIn * nw / nh) * 100) / 100;
  }
  render();
}

function renderCanvas(): void {
  const canvas = document.getElementById("page-canvas")!;
  const pw = page.widthIn * DISPLAY_PPI;
  const ph = page.heightIn * DISPLAY_PPI;
  canvas.style.width = pw + "px";
  canvas.style.height = ph + "px";
  canvas.innerHTML = "";

  const visibleEls = pageElements();
  if (visibleEls.length === 0) {
    canvas.innerHTML = `<div class="absolute inset-0 flex items-center justify-center text-slate-300/30 text-sm font-bold uppercase pointer-events-none select-none">Add elements to begin</div>`;
    return;
  }

  for (const el of visibleEls) {
    const forBack = view === "back";
    const pos = forBack ? backPos(el, page) : { x: el.x, y: el.y };
    const src = forBack ? el.backSrc : el.frontSrc;
    const isSel = el.id === selectedId;
    const bleed = getEffectiveBleed(el, page, forBack);
    const b = bleed.bleedIn;
    const bPx = b * DISPLAY_PPI;
    const cW = el.widthIn * DISPLAY_PPI;
    const cH = el.heightIn * DISPLAY_PPI;

    const div = document.createElement("div");
    div.className = "absolute transition-colors";
    div.style.cssText = `
      left:${(pos.x - b) * DISPLAY_PPI}px;
      top:${(pos.y - b) * DISPLAY_PPI}px;
      width:${(el.widthIn + 2 * b) * DISPLAY_PPI}px;
      height:${(el.heightIn + 2 * b) * DISPLAY_PPI}px;
      background:${b > 0 ? bleed.color : "transparent"};
      cursor:${view === "front" ? "grab" : "default"};
      outline:2px solid ${isSel ? "#f59e0b" : "rgba(148,163,184,0.4)"};
      outline-offset:0;
      ${isSel ? "box-shadow:0 10px 20px rgba(0,0,0,0.25);" : ""}
    `;
    div.addEventListener("mouseenter", () => {
      if (el.id !== selectedId) div.style.outlineColor = "rgba(252,211,77,0.6)";
    });
    div.addEventListener("mouseleave", () => {
      if (el.id !== selectedId) div.style.outlineColor = "rgba(148,163,184,0.4)";
    });

    // Inner div contains the card image, offset by bleed
    const contentDiv = document.createElement("div");
    contentDiv.style.cssText = `position:absolute;left:${bPx}px;top:${bPx}px;width:${cW}px;height:${cH}px;overflow:hidden;`;

    if (src) {
      const isSvg = src.startsWith("data:image/svg");
      const elAdj = getEffectiveAdj(el, page, forBack);
      const displaySrc = isSvg ? buildAdjustedSrc(src, elAdj) : src;
      const filter = !isSvg ? printFilter(elAdj) : "";
      const rot = el.rotation ?? 0;
      if (rot === 90 || rot === 270) {
        const inner = document.createElement("div");
        inner.style.cssText = [
          `position:absolute`,
          `width:${cH}px`, `height:${cW}px`,
          `top:${(cH - cW) / 2}px`, `left:${(cW - cH) / 2}px`,
          `background-image:url(${JSON.stringify(displaySrc)})`,
          `background-size:100% 100%`,
          `transform:rotate(${rot}deg)`,
          `transform-origin:center`,
          filter ? `filter:${filter}` : "",
        ].filter(Boolean).join(";");
        contentDiv.appendChild(inner);
      } else {
        contentDiv.style.backgroundImage = `url(${JSON.stringify(displaySrc)})`;
        contentDiv.style.backgroundSize = "100% 100%";
        if (rot === 180) contentDiv.style.transform = "rotate(180deg)";
        if (filter) contentDiv.style.filter = filter;
      }
    } else {
      contentDiv.style.background = "#f1f5f9";
      const label = document.createElement("div");
      label.className = "absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none";
      label.innerHTML = `
        <span class="text-slate-400 text-xs font-bold text-center px-1 leading-tight">${escapeHtml(el.name)}</span>
        <span class="text-slate-300/60 text-[10px] uppercase mt-0.5">${view === "front" ? "front" : "back"}</span>`;
      contentDiv.appendChild(label);
    }
    div.appendChild(contentDiv);

    if (view === "front") {
      div.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectedId = el.id;
        drag = { id: el.id, startMouseX: e.clientX, startMouseY: e.clientY, startElX: el.x, startElY: el.y };
        div.style.cursor = "grabbing";
        renderSidebar();
        loadAdjustmentUI();
      });
    } else {
      div.addEventListener("click", () => {
        selectedId = el.id;
        renderSidebar();
        loadAdjustmentUI();
      });
    }

    canvas.appendChild(div);
  }

  // Draw cut guides on top
  const { xs, ys } = getGuideLines(visibleEls, view === "back", page);
  for (const x of xs) {
    const line = document.createElement("div");
    line.style.cssText = `position:absolute;left:${x * DISPLAY_PPI - 2.5}px;top:0;width:5px;height:${ph}px;background:rgba(120,120,120,0.55);pointer-events:none;`;
    canvas.appendChild(line);
  }
  for (const y of ys) {
    const line = document.createElement("div");
    line.style.cssText = `position:absolute;top:${y * DISPLAY_PPI - 2.5}px;left:0;height:5px;width:${pw}px;background:rgba(120,120,120,0.55);pointer-events:none;`;
    canvas.appendChild(line);
  }
}

function getGuideLines(
  elems = pageElements(),
  forBack = false,
  ps: PageSettings = page,
): { xs: number[]; ys: number[] } {
  const xs = new Set<number>();
  const ys = new Set<number>();
  for (const el of elems) {
    const pos = forBack ? backPos(el, ps) : { x: el.x, y: el.y };
    const b = getEffectiveBleed(el, ps, forBack).bleedIn;
    xs.add(pos.x - b);
    xs.add(pos.x + el.widthIn + b);
    ys.add(pos.y - b);
    ys.add(pos.y + el.heightIn + b);
  }
  // Exclude page edges — those are the paper boundary, not cut lines
  xs.delete(0); xs.delete(ps.widthIn);
  ys.delete(0); ys.delete(ps.heightIn);
  return { xs: [...xs].sort((a, b) => a - b), ys: [...ys].sort((a, b) => a - b) };
}

// ─── Snapping ─────────────────────────────────────────────────────────────────

function computeSnap(el: PrintElement, rawX: number, rawY: number): { x: number; y: number; lines: SnapLine[] } {
  const T = SNAP_THRESHOLD_IN;
  const others = pageElements().filter((o) => o.id !== el.id);
  const lines: SnapLine[] = [];
  const b = getEffectiveBleed(el, page, view === "back").bleedIn;

  // Snap targets: page edges + bleed outer edges of other elements
  const xTargets: number[] = [0, page.widthIn];
  const yTargets: number[] = [0, page.heightIn];
  for (const o of others) {
    const ob = getEffectiveBleed(o, page, view === "back").bleedIn;
    xTargets.push(o.x - ob, o.x + o.widthIn + ob);
    yTargets.push(o.y - ob, o.y + o.heightIn + ob);
  }

  // Dragged element bleed outer edges: [left-outer, right-outer]
  const dragEdgesX = [rawX - b, rawX + el.widthIn + b];
  const dragEdgesY = [rawY - b, rawY + el.heightIn + b];

  let snapX: number | null = null;
  let snapY: number | null = null;
  let bestDX = T;
  let bestDY = T;

  for (const t of xTargets) {
    for (let i = 0; i < dragEdgesX.length; i++) {
      const d = Math.abs(dragEdgesX[i] - t);
      if (d < bestDX) { bestDX = d; snapX = i === 0 ? t + b : t - el.widthIn - b; }
    }
  }
  for (const t of yTargets) {
    for (let i = 0; i < dragEdgesY.length; i++) {
      const d = Math.abs(dragEdgesY[i] - t);
      if (d < bestDY) { bestDY = d; snapY = i === 0 ? t + b : t - el.heightIn - b; }
    }
  }

  const x = clamp(snapX ?? rawX, 0, page.widthIn - el.widthIn);
  const y = clamp(snapY ?? rawY, 0, page.heightIn - el.heightIn);

  // Show snap lines at the bleed outer edge that triggered the snap
  if (snapX !== null) lines.push({ axis: "x", pos: clamp(snapX - b, 0, page.widthIn) });
  if (snapY !== null) lines.push({ axis: "y", pos: clamp(snapY - b, 0, page.heightIn) });

  return { x, y, lines };
}

let activeSnapLines: SnapLine[] = [];

function renderSnapLines(): void {
  document.querySelectorAll(".snap-line").forEach((el) => el.remove());
  const canvas = document.getElementById("page-canvas")!;
  for (const line of activeSnapLines) {
    const div = document.createElement("div");
    div.className = "snap-line absolute pointer-events-none";
    div.style.background = "#f59e0b";
    div.style.opacity = "0.8";
    if (line.axis === "x") {
      div.style.cssText += `left:${line.pos * DISPLAY_PPI}px;top:0;width:1px;height:${page.heightIn * DISPLAY_PPI}px;`;
    } else {
      div.style.cssText += `top:${line.pos * DISPLAY_PPI}px;left:0;height:1px;width:${page.widthIn * DISPLAY_PPI}px;`;
    }
    canvas.appendChild(div);
  }
}

// ─── Auto layout ──────────────────────────────────────────────────────────────

function autoLayout(): void {
  const elems = pageElements();
  if (elems.length === 0) return;

  // 1. Pack elements into rows using page width as the only hard constraint.
  // Slot size = card + 2×bleed on each axis.
  const slotW = (el: PrintElement) => el.widthIn  + 2 * (el.bleedIn ?? page.bleedIn ?? 0);
  const slotH = (el: PrintElement) => el.heightIn + 2 * (el.bleedIn ?? page.bleedIn ?? 0);

  const rows: PrintElement[][] = [];
  let row: PrintElement[] = [];
  let rowW = 0;

  for (const el of elems) {
    const sw = slotW(el);
    const needed = row.length > 0 ? rowW + sw : sw;
    if (row.length > 0 && needed > page.widthIn) {
      rows.push(row);
      row = [el];
      rowW = sw;
    } else {
      row.push(el);
      rowW = needed;
    }
  }
  if (row.length > 0) rows.push(row);

  // 2. Row heights and widths (using slot sizes)
  const rowHeights = rows.map((r) => Math.max(...r.map(slotH)));
  const rowWidths  = rows.map((r) => r.reduce((a, el) => a + slotW(el), 0));

  // 3. Split rows into sheets when cumulative height exceeds available height
  const m = AUTO_MARGIN_IN;
  const availH = page.heightIn - 2 * m;
  const availW = page.widthIn  - 2 * m;

  type Sheet = { rows: PrintElement[][]; heights: number[]; widths: number[] };
  const sheets: Sheet[] = [{ rows: [], heights: [], widths: [] }];
  let sheetH = 0;
  for (let r = 0; r < rows.length; r++) {
    const rh = rowHeights[r];
    if (sheets[sheets.length - 1].rows.length > 0 && sheetH + rh > availH) {
      sheets.push({ rows: [], heights: [], widths: [] });
      sheetH = 0;
    }
    const s = sheets[sheets.length - 1];
    s.rows.push(rows[r]); s.heights.push(rh); s.widths.push(rowWidths[r]);
    sheetH += rh;
  }

  // 4. Create pages for overflow sheets if needed
  while (currentPageIndex + sheets.length > pages.length) {
    pages.push({ ...page });
    globalBackSrcs.push(null);
  }

  // 5. Position elements — each sheet centered independently
  for (let si = 0; si < sheets.length; si++) {
    const pi = currentPageIndex + si;
    const ps = pages[pi];
    const psSlotW = (el: PrintElement) => el.widthIn  + 2 * (el.bleedIn ?? ps.bleedIn ?? 0);
    const psSlotH = (el: PrintElement) => el.heightIn + 2 * (el.bleedIn ?? ps.bleedIn ?? 0);
    const sAvailW = ps.widthIn  - 2 * m;
    const sAvailH = ps.heightIn - 2 * m;
    const { rows: sRows, heights: sHeights, widths: sWidths } = sheets[si];
    const totalH    = sHeights.reduce((a, b) => a + b, 0);
    const startY      = m + Math.max(0, (sAvailH - totalH)) / 2;
    let y = startY;
    for (let r = 0; r < sRows.length; r++) {
      const rowEls = sRows[r];
      const rowH   = sHeights[r];
      const rowStartX = m + Math.max(0, (sAvailW - sWidths[r])) / 2;
      let x = rowStartX;
      for (const el of rowEls) {
        const b = el.bleedIn ?? ps.bleedIn ?? 0;
        const sh = psSlotH(el);
        el.x = x + b;
        el.y = y + (rowH - sh) / 2 + b;
        el.pageIndex = pi;
        x += psSlotW(el);
      }
      y += rowH;
    }
  }

  renderPageTabs();
  render();
}

// ─── Global drag handlers ─────────────────────────────────────────────────────

document.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const el = elements.find((x) => x.id === drag!.id);
  if (!el) return;
  const dx = (e.clientX - drag.startMouseX) / DISPLAY_PPI;
  const dy = (e.clientY - drag.startMouseY) / DISPLAY_PPI;
  const rawX = clamp(drag.startElX + dx, 0, page.widthIn - el.widthIn);
  const rawY = clamp(drag.startElY + dy, 0, page.heightIn - el.heightIn);
  const snapped = computeSnap(el, rawX, rawY);
  el.x = snapped.x;
  el.y = snapped.y;
  activeSnapLines = snapped.lines;
  renderCanvas();
  renderSnapLines();
});

document.addEventListener("mouseup", () => { drag = null; activeSnapLines = []; renderSnapLines(); });

// ─── Image loading ────────────────────────────────────────────────────────────

function loadImage(id: string, side: "front" | "back", file: File): void {
  void loadFileIntoElement(elements, id, side, file).then((loaded) => {
    if (!loaded) return;
    render();
    updateReconnectBtn();
  });
}

function isImageFile(f: File): boolean {
  return f.type.startsWith("image/") || /\.(png|jpe?g|webp|svg)$/i.test(f.name);
}

function isImageFilePath(path: string): boolean {
  return /\.(png|jpe?g|webp|svg)$/i.test(path);
}

function isFontFilePath(path: string): boolean {
  return /\.(ttf|otf|woff2?)$/i.test(path);
}

function fontFormatForPath(path: string): ImportedFont["format"] {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "otf") return "opentype";
  if (ext === "woff") return "woff";
  if (ext === "woff2") return "woff2";
  return "truetype";
}

function fontMimeForFormat(format: ImportedFont["format"]): string {
  return ({
    truetype: "font/ttf",
    opentype: "font/otf",
    woff: "font/woff",
    woff2: "font/woff2",
  } as Record<ImportedFont["format"], string>)[format];
}

function bytesToFontDataUrl(bytes: Uint8Array, format: ImportedFont["format"]): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:${fontMimeForFormat(format)};base64,${btoa(bin)}`;
}

function refreshSvgFonts(): void {
  setImportedFonts(importedFonts);
  for (const el of elements) {
    if (el.frontSrc?.startsWith("data:image/svg")) el.frontSrc = patchSvgStretch(el.frontSrc);
    if (el.backSrc?.startsWith("data:image/svg")) el.backSrc = patchSvgStretch(el.backSrc);
  }
  for (let i = 0; i < globalBackSrcs.length; i++) {
    const src = globalBackSrcs[i];
    if (!src?.startsWith("data:image/svg")) continue;
    globalBackSrcs[i] = patchSvgStretch(src);
    for (const el of elements) {
      if (el.pageIndex === i && (!el.backSrc || el.backSrc.startsWith("data:image/svg"))) {
        el.backSrc = globalBackSrcs[i];
      }
    }
  }
}

async function readImportedFontPath(path: string): Promise<ImportedFont> {
  const format = fontFormatForPath(path);
  const sourceName = basename(path);
  return {
    id: uid(),
    family: sourceName.replace(/\.[^.]+$/, ""),
    sourceName,
    format,
    src: bytesToFontDataUrl(await readBinaryPath(path), format),
  };
}

async function importFonts(): Promise<void> {
  let fonts: ImportedFont[] = [];
  if (isDesktopApp()) {
    const paths = (await openFontPaths(true)).filter(isFontFilePath);
    if (paths.length === 0) return;
    fonts = await Promise.all(paths.map(readImportedFontPath));
  } else {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2";
    fonts = await new Promise<ImportedFont[]>((resolve) => {
      input.onchange = async () => {
        const files = Array.from(input.files ?? []);
        const loaded = await Promise.all(files.map(async (file) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const format = fontFormatForPath(file.name);
          return {
            id: uid(),
            family: file.name.replace(/\.[^.]+$/, ""),
            sourceName: file.name,
            format,
            src: bytesToFontDataUrl(bytes, format),
          } satisfies ImportedFont;
        }));
        resolve(loaded);
      };
      input.click();
    });
  }
  if (fonts.length === 0) return;
  const merged = new Map<string, ImportedFont>();
  for (const font of importedFonts) merged.set(`${font.family}::${font.sourceName}`, font);
  for (const font of fonts) merged.set(`${font.family}::${font.sourceName}`, font);
  importedFonts = Array.from(merged.values()).sort((a, b) => a.family.localeCompare(b.family));
  refreshSvgFonts();
  render();
}

function renderFontList(): void {
  const container = document.getElementById("font-list");
  if (!container) return;
  if (importedFonts.length === 0) {
    container.innerHTML = `<div class="text-[10px] text-slate-500 border border-slate-700 rounded-lg px-2 py-2">No imported fonts.</div>`;
    return;
  }
  container.innerHTML = importedFonts.map((font) => `
    <div class="border border-slate-700 rounded-lg px-2 py-2 bg-slate-800/70">
      <div class="text-xs text-white font-bold truncate">${escapeHtml(font.family)}</div>
      <div class="text-[10px] text-slate-500 truncate">${escapeHtml(font.sourceName)}</div>
    </div>
  `).join("");
}

// Computes the best-fit element size for an image.
// - Raster: derives physical size at 300 DPI, then scales to fit with margins.
// - SVG: uses aspect ratio only (resolution-independent), fits to page.
// Picks the orientation (portrait vs 90° landscape) that occupies the most page area.
type ImportSizeMode = { mode: "actual" } | { mode: "fixed"; widthIn: number; heightIn: number };

function promptImportSize(): Promise<ImportSizeMode | null> {
  return new Promise((resolve) => {
    const dialog = document.getElementById("import-size-dialog")!;
    const fixedFields = document.getElementById("isd-fixed-fields")!;
    const radios = dialog.querySelectorAll<HTMLInputElement>("input[name='import-size-mode']");

    function updateFixed(): void {
      const isFixed = (dialog.querySelector<HTMLInputElement>("#isd-fixed") as HTMLInputElement).checked;
      fixedFields.style.opacity = isFixed ? "1" : "0.4";
      fixedFields.style.pointerEvents = isFixed ? "auto" : "none";
    }
    radios.forEach((r) => r.addEventListener("change", updateFixed));
    updateFixed();

    dialog.style.display = "flex";

    function cleanup(): void {
      dialog.style.display = "none";
      radios.forEach((r) => r.removeEventListener("change", updateFixed));
      document.getElementById("isd-ok")!.removeEventListener("click", onOk);
      document.getElementById("isd-cancel")!.removeEventListener("click", onCancel);
    }
    function onOk(): void {
      const isFixed = (dialog.querySelector<HTMLInputElement>("#isd-fixed") as HTMLInputElement).checked;
      cleanup();
      if (isFixed) {
        const w = parseFloat((document.getElementById("isd-w") as HTMLInputElement).value) || 2.5;
        const h = parseFloat((document.getElementById("isd-h") as HTMLInputElement).value) || 3.5;
        resolve({ mode: "fixed", widthIn: w, heightIn: h });
      } else {
        resolve({ mode: "actual" });
      }
    }
    function onCancel(): void { cleanup(); resolve(null); }
    document.getElementById("isd-ok")!.addEventListener("click", onOk);
    document.getElementById("isd-cancel")!.addEventListener("click", onCancel);
  });
}

async function readImageFile(
  file: File,
  sizeMode: ImportSizeMode = { mode: "actual" },
): Promise<{
  name: string; src: string; widthIn: number; heightIn: number; rotation: 0 | 90 | 180 | 270;
}> {
  const src = await new Promise<string>((res) => {
    const reader = new FileReader();
    reader.onload = () => res(patchSvgStretch(reader.result as string));
    reader.readAsDataURL(file);
  });
  let widthIn: number, heightIn: number, rotation: 0 | 90 | 180 | 270;
  if (sizeMode.mode === "fixed") {
    widthIn = sizeMode.widthIn; heightIn = sizeMode.heightIn; rotation = 0;
  } else {
    const isSvg = src.startsWith("data:image/svg");
    let nw = 0, nh = 0;
    if (isSvg) {
      ({ w: nw, h: nh } = svgNaturalDims(src));
    } else {
      const img = new Image();
      await new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); img.src = src; });
      nw = img.naturalWidth; nh = img.naturalHeight;
    }
    ({ widthIn, heightIn, rotation } = computeAutoSize(nw, nh, isSvg, page));
  }
  return { name: file.name.replace(/\.[^.]+$/, ""), src, widthIn, heightIn, rotation };
}

async function readImagePath(
  path: string,
  sizeMode: ImportSizeMode = { mode: "actual" },
): Promise<{
  name: string; src: string; widthIn: number; heightIn: number; rotation: 0 | 90 | 180 | 270;
}> {
  const src = patchSvgStretch(bytesToDataUrl(await readBinaryPath(path), basename(path)));
  let widthIn: number, heightIn: number, rotation: 0 | 90 | 180 | 270;
  if (sizeMode.mode === "fixed") {
    widthIn = sizeMode.widthIn; heightIn = sizeMode.heightIn; rotation = 0;
  } else {
    const isSvg = src.startsWith("data:image/svg");
    let nw = 0, nh = 0;
    if (isSvg) {
      ({ w: nw, h: nh } = svgNaturalDims(src));
    } else {
      const img = new Image();
      await new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); img.src = src; });
      nw = img.naturalWidth; nh = img.naturalHeight;
    }
    ({ widthIn, heightIn, rotation } = computeAutoSize(nw, nh, isSvg, page));
  }
  return { name: basename(path).replace(/\.[^.]+$/, ""), src, widthIn, heightIn, rotation };
}

function switchToFront(): void {
  if (view !== "front") { view = "front"; updateViewBtns(); loadAdjustmentUI(); }
}

async function importFromFiles(files: FileList | File[]): Promise<void> {
  const arr = Array.from(files).filter(isImageFile);
  if (arr.length === 0) return;
  const sizeMode = await promptImportSize();
  if (!sizeMode) return;
  const loaded = await Promise.all(arr.map((f) => readImageFile(f, sizeMode)));
  for (const { name, src, widthIn, heightIn, rotation } of loaded) {
    const id = uid();
    elements.push({ id, name, widthIn, heightIn, frontSrc: src, backSrc: null, x: 0, y: 0, pageIndex: currentPageIndex, rotation });
    await saveCachedImageData(id, "front", src);
  }
  switchToFront();
  switchTab("elements");
  autoLayout();
}

async function batchPickFiles(): Promise<void> {
  if (isDesktopApp()) {
    try {
      const paths = await openImagePaths(true);
      if (paths.length === 0) return;
      const sizeMode = await promptImportSize();
      if (!sizeMode) return;
      const storedPaths = await Promise.all(paths.map((path) => persistAssetPath(path)));
      const loaded = await Promise.all(storedPaths.map(async (path) => ({ ...(await readImagePath(path, sizeMode)), path })));
      for (const { name, src, widthIn, heightIn, rotation, path } of loaded) {
        const id = uid();
        elements.push({ id, name, widthIn, heightIn, frontSrc: src, backSrc: null, x: 0, y: 0, pageIndex: currentPageIndex, rotation });
        await saveCachedImageData(id, "front", src);
        await saveHandle(id, "front", path);
      }
      switchToFront();
      switchTab("elements");
      autoLayout();
    } catch {
      // cancelled
    }
    return;
  }
  if ("showOpenFilePicker" in window) {
    try {
      const handles: FileSystemFileHandle[] = await (window as unknown as {
        showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]>;
      }).showOpenFilePicker({
        types: [{ description: "Images", accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp", ".svg"] } }],
        multiple: true,
      });
      const sizeMode = await promptImportSize();
      if (!sizeMode) return;
      const loaded = await Promise.all(handles.map(async (handle) => {
        const file = await handle.getFile();
        const data = await readImageFile(file, sizeMode);
        return { ...data, handle };
      }));
      for (const { name, src, widthIn, heightIn, rotation, handle } of loaded) {
        const id = uid();
        elements.push({ id, name, widthIn, heightIn, frontSrc: src, backSrc: null, x: 0, y: 0, pageIndex: currentPageIndex, rotation });
        await saveCachedImageData(id, "front", src);
        await saveHandle(id, "front", handle);
      }
      switchToFront();
      switchTab("elements");
      autoLayout();
    } catch { /* cancelled */ }
  } else {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/png,image/jpeg,image/webp,image/svg+xml";
    input.onchange = async () => { if (input.files?.length) await importFromFiles(input.files); };
    input.click();
  }
}

// ─── PDF export ───────────────────────────────────────────────────────────────

async function rasterize(src: string, wIn: number, hIn: number, a: Adj = getAdj(), rotation = 0): Promise<Uint8Array> {
  const isSvg = src.startsWith("data:image/svg");
  const drawSrc = isSvg ? buildAdjustedSrc(src, a) : src;

  const dpi = PDF_RASTER_DPI;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(wIn * dpi);
  canvas.height = Math.round(hIn * dpi);
  const ctx = canvas.getContext("2d")!;

  if (!isSvg) {
    ctx.filter = `brightness(${a.brightness}) saturate(${a.saturation}) contrast(${a.contrast})`;
  }

  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = rej; img.src = drawSrc; });

  const W = canvas.width, H = canvas.height;
  if (rotation === 0) {
    ctx.drawImage(img, 0, 0, W, H);
  } else {
    ctx.translate(W / 2, H / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    // For 90/270 the image natural dims are swapped relative to the canvas
    const swapped = rotation === 90 || rotation === 270;
    ctx.drawImage(img, swapped ? -H / 2 : -W / 2, swapped ? -W / 2 : -H / 2,
                       swapped ? H : W,            swapped ? W : H);
  }

  if (!isSvg && (a.blackPoint > 0 || a.whitePoint < 1.0)) {
    const bp = a.blackPoint;
    const range = Math.max(0.001, a.whitePoint - bp);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i]   = Math.min(255, Math.max(0, Math.round(((d[i]   / 255 - bp) / range) * 255)));
      d[i+1] = Math.min(255, Math.max(0, Math.round(((d[i+1] / 255 - bp) / range) * 255)));
      d[i+2] = Math.min(255, Math.max(0, Math.round(((d[i+2] / 255 - bp) / range) * 255)));
    }
    ctx.putImageData(imageData, 0, 0);
  }

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("Canvas rasterize failed");
  return new Uint8Array(await blob.arrayBuffer());
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function embedSrc(
  pdfDoc: PDFDocument,
  src: string,
  wIn: number,
  hIn: number,
  a: Adj,
  rotation = 0,
): Promise<ReturnType<typeof pdfDoc.embedPng>> {
  const mime = src.split(";")[0].split(":")[1];
  const hasAdj = a.brightness !== 1.0 || a.saturation !== 1.0 || a.contrast !== 1.0
               || a.blackPoint !== 0.0 || a.whitePoint !== 1.0;
  if (!hasAdj && rotation === 0) {
    const b64 = src.split(",")[1];
    if (mime === "image/png") return pdfDoc.embedPng(b64ToBytes(b64));
    if (mime === "image/jpeg" || mime === "image/jpg") return pdfDoc.embedJpg(b64ToBytes(b64));
  }
  return pdfDoc.embedPng(await rasterize(src, wIn, hIn, a, rotation));
}

async function exportPdf(): Promise<void> {
  const loading = document.getElementById("loading")!;
  loading.style.display = "flex";
  try {
    const pdfDoc = await PDFDocument.create();
    const PT = PT_PER_IN;
      const { rgb } = await import("pdf-lib");
    const guideColor = rgb(0.5, 0.5, 0.5);
    const guideWidth = 0.5;

    for (let pi = 0; pi < pages.length; pi++) {
      const ps = pages[pi];
      const pw = ps.widthIn * PT;
      const ph = ps.heightIn * PT;
      const frontPage = pdfDoc.addPage([pw, ph]);
      const backPage  = pdfDoc.addPage([pw, ph]);
      const sheetEls  = elements.filter((e) => e.pageIndex === pi);

      for (const el of sheetEls) {
        const wPt = el.widthIn * PT;
        const hPt = el.heightIn * PT;
        const rot = el.rotation ?? 0;
        const elAFront = getEffectiveAdj(el, ps, false);
        const elABack  = getEffectiveAdj(el, ps, true);
        const frontBleed = getEffectiveBleed(el, ps, false);
        const backBleed  = getEffectiveBleed(el, ps, true);
        // Draw bleed rect behind image (filled, extends outside card)
        if (frontBleed.bleedIn > 0) {
          const bf = frontBleed.bleedIn * PT;
          const [r, g, b] = hexToRgbTriplet(frontBleed.color);
          frontPage.drawRectangle({
            x: el.x * PT - bf,
            y: ph - (el.y + el.heightIn) * PT - bf,
            width: wPt + 2 * bf,
            height: hPt + 2 * bf,
            color: rgb(r, g, b),
            opacity: 1,
          });
        }
        if (el.frontSrc) {
          const img = await embedSrc(pdfDoc, el.frontSrc, el.widthIn, el.heightIn, elAFront, rot);
          frontPage.drawImage(img, { x: el.x * PT, y: ph - (el.y + el.heightIn) * PT, width: wPt, height: hPt });
        }
        const bp = backPos(el, ps);
        if (backBleed.bleedIn > 0) {
          const bb = backBleed.bleedIn * PT;
          const [r, g, b] = hexToRgbTriplet(backBleed.color);
          backPage.drawRectangle({
            x: bp.x * PT - bb,
            y: ph - (bp.y + el.heightIn) * PT - bb,
            width: wPt + 2 * bb,
            height: hPt + 2 * bb,
            color: rgb(r, g, b),
            opacity: 1,
          });
        }
        if (el.backSrc) {
          const img = await embedSrc(pdfDoc, el.backSrc, el.widthIn, el.heightIn, elABack, rot);
          backPage.drawImage(img, { x: bp.x * PT, y: ph - (bp.y + el.heightIn) * PT, width: wPt, height: hPt });
        }
      }

      const frontGuides = getGuideLines(sheetEls, false, ps);
      const backGuides = getGuideLines(sheetEls, true, ps);
      for (const x of frontGuides.xs) frontPage.drawLine({ start: { x: x * PT, y: 0 }, end: { x: x * PT, y: ph }, thickness: guideWidth, color: guideColor });
      for (const y of frontGuides.ys) frontPage.drawLine({ start: { x: 0, y: ph - y * PT }, end: { x: pw, y: ph - y * PT }, thickness: guideWidth, color: guideColor });
      for (const x of backGuides.xs) backPage.drawLine({ start: { x: x * PT, y: 0 }, end: { x: x * PT, y: ph }, thickness: guideWidth, color: guideColor });
      for (const y of backGuides.ys) backPage.drawLine({ start: { x: 0, y: ph - y * PT }, end: { x: pw, y: ph - y * PT }, thickness: guideWidth, color: guideColor });
    }

    const bytes = await pdfDoc.save();
    if (isDesktopApp()) {
      const path = await savePdfPath("print-layout.pdf");
      if (!path) return;
      await writeBinaryPath(path, bytes);
      return;
    }
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "print-layout.pdf";
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`PDF export failed: ${(err as Error).message}`);
  } finally {
    loading.style.display = "none";
  }
}

// ─── Controls wiring ──────────────────────────────────────────────────────────

document.getElementById("btn-add")!.addEventListener("click", () => {
  const id = uid();
  elements.push({ id, name: `Element ${nextId - 1}`, widthIn: 2.5, heightIn: 3.5, frontSrc: null, backSrc: null, x: 0.5, y: 0.5, pageIndex: currentPageIndex });
  selectedId = id;
  render();
});

document.getElementById("btn-import")!.addEventListener("click", batchPickFiles);

// ─── Canvas drop zone ─────────────────────────────────────────────────────────

const canvasArea = document.getElementById("canvas-area")!;

// Click on canvas background deselects
document.getElementById("page-canvas")!.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    selectedId = null;
    renderSidebar();
    loadAdjustmentUI();
  }
});

canvasArea.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) {
    e.preventDefault();
    canvasArea.classList.add("drop-over");
  }
});

canvasArea.addEventListener("dragleave", (e) => {
  if (!canvasArea.contains(e.relatedTarget as Node)) {
    canvasArea.classList.remove("drop-over");
  }
});

canvasArea.addEventListener("drop", (e) => {
  e.preventDefault();
  canvasArea.classList.remove("drop-over");
  const files = e.dataTransfer?.files;
  if (files?.length) importFromFiles(files);
});

if (isDesktopApp()) {
  getCurrentWebview().onDragDropEvent(async (event) => {
    if (event.payload.type === "enter" || event.payload.type === "over") {
      canvasArea.classList.add("drop-over");
      return;
    }
    if (event.payload.type === "leave") {
      canvasArea.classList.remove("drop-over");
      return;
    }
    canvasArea.classList.remove("drop-over");
    const paths = event.payload.paths.filter(isImageFilePath);
    if (paths.length === 0) return;
    const sizeMode = await promptImportSize();
    if (!sizeMode) return;
    const storedPaths = await Promise.all(paths.map((path) => persistAssetPath(path)));
    const loaded = await Promise.all(storedPaths.map(async (path) => ({ ...(await readImagePath(path, sizeMode)), path })));
    for (const { name, src, widthIn, heightIn, rotation, path } of loaded) {
      const id = uid();
      elements.push({ id, name, widthIn, heightIn, frontSrc: src, backSrc: null, x: 0, y: 0, pageIndex: currentPageIndex, rotation });
      await saveCachedImageData(id, "front", src);
      await saveHandle(id, "front", path);
    }
    switchToFront();
    switchTab("elements");
    autoLayout();
  }).catch(() => {
    // desktop drag/drop unavailable
  });
}

document.getElementById("btn-front")!.addEventListener("click", () => { view = "front"; updateViewBtns(); loadAdjustmentUI(); renderCanvas(); });
document.getElementById("btn-back")!.addEventListener("click", () => { view = "back"; updateViewBtns(); loadAdjustmentUI(); renderCanvas(); });
document.getElementById("btn-export")!.addEventListener("click", exportPdf);
document.getElementById("btn-auto-layout")!.addEventListener("click", autoLayout);
document.getElementById("btn-reconnect")!.addEventListener("click", reconnectAll);

// ─── Global back image (per-sheet) ───────────────────────────────────────────

let globalBackSrcs: (string | null)[] = [null]; // parallel to pages[]

function currentGlobalBack(): string | null {
  return globalBackSrcs[currentPageIndex] ?? null;
}

function updateGlobalBackUI(): void {
  const preview = document.getElementById("global-back-preview")!;
  const img = document.getElementById("global-back-img") as HTMLImageElement;
  const clearBtn = document.getElementById("btn-clear-global-back")!;
  const setBtn = document.getElementById("btn-global-back")!;
  const src = currentGlobalBack();
  if (src) {
    img.src = src;
    preview.style.display = "block";
    clearBtn.style.display = "block";
    setBtn.textContent = "Change Back Image…";
  } else {
    preview.style.display = "none";
    clearBtn.style.display = "none";
    setBtn.textContent = "Set Back Image…";
  }
}

function globalBackHandleKey(idx = currentPageIndex): string {
  return `global-back-${idx}`;
}

async function applyGlobalBack(src: string, handle?: FileSystemFileHandle | string): Promise<void> {
  globalBackSrcs[currentPageIndex] = src;
  for (const el of elements) { if (el.pageIndex === currentPageIndex) el.backSrc = src; }
  await saveCachedImageData(globalBackHandleKey(), "back", src);
  if (handle) await saveHandle(globalBackHandleKey(), "back", handle);
  updateGlobalBackUI();
  render();
}

async function restoreGlobalBacks(): Promise<void> {
  globalBackSrcs = await restoreGlobalBackImages(pages, elements, globalBackHandleKey);
  updateGlobalBackUI();
  render();
}

async function pickGlobalBack(): Promise<void> {
  if (isDesktopApp()) {
    try {
      const [path] = await openImagePaths(false);
      if (!path) return;
      const storedPath = await persistAssetPath(path);
      const src = patchSvgStretch(bytesToDataUrl(await readBinaryPath(storedPath), basename(storedPath)));
      await applyGlobalBack(src, storedPath);
    } catch {
      // cancelled
    }
    return;
  }
  if ("showOpenFilePicker" in window) {
    try {
      const [handle] = await (window as unknown as {
        showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]>
      }).showOpenFilePicker({
        types: [{ description: "Images", accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp", ".svg"] } }],
        multiple: false,
      });
      const file = await handle.getFile();
      const src = await new Promise<string>((res) => {
        const reader = new FileReader();
        reader.onload = () => res(patchSvgStretch(reader.result as string));
        reader.readAsDataURL(file);
      });
      await applyGlobalBack(src, handle);
    } catch { /* cancelled */ }
  } else {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/svg+xml";
    input.onchange = async () => {
      if (!input.files?.[0]) return;
      const src = await new Promise<string>((res) => {
        const reader = new FileReader();
        reader.onload = () => res(patchSvgStretch(reader.result as string));
        reader.readAsDataURL(input.files![0]);
      });
      await applyGlobalBack(src);
    };
    input.click();
  }
}

document.getElementById("btn-global-back")!.addEventListener("click", pickGlobalBack);

document.getElementById("btn-clear-global-back")!.addEventListener("click", async () => {
  globalBackSrcs[currentPageIndex] = null;
  for (const el of elements) { if (el.pageIndex === currentPageIndex) el.backSrc = null; }
  await deleteHandle(globalBackHandleKey(), "back");
  updateGlobalBackUI();
  render();
});

// ─── Page management ─────────────────────────────────────────────────────────

function pageElements(idx = currentPageIndex): PrintElement[] {
  return elements.filter((e) => e.pageIndex === idx);
}

async function sampleSheetBorder(side: "front" | "back", edge: "top" | "bottom" | "left" | "right"): Promise<void> {
  const sel = selectedElement();
  if (sel) {
    const sampled = await sampleEdgeColor(side === "back" ? sel.backSrc : sel.frontSrc, edge);
    if (sampled) {
      if (side === "back") sel.backBorderColor = sampled;
      else sel.borderColor = sampled;
    }
  } else {
    const sheetEls = pageElements();
    await Promise.all(sheetEls.map(async (el) => {
      const sampled = await sampleEdgeColor(side === "back" ? el.backSrc : el.frontSrc, edge);
      if (!sampled) return;
      if (side === "back") el.backBorderColor = sampled;
      else el.borderColor = sampled;
    }));
  }
  render();
}

function renderPageTabs(): void {
  const container = document.getElementById("page-tabs")!;
  container.innerHTML = "";
  pages.forEach((_, i) => {
    const btn = document.createElement("button");
    btn.textContent = `Sheet ${i + 1}`;
    btn.className = `px-3 py-1 rounded text-xs font-black uppercase transition-all shrink-0 ${
      i === currentPageIndex
        ? "bg-amber-500 text-slate-900"
        : "bg-slate-700 text-slate-300 hover:bg-slate-600"
    }`;
    btn.addEventListener("click", () => switchPage(i));
    container.appendChild(btn);
  });
  const addBtn = document.createElement("button");
  addBtn.textContent = "+ Sheet";
  addBtn.className = "px-2 py-1 rounded text-xs font-black uppercase bg-slate-700 text-slate-400 hover:bg-slate-600 hover:text-white transition-all shrink-0";
  addBtn.addEventListener("click", addPage);
  container.appendChild(addBtn);
  if (pages.length > 1) {
    const delBtn = document.createElement("button");
    delBtn.textContent = "× Sheet";
    delBtn.title = `Delete sheet ${currentPageIndex + 1}`;
    delBtn.className = "px-2 py-1 rounded text-xs font-black uppercase bg-slate-700 text-red-400 hover:bg-red-900 hover:text-red-300 transition-all shrink-0";
    delBtn.addEventListener("click", deletePage);
    container.appendChild(delBtn);
  }
}

function updatePageSettingsUI(): void {
  inpW.value = String(page.widthIn);
  inpH.value = String(page.heightIn);
  selFlip.value = page.flipAxis;
  inpBackOffsetX.value = String(page.backOffsetX ?? 0);
  inpBackOffsetY.value = String(page.backOffsetY ?? 0);
  const preset = page.widthIn === 8.5 && page.heightIn === 11 ? "letter"
    : page.widthIn === 8.27 && page.heightIn === 11.69 ? "a4" : "custom";
  selPreset.value = preset;
  loadBorderUI();
  loadAdjustmentUI();
}

function loadBorderUI(): void {
  const sel = selectedElement();
  const contextEl = document.getElementById("border-context-label")!;
  if (sel) {
    inpSheetBorderW.value = String(sel.bleedIn ?? page.bleedIn ?? 0);
    inpSheetBorderColor.value = sel.borderColor ?? page.borderColor ?? "#000000";
    inpSheetBackBorderColor.value = sel.backBorderColor ?? page.backBorderColor ?? sel.borderColor ?? page.borderColor ?? "#000000";
    contextEl.textContent = `${sel.name} (override)`;
    contextEl.className = "text-[10px] text-amber-400 -mt-1 mb-1 truncate";
  } else {
    inpSheetBorderW.value = String(page.bleedIn ?? 0);
    inpSheetBorderColor.value = page.borderColor ?? "#000000";
    inpSheetBackBorderColor.value = page.backBorderColor ?? page.borderColor ?? "#000000";
    contextEl.textContent = "Sheet defaults";
    contextEl.className = "text-[10px] text-slate-500 -mt-1 mb-1";
  }
}

function switchPage(idx: number): void {
  currentPageIndex = idx;
  page = pages[currentPageIndex];
  selectedId = null;
  updatePageSettingsUI();
  updateGlobalBackUI();
  renderPageTabs();
  render();
}

function addPage(): void {
  pages.push({ ...page });
  globalBackSrcs.push(null);
  switchPage(pages.length - 1);
}

function deletePage(): void {
  if (pages.length <= 1) return;
  const els = pageElements();
  if (els.length > 0 && !confirm(`Delete sheet ${currentPageIndex + 1} and its ${els.length} element(s)?`)) return;
  elements = elements.filter((e) => e.pageIndex !== currentPageIndex);
  for (const e of elements) { if (e.pageIndex > currentPageIndex) e.pageIndex--; }
  pages.splice(currentPageIndex, 1);
  globalBackSrcs.splice(currentPageIndex, 1);
  currentPageIndex = Math.min(currentPageIndex, pages.length - 1);
  page = pages[currentPageIndex];
  updatePageSettingsUI();
  updateGlobalBackUI();
  renderPageTabs();
  render();
}

function updateViewBtns(): void {
  const active = "bg-amber-500 text-slate-900";
  const idle = "bg-slate-700 text-slate-300 hover:bg-slate-600";
  document.getElementById("btn-front")!.className = `px-4 py-1.5 rounded-lg text-xs font-black uppercase transition-all ${view === "front" ? active : idle}`;
  document.getElementById("btn-back")!.className = `px-4 py-1.5 rounded-lg text-xs font-black uppercase transition-all ${view === "back" ? active : idle}`;
  document.getElementById("adj-side-label")!.textContent = view === "back" ? "Back" : "Front";
}

const selPreset = document.getElementById("sel-preset") as HTMLSelectElement;
const inpW = document.getElementById("inp-w") as HTMLInputElement;
const inpH = document.getElementById("inp-h") as HTMLInputElement;
const selFlip = document.getElementById("sel-flip") as HTMLSelectElement;
const inpBackOffsetX = document.getElementById("inp-back-offset-x") as HTMLInputElement;
const inpBackOffsetY = document.getElementById("inp-back-offset-y") as HTMLInputElement;
const inpSheetBorderW = document.getElementById("inp-sheet-border-w") as HTMLInputElement;
const inpSheetBorderColor = document.getElementById("inp-sheet-border-color") as HTMLInputElement;
const inpSheetBackBorderColor = document.getElementById("inp-sheet-back-border-color") as HTMLInputElement;

selPreset.addEventListener("change", () => {
  if (selPreset.value === "letter") { page.widthIn = 8.5; page.heightIn = 11; }
  else if (selPreset.value === "a4") { page.widthIn = 8.27; page.heightIn = 11.69; }
  if (selPreset.value !== "custom") { inpW.value = String(page.widthIn); inpH.value = String(page.heightIn); }
  renderCanvas();
});

inpW.addEventListener("change", () => {
  const v = parseFloat(inpW.value);
  if (v > 0) { page.widthIn = v; selPreset.value = "custom"; renderCanvas(); }
});

inpH.addEventListener("change", () => {
  const v = parseFloat(inpH.value);
  if (v > 0) { page.heightIn = v; selPreset.value = "custom"; renderCanvas(); }
});

selFlip.addEventListener("change", () => {
  page.flipAxis = selFlip.value as FlipAxis;
  render();
});

function syncBackOffsets(): void {
  page.backOffsetX = parseFloat(inpBackOffsetX.value) || 0;
  page.backOffsetY = parseFloat(inpBackOffsetY.value) || 0;
  renderCanvas();
  saveState({ elements, pages, currentPageIndex, nextId, importedFonts });
}

inpBackOffsetX.addEventListener("change", syncBackOffsets);
inpBackOffsetY.addEventListener("change", syncBackOffsets);

function syncSheetBorder(autoRelayout = false): void {
  const sel = selectedElement();
  if (sel) {
    sel.bleedIn = Math.max(0, parseFloat(inpSheetBorderW.value) || 0);
    sel.borderColor = inpSheetBorderColor.value;
    sel.backBorderColor = inpSheetBackBorderColor.value;
  } else {
    page.bleedIn = Math.max(0, parseFloat(inpSheetBorderW.value) || 0);
    page.borderColor = inpSheetBorderColor.value;
    page.backBorderColor = inpSheetBackBorderColor.value;
  }
  if (autoRelayout) {
    autoLayout();
    return;
  }
  render();
}

function resetSheetBorderOverrides(): void {
  const sel = selectedElement();
  if (sel) {
    sel.bleedIn = undefined;
    sel.borderColor = undefined;
    sel.backBorderColor = undefined;
  } else {
    for (const el of pageElements()) {
      el.borderColor = undefined;
      el.backBorderColor = undefined;
    }
  }
  render();
}

inpSheetBorderW.addEventListener("change", () => syncSheetBorder(true));
inpSheetBorderColor.addEventListener("input", () => syncSheetBorder(false));
inpSheetBackBorderColor.addEventListener("input", () => syncSheetBorder(false));
document.getElementById("btn-sheet-border-reset-overrides")!.addEventListener("click", resetSheetBorderOverrides);

document.getElementById("btn-sheet-border-sample-front-top")!.addEventListener("click", () => { void sampleSheetBorder("front", "top"); });
document.getElementById("btn-sheet-border-sample-front-bottom")!.addEventListener("click", () => { void sampleSheetBorder("front", "bottom"); });
document.getElementById("btn-sheet-border-sample-front-left")!.addEventListener("click", () => { void sampleSheetBorder("front", "left"); });
document.getElementById("btn-sheet-border-sample-front-right")!.addEventListener("click", () => { void sampleSheetBorder("front", "right"); });
document.getElementById("btn-sheet-border-sample-back-top")!.addEventListener("click", () => { void sampleSheetBorder("back", "top"); });
document.getElementById("btn-sheet-border-sample-back-bottom")!.addEventListener("click", () => { void sampleSheetBorder("back", "bottom"); });
document.getElementById("btn-sheet-border-sample-back-left")!.addEventListener("click", () => { void sampleSheetBorder("back", "left"); });
document.getElementById("btn-sheet-border-sample-back-right")!.addEventListener("click", () => { void sampleSheetBorder("back", "right"); });

const inpBrightness = document.getElementById("inp-brightness") as HTMLInputElement;
const inpSaturation = document.getElementById("inp-saturation") as HTMLInputElement;
const inpContrast = document.getElementById("inp-contrast") as HTMLInputElement;
const inpBlackpoint = document.getElementById("inp-blackpoint") as HTMLInputElement;
const inpWhitepoint = document.getElementById("inp-whitepoint") as HTMLInputElement;
const brightnessVal = document.getElementById("brightness-val") as HTMLInputElement;
const saturationVal = document.getElementById("saturation-val") as HTMLInputElement;
const contrastVal   = document.getElementById("contrast-val")   as HTMLInputElement;
const blackpointVal = document.getElementById("blackpoint-val") as HTMLInputElement;
const whitepointVal = document.getElementById("whitepoint-val") as HTMLInputElement;

function syncAdjustments(): void {
  const sel = selectedElement();
  const isBack = view === "back";
  if (sel) {
    if (isBack) {
      sel.backBrightness = parseInt(inpBrightness.value) / 100;
      sel.backSaturation = parseInt(inpSaturation.value) / 100;
      sel.backContrast   = parseInt(inpContrast.value)   / 100;
      sel.backBlackPoint = parseInt(inpBlackpoint.value) / 100;
      sel.backWhitePoint = parseInt(inpWhitepoint.value) / 100;
    } else {
      sel.brightness = parseInt(inpBrightness.value) / 100;
      sel.saturation = parseInt(inpSaturation.value) / 100;
      sel.contrast   = parseInt(inpContrast.value)   / 100;
      sel.blackPoint = parseInt(inpBlackpoint.value) / 100;
      sel.whitePoint = parseInt(inpWhitepoint.value) / 100;
    }
  } else if (isBack) {
    page.backBrightness = parseInt(inpBrightness.value) / 100;
    page.backSaturation = parseInt(inpSaturation.value) / 100;
    page.backContrast   = parseInt(inpContrast.value)   / 100;
    page.backBlackPoint = parseInt(inpBlackpoint.value) / 100;
    page.backWhitePoint = parseInt(inpWhitepoint.value) / 100;
  } else {
    page.brightness = parseInt(inpBrightness.value) / 100;
    page.saturation = parseInt(inpSaturation.value) / 100;
    page.contrast   = parseInt(inpContrast.value)   / 100;
    page.blackPoint = parseInt(inpBlackpoint.value) / 100;
    page.whitePoint = parseInt(inpWhitepoint.value) / 100;
  }
  brightnessVal.value = inpBrightness.value;
  saturationVal.value = inpSaturation.value;
  contrastVal.value   = inpContrast.value;
  blackpointVal.value = inpBlackpoint.value;
  whitepointVal.value = inpWhitepoint.value;
  updateAdjContext();
  updateLevelsFilter(getEffectiveAdj(selectedElement()));
  renderCanvas();
  saveState({ elements, pages, currentPageIndex, nextId, importedFonts });
}

function updateAdjContext(): void {
  const sel = selectedElement();
  const isBack = view === "back";
  const hasOverride = sel ? hasElementOverride(sel, isBack) : false;
  const contextEl = document.getElementById("adj-context-label")!;
  if (sel) {
    contextEl.textContent = hasOverride ? `${sel.name} (override)` : `${sel.name} (sheet)`;
    contextEl.className = hasOverride
      ? "text-[10px] text-amber-400 truncate"
      : "text-[10px] text-slate-500 truncate";
  } else {
    contextEl.textContent = "Sheet";
    contextEl.className = "text-[10px] text-slate-500 truncate";
  }
}

function loadAdjustmentUI(): void {
  const sel = selectedElement();
  const a = getEffectiveAdj(sel);
  inpBrightness.value = String(Math.round(a.brightness * 100));
  inpSaturation.value = String(Math.round(a.saturation * 100));
  inpContrast.value   = String(Math.round(a.contrast   * 100));
  inpBlackpoint.value = String(Math.round(a.blackPoint * 100));
  inpWhitepoint.value = String(Math.round(a.whitePoint * 100));
  brightnessVal.value = inpBrightness.value;
  saturationVal.value = inpSaturation.value;
  contrastVal.value   = inpContrast.value;
  blackpointVal.value = inpBlackpoint.value;
  whitepointVal.value = inpWhitepoint.value;
  updateAdjContext();
  updateLevelsFilter(a);
}

// Bidirectional: typing in the val input updates the slider
function wireValInput(valInput: HTMLInputElement, rangeInput: HTMLInputElement): void {
  valInput.addEventListener("change", () => {
    const clamped = clamp(parseInt(valInput.value) || 0, parseInt(rangeInput.min), parseInt(rangeInput.max));
    rangeInput.value = String(clamped);
    syncAdjustments();
  });
}
wireValInput(brightnessVal, inpBrightness);
wireValInput(saturationVal, inpSaturation);
wireValInput(contrastVal,   inpContrast);
wireValInput(blackpointVal, inpBlackpoint);
wireValInput(whitepointVal, inpWhitepoint);

inpBrightness.addEventListener("input", syncAdjustments);
inpSaturation.addEventListener("input", syncAdjustments);
inpContrast.addEventListener("input", syncAdjustments);
inpBlackpoint.addEventListener("input", syncAdjustments);
inpWhitepoint.addEventListener("input", syncAdjustments);

document.getElementById("btn-reset-adjustments")!.addEventListener("click", () => {
  const sel = selectedElement();
  const isBack = view === "back";
  if (sel) {
    if (isBack) {
      sel.backBrightness = undefined; sel.backSaturation = undefined; sel.backContrast = undefined;
      sel.backBlackPoint = undefined; sel.backWhitePoint = undefined;
    } else {
      sel.brightness = undefined; sel.saturation = undefined; sel.contrast = undefined;
      sel.blackPoint = undefined; sel.whitePoint = undefined;
    }
  } else if (isBack) {
    page.backBrightness = undefined; page.backSaturation = undefined; page.backContrast = undefined;
    page.backBlackPoint = undefined; page.backWhitePoint = undefined;
  } else {
    page.brightness = undefined; page.saturation = undefined; page.contrast = undefined;
    page.blackPoint = undefined; page.whitePoint = undefined;
  }
  loadAdjustmentUI();
  renderCanvas();
  saveState({ elements, pages, currentPageIndex, nextId, importedFonts });
});

// ─── Zoom controls ────────────────────────────────────────────────────────────

document.getElementById("btn-zoom-in")!.addEventListener("click", () => stepZoom(0.1));
document.getElementById("btn-zoom-out")!.addEventListener("click", () => stepZoom(-0.1));

const zoomValInput = document.getElementById("zoom-val") as HTMLInputElement;
zoomValInput.addEventListener("change", () => {
  const v = clamp(parseInt(zoomValInput.value) || 100, 25, 400);
  zoomLevel = v / 100;
  applyZoom();
});

// Ctrl+wheel (pinch on Mac trackpad) = zoom; plain wheel = native scroll
document.getElementById("page-canvas")!.closest(".overflow-auto")!.addEventListener("wheel", (e) => {
  const we = e as WheelEvent;
  if (!we.ctrlKey) return;
  we.preventDefault();
  stepZoom(we.deltaY < 0 ? 0.05 : -0.05);
}, { passive: false });

// Cmd/Ctrl +/- keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === "=" || e.key === "+") { e.preventDefault(); stepZoom(0.1); }
  else if (e.key === "-") { e.preventDefault(); stepZoom(-0.1); }
  else if (e.key === "0") { e.preventDefault(); zoomLevel = 1.0; applyZoom(); }
});

// ─── Persistence ─────────────────────────────────────────────────────────────

function updateReconnectBtn(): void {
  const btn = document.getElementById("btn-reconnect")!;
  btn.style.display = hasMissingImages(elements) ? "block" : "none";
}

async function reconnectAll(): Promise<void> {
  await reconnectAllImages(elements);
  render();
  updateReconnectBtn();
}

async function pickFile(id: string, side: "front" | "back"): Promise<void> {
  const loaded = await pickFileForElement(elements, id, side);
  if (!loaded) return;
  render();
  updateReconnectBtn();
}

async function saveProject(): Promise<void> {
  const embedImages = (document.getElementById("chk-embed-images") as HTMLInputElement).checked;
  await saveProjectFile({ elements, pages, currentPageIndex, nextId, globalBackSrcs, importedFonts }, embedImages);
}

async function loadProject(): Promise<void> {
  try {
    const loaded = await loadProjectFile();
    if (!loaded) return;
    elements = loaded.elements;
    pages = loaded.pages;
    globalBackSrcs = loaded.globalBackSrcs;
    importedFonts = loaded.importedFonts;
    setImportedFonts(importedFonts);
    currentPageIndex = loaded.currentPageIndex;
    nextId = loaded.nextId;
    page = pages[currentPageIndex];
    selectedId = null;
    loadAdjustmentUI();
    updatePageSettingsUI();
    updateGlobalBackUI();
    renderPageTabs();
    render();
    saveState({ elements, pages, currentPageIndex, nextId, importedFonts });
  } catch (err) {
    alert(`Failed to load project: ${(err as Error).message}`);
  }
}

document.getElementById("btn-save-project")!.addEventListener("click", saveProject);
document.getElementById("btn-load-project")!.addEventListener("click", loadProject);
document.getElementById("btn-import-fonts")!.addEventListener("click", () => { void importFonts(); });

document.getElementById("btn-reset")!.addEventListener("click", async () => {
  if (!confirm("Clear all elements, sheets, and settings?")) return;
  elements = [];
  pages = [{ widthIn: 8.5, heightIn: 11, flipAxis: "long" }];
  currentPageIndex = 0; page = pages[0];
  nextId = 1; selectedId = null; globalBackSrcs = [null]; importedFonts = [];
  setImportedFonts(importedFonts);
  await clearAllHandles();
  localStorage.removeItem("aegis_print_layout_v1");
  loadAdjustmentUI();
  updatePageSettingsUI();
  updateGlobalBackUI();
  renderPageTabs();
  render();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

// Inject SVG levels filter referenced by printFilter()
(function injectLevelsFilter() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("style", "display:none");
  svg.innerHTML = `<filter id="print-levels-filter" color-interpolation-filters="sRGB" x="0" y="0" width="1" height="1">
    <feComponentTransfer>
      <feFuncR id="lf-r" type="linear" slope="1" intercept="0"/>
      <feFuncG id="lf-g" type="linear" slope="1" intercept="0"/>
      <feFuncB id="lf-b" type="linear" slope="1" intercept="0"/>
    </feComponentTransfer>
  </filter>`;
  document.body.appendChild(svg);
})();

// ─── Sidebar tabs ─────────────────────────────────────────────────────────────

let activeTab: "settings" | "elements" = "settings";

function switchTab(tab: "settings" | "elements"): void {
  activeTab = tab;
  const settingsPane = document.getElementById("tab-settings")!;
  const elementsPane = document.getElementById("tab-elements")!;
  const settingsBtn  = document.getElementById("tab-btn-settings")!;
  const elementsBtn  = document.getElementById("tab-btn-elements")!;

  const activeClass = "text-amber-500 border-b-2 border-amber-500";
  const idleClass   = "text-slate-500 hover:text-slate-300 border-b-2 border-transparent";

  if (tab === "settings") {
    settingsPane.style.display = "block";
    elementsPane.style.display = "none";
    settingsBtn.className = `flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest transition-colors ${activeClass}`;
    elementsBtn.className = `flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest transition-colors ${idleClass}`;
  } else {
    settingsPane.style.display = "none";
    elementsPane.style.display = "flex";
    elementsBtn.className = `flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest transition-colors ${activeClass}`;
    settingsBtn.className = `flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest transition-colors ${idleClass}`;
  }
}

document.getElementById("tab-btn-settings")!.addEventListener("click", () => { switchTab("settings"); loadAdjustmentUI(); });
document.getElementById("tab-btn-elements")!.addEventListener("click", () => switchTab("elements"));

// ─── Init ─────────────────────────────────────────────────────────────────────

{
  const loaded = loadState();
  if (loaded) {
    elements = loaded.elements;
    pages = loaded.pages;
    globalBackSrcs = loaded.globalBackSrcs;
    importedFonts = loaded.importedFonts;
    setImportedFonts(importedFonts);
    currentPageIndex = loaded.currentPageIndex;
    nextId = loaded.nextId;
    page = pages[currentPageIndex];
  }
}
loadAdjustmentUI();
updateViewBtns();
switchTab("settings");
updateGlobalBackUI();
renderPageTabs();
render();
restoreAllHandles(elements).then(updateReconnectBtn);
restoreAllHandles(elements).then(() => {
  refreshSvgFonts();
  render();
  updateReconnectBtn();
});
restoreGlobalBacks().then(() => {
  refreshSvgFonts();
  render();
});
