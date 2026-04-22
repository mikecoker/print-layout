import type { ImportedFont } from "./types";

let importedFonts: ImportedFont[] = [];

function decodeDataUrl(dataUrl: string): { header: string; body: string; isBase64: boolean } {
  const [header, body] = dataUrl.split(",", 2);
  return { header, body, isBase64: header.includes("base64") };
}

function encodeSvg(header: string, svg: string, isBase64: boolean): string {
  try {
    return isBase64 ? `${header},${btoa(svg)}` : `${header},${encodeURIComponent(svg)}`;
  } catch {
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
}

function decodeSvg(body: string, isBase64: boolean): string {
  return isBase64 ? atob(body) : decodeURIComponent(body);
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildFontCss(fonts: ImportedFont[]): string {
  return fonts.map((font) =>
    `@font-face{font-family:"${escapeCssString(font.family)}";src:url("${font.src}") format("${font.format}");font-style:normal;font-weight:400;}`,
  ).join("");
}

export function setImportedFonts(fonts: ImportedFont[]): void {
  importedFonts = fonts;
}

export function getImportedFonts(): ImportedFont[] {
  return importedFonts;
}

export function injectImportedFontsIntoSvgDataUrl(dataUrl: string, fonts = importedFonts): string {
  if (!dataUrl.startsWith("data:image/svg") || fonts.length === 0) return dataUrl;
  const { header, body, isBase64 } = decodeDataUrl(dataUrl);
  let svg = decodeSvg(body, isBase64);
  svg = svg.replace(/<style id="aegis-imported-fonts">[\s\S]*?<\/style>/g, "");
  const fontCss = buildFontCss(fonts);
  if (!fontCss) return dataUrl;
  const styleTag = `<style id="aegis-imported-fonts">${fontCss}</style>`;
  if (svg.includes("<defs>")) {
    svg = svg.replace("<defs>", `<defs>${styleTag}`);
  } else if (/<defs\s*\/>/.test(svg)) {
    svg = svg.replace(/<defs\s*\/>/, `<defs>${styleTag}</defs>`);
  } else {
    svg = svg.replace(/(<svg\b[^>]*>)/, `$1<defs>${styleTag}</defs>`);
  }
  return encodeSvg(header, svg, isBase64);
}
