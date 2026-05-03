export interface ImportedFont {
  id: string;
  family: string;
  sourceName: string;
  format: "truetype" | "opentype" | "woff" | "woff2";
  src: string;
}

export interface PrintElement {
  id: string;
  name: string;
  widthIn: number;
  heightIn: number;
  frontSrc: string | null;
  backSrc: string | null;
  x: number;
  y: number;
  pageIndex: number;
  rotation?: 0 | 90 | 180 | 270;
  // Per-element adjustment overrides — undefined means inherit from sheet
  brightness?: number;
  saturation?: number;
  contrast?: number;
  blackPoint?: number;
  whitePoint?: number;
  backBrightness?: number;
  backSaturation?: number;
  backContrast?: number;
  backBlackPoint?: number;
  backWhitePoint?: number;
  bleedIn?: number;
  borderColor?: string;
  backBorderColor?: string;
}

export type FlipAxis = "long" | "short";

export interface PageSettings {
  widthIn: number;
  heightIn: number;
  flipAxis: FlipAxis;
  backOffsetX?: number;
  backOffsetY?: number;
  bleedIn?: number;
  borderColor?: string;
  backBorderColor?: string;
  // Front adjustments
  brightness?: number;
  saturation?: number;
  contrast?: number;
  blackPoint?: number;
  whitePoint?: number;
  // Back adjustments
  backBrightness?: number;
  backSaturation?: number;
  backContrast?: number;
  backBlackPoint?: number;
  backWhitePoint?: number;
}
