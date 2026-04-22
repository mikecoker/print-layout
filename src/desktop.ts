import { isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { BaseDirectory, mkdir, readFile, writeFile } from "@tauri-apps/plugin-fs";

const IMAGE_FILTERS = [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "svg"] }];
const PROJECT_FILTERS = [{ name: "Aegis Project", extensions: ["aegis"] }];
const FONT_FILTERS = [{ name: "Fonts", extensions: ["ttf", "otf", "woff", "woff2"] }];
const PDF_FILTERS = [{ name: "PDF", extensions: ["pdf"] }];
const APPDATA_PREFIX = "appdata://";

export function isDesktopApp(): boolean {
  return isTauri();
}

export function basename(path: string): string {
  if (path.startsWith(APPDATA_PREFIX)) path = path.slice(APPDATA_PREFIX.length);
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function toAppDataPath(relativePath: string): string {
  return `${APPDATA_PREFIX}${relativePath}`;
}

function fromAppDataPath(path: string): string {
  return path.slice(APPDATA_PREFIX.length);
}

export async function openImagePaths(multiple: boolean): Promise<string[]> {
  const selected = await open({ multiple, directory: false, filters: IMAGE_FILTERS });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export async function openProjectPath(): Promise<string | null> {
  const selected = await open({ multiple: false, directory: false, filters: PROJECT_FILTERS });
  return typeof selected === "string" ? selected : null;
}

export async function openFontPaths(multiple: boolean): Promise<string[]> {
  const selected = await open({ multiple, directory: false, filters: FONT_FILTERS });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export async function saveProjectPath(defaultName: string): Promise<string | null> {
  return save({ filters: PROJECT_FILTERS, defaultPath: defaultName });
}

export async function savePdfPath(defaultName: string): Promise<string | null> {
  return save({ filters: PDF_FILTERS, defaultPath: defaultName });
}

export async function readBinaryPath(path: string): Promise<Uint8Array> {
  return path.startsWith(APPDATA_PREFIX)
    ? readFile(fromAppDataPath(path), { baseDir: BaseDirectory.AppLocalData })
    : readFile(path);
}

export async function writeBinaryPath(path: string, data: Uint8Array): Promise<void> {
  if (path.startsWith(APPDATA_PREFIX)) {
    await writeFile(fromAppDataPath(path), data, { baseDir: BaseDirectory.AppLocalData });
    return;
  }
  await writeFile(path, data);
}

export async function ensureAutosaveDir(): Promise<void> {
  await mkdir("projects", { baseDir: BaseDirectory.AppLocalData, recursive: true });
}

export async function persistAssetPath(path: string, kind: "images" | "fonts" = "images"): Promise<string> {
  const filename = `${crypto.randomUUID()}-${basename(path)}`;
  const relativePath = `assets/${kind}/${filename}`;
  await mkdir(`assets/${kind}`, { baseDir: BaseDirectory.AppLocalData, recursive: true });
  await writeFile(relativePath, await readBinaryPath(path), { baseDir: BaseDirectory.AppLocalData });
  return toAppDataPath(relativePath);
}
