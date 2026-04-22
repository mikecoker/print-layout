import { injectImportedFontsIntoSvgDataUrl } from "./fonts";

export interface Adj {
  brightness: number;
  saturation: number;
  contrast: number;
  blackPoint: number;
  whitePoint: number;
}

export function buildAdjustedSrc(src: string, a: Adj): string {
  if (!src.startsWith("data:image/svg")) return src;
  const hasAdj = a.brightness !== 1.0 || a.saturation !== 1.0 || a.contrast !== 1.0
               || a.blackPoint !== 0.0 || a.whitePoint !== 1.0;
  if (!hasAdj) return src;

  const [header, encoded] = src.split(",");
  const isBase64 = header.includes("base64");
  let svg = isBase64 ? atob(encoded) : decodeURIComponent(encoded);

  const bp = a.blackPoint;
  const wp = a.whitePoint;
  const range = Math.max(0.001, wp - bp);
  const lSlope = 1 / range;
  const lInt = -bp / range;
  const cInt = (1 - a.contrast) / 2;

  const filterDef =
    `<filter id="aegis-adj" color-interpolation-filters="sRGB" x="0%" y="0%" width="100%" height="100%">` +
    `<feComponentTransfer><feFuncR type="linear" slope="${lSlope}" intercept="${lInt}"/><feFuncG type="linear" slope="${lSlope}" intercept="${lInt}"/><feFuncB type="linear" slope="${lSlope}" intercept="${lInt}"/></feComponentTransfer>` +
    `<feComponentTransfer><feFuncR type="linear" slope="${a.brightness}" intercept="0"/><feFuncG type="linear" slope="${a.brightness}" intercept="0"/><feFuncB type="linear" slope="${a.brightness}" intercept="0"/></feComponentTransfer>` +
    `<feColorMatrix type="saturate" values="${a.saturation}"/>` +
    `<feComponentTransfer><feFuncR type="linear" slope="${a.contrast}" intercept="${cInt}"/><feFuncG type="linear" slope="${a.contrast}" intercept="${cInt}"/><feFuncB type="linear" slope="${a.contrast}" intercept="${cInt}"/></feComponentTransfer>` +
    `</filter>`;

  if (svg.includes("<defs>")) {
    svg = svg.replace("<defs>", `<defs>${filterDef}`);
  } else if (/<defs\s*\/>/.test(svg)) {
    svg = svg.replace(/<defs\s*\/>/, `<defs>${filterDef}</defs>`);
  } else {
    svg = svg.replace(/(<svg\b[^>]*>)/, `$1<defs>${filterDef}</defs>`);
  }

  svg = svg.replace(/<image\b/g, '<image filter="url(#aegis-adj)"');

  try {
    return isBase64 ? `${header},${btoa(svg)}` : `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch {
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
}

export function updateLevelsFilter(a: Adj): void {
  const range = Math.max(0.001, a.whitePoint - a.blackPoint);
  const slope = 1 / range;
  const intercept = -a.blackPoint / range;
  ["lf-r", "lf-g", "lf-b"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.setAttribute("slope", String(slope));
      el.setAttribute("intercept", String(intercept));
    }
  });
}

export function printFilter(a: Adj): string {
  const levels = (a.blackPoint > 0 || a.whitePoint < 1.0) ? "url(#print-levels-filter) " : "";
  return `${levels}brightness(${a.brightness}) saturate(${a.saturation}) contrast(${a.contrast})`;
}

export function patchSvgStretch(dataUrl: string): string {
  if (!dataUrl.startsWith("data:image/svg")) return dataUrl;
  const [header, b64] = dataUrl.split(",");
  const svg = header.includes("base64") ? atob(b64) : decodeURIComponent(b64);
  const patched = svg.replace(
    /(<svg\b[^>]*?)(\s*\/?>)/,
    (_, open, close) => {
      const stripped = open.replace(/\bpreserveAspectRatio="[^"]*"/, "");
      return `${stripped} preserveAspectRatio="none"${close}`;
    },
  );
  const out = header.includes("base64")
    ? `${header},${btoa(patched)}`
    : `${header},${encodeURIComponent(patched)}`;
  return injectImportedFontsIntoSvgDataUrl(out);
}
