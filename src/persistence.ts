import type { ImportedFont, PageSettings, PrintElement } from "./types";
import { DB_NAME, DB_STORE, SAVE_KEY } from "./constants";
import { basename, isDesktopApp, openImagePaths, openProjectPath, persistAssetPath, readBinaryPath, saveProjectPath, writeBinaryPath } from "./desktop";
import { setImportedFonts } from "./fonts";
import { patchSvgStretch } from "./image-utils";

type Side = "front" | "back";
type StoredHandle = FileSystemFileHandle | string;

type SavedElement = Omit<PrintElement, "frontSrc" | "backSrc"> & {
  frontName?: string;
  backName?: string;
  pageIndex?: number;
};

export interface PersistedState {
  elements: PrintElement[];
  pages: PageSettings[];
  currentPageIndex: number;
  nextId: number;
  globalBackSrcs: (string | null)[];
  importedFonts: ImportedFont[];
}

interface ProjectManifest {
  version: 2;
  elements: Array<Omit<PrintElement, "frontSrc" | "backSrc"> & { frontRef?: string; backRef?: string }>;
  pages: PageSettings[];
  currentPageIndex?: number;
  nextId: number;
  importedFonts?: ImportedFont[];
  printBrightness?: number;
  printSaturation?: number;
  printContrast?: number;
  printBlackPoint?: number;
  printWhitePoint?: number;
  globalBackRef?: string;
  pageBackRefs?: (string | undefined)[];
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((res) => {
    const reader = new FileReader();
    reader.onload = () => res(patchSvgStretch(reader.result as string));
    reader.readAsDataURL(file);
  });
}

function normName(s: string): string {
  return s.toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9]/g, "");
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function dataKey(id: string, side: Side): string {
  return `${id}:${side}:data`;
}

async function saveCachedImage(id: string, side: Side, src: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(DB_STORE, "readwrite");
  tx.objectStore(DB_STORE).put(src, dataKey(id, side));
}

async function loadCachedImage(id: string, side: Side): Promise<string | null> {
  const db = await openDb();
  return new Promise((res) => {
    const req = db.transaction(DB_STORE).objectStore(DB_STORE).get(dataKey(id, side));
    req.onsuccess = () => res(typeof req.result === "string" ? req.result : null);
    req.onerror = () => res(null);
  });
}

export async function saveCachedImageData(id: string, side: Side, src: string): Promise<void> {
  await saveCachedImage(id, side, src);
}

export async function saveHandle(id: string, side: Side, handle: StoredHandle): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(DB_STORE, "readwrite");
  tx.objectStore(DB_STORE).put(handle, `${id}:${side}`);
}

export async function loadHandle(id: string, side: Side): Promise<StoredHandle | null> {
  const db = await openDb();
  return new Promise((res) => {
    const req = db.transaction(DB_STORE).objectStore(DB_STORE).get(`${id}:${side}`);
    req.onsuccess = () => res((req.result as StoredHandle) ?? null);
    req.onerror = () => res(null);
  });
}

export async function deleteHandle(id: string, side: Side): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(DB_STORE, "readwrite");
  tx.objectStore(DB_STORE).delete(`${id}:${side}`);
  tx.objectStore(DB_STORE).delete(dataKey(id, side));
}

export async function clearAllHandles(): Promise<void> {
  const db = await openDb();
  db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).clear();
}

export function saveState(state: Omit<PersistedState, "globalBackSrcs">): void {
  const saved = {
    elements: state.elements.map(({ frontSrc: _f, backSrc: _b, ...rest }) => rest),
    pages: state.pages,
    currentPageIndex: state.currentPageIndex,
    nextId: state.nextId,
    importedFonts: state.importedFonts,
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(saved));
  } catch {
    console.warn("Print layout: localStorage save failed");
  }
}

export function loadState(): PersistedState | null {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as {
      elements: SavedElement[];
      pages?: PageSettings[];
      page?: PageSettings;
      currentPageIndex?: number;
      nextId: number;
      importedFonts?: ImportedFont[];
      printBrightness?: number;
      printSaturation?: number;
      printContrast?: number;
      printBlackPoint?: number;
      printWhitePoint?: number;
    };

    const pages = saved.pages ? saved.pages : saved.page ? [saved.page] : [{ widthIn: 8.5, heightIn: 11, flipAxis: "long" as const }];
    const elements = (saved.elements ?? []).map((e) => ({ ...e, frontSrc: null, backSrc: null, pageIndex: e.pageIndex ?? 0 }));
    if (saved.printBrightness != null) pages[0].brightness = saved.printBrightness;
    if (saved.printSaturation != null) pages[0].saturation = saved.printSaturation;
    if (saved.printContrast   != null) pages[0].contrast   = saved.printContrast;
    if (saved.printBlackPoint != null) pages[0].blackPoint = saved.printBlackPoint;
    if (saved.printWhitePoint != null) pages[0].whitePoint = saved.printWhitePoint;

    return {
      elements,
      pages,
      currentPageIndex: Math.min(saved.currentPageIndex ?? 0, pages.length - 1),
      nextId: saved.nextId ?? 1,
      globalBackSrcs: pages.map(() => null),
      importedFonts: saved.importedFonts ?? [],
    };
  } catch {
    console.warn("Print layout: failed to restore saved state");
    return null;
  }
}

export async function loadFileIntoElement(
  elements: PrintElement[],
  id: string,
  side: Side,
  file: File,
  handle?: StoredHandle,
): Promise<boolean> {
  const el = elements.find((x) => x.id === id);
  if (!el) return false;
  if (handle) await saveHandle(id, side, handle);
  const src = await readFileAsDataUrl(file);
  await saveCachedImage(id, side, src);
  if (side === "front") el.frontSrc = src;
  else el.backSrc = src;
  return true;
}

async function loadPathIntoElement(elements: PrintElement[], id: string, side: Side, path: string): Promise<boolean> {
  const el = elements.find((x) => x.id === id);
  if (!el) return false;
  const src = patchSvgStretch(bytesToDataUrl(await readBinaryPath(path), basename(path)));
  await saveHandle(id, side, path);
  await saveCachedImage(id, side, src);
  if (side === "front") el.frontSrc = src;
  else el.backSrc = src;
  return true;
}

async function restoreCachedImage(elements: PrintElement[], id: string, side: Side): Promise<boolean> {
  const el = elements.find((x) => x.id === id);
  if (!el) return false;
  const src = await loadCachedImage(id, side);
  if (!src) return false;
  if (side === "front") el.frontSrc = src;
  else el.backSrc = src;
  return true;
}

async function tryRestoreHandle(elements: PrintElement[], id: string, side: Side): Promise<boolean> {
  const handle = await loadHandle(id, side);
  if (!handle) return false;
  if (typeof handle === "string") return loadPathIntoElement(elements, id, side, handle);
  try {
    const perm = await (handle as unknown as { queryPermission(o: unknown): Promise<string> }).queryPermission({ mode: "read" });
    if (perm !== "granted") return false;
    const file = await handle.getFile();
    return loadFileIntoElement(elements, id, side, file, handle);
  } catch {
    return false;
  }
}

async function requestHandlePermission(elements: PrintElement[], id: string, side: Side): Promise<void> {
  const handle = await loadHandle(id, side);
  if (!handle) return;
  if (typeof handle === "string") {
    await loadPathIntoElement(elements, id, side, handle);
    return;
  }
  try {
    const perm = await (handle as unknown as { requestPermission(o: unknown): Promise<string> }).requestPermission({ mode: "read" });
    if (perm === "granted") {
      const file = await handle.getFile();
      await loadFileIntoElement(elements, id, side, file, handle);
    }
  } catch {
    // user denied
  }
}

export async function restoreAllHandles(elements: PrintElement[]): Promise<void> {
  await Promise.all(elements.flatMap((el) => [
    restoreCachedImage(elements, el.id, "front"),
    restoreCachedImage(elements, el.id, "back"),
  ]));
  await Promise.all(elements.flatMap((el) => [
    tryRestoreHandle(elements, el.id, "front"),
    tryRestoreHandle(elements, el.id, "back"),
  ]));
}

export function hasMissingImages(elements: PrintElement[]): boolean {
  return elements.some((el) => !el.frontSrc || !el.backSrc);
}

async function pickMultipleFiles(): Promise<File[]> {
  if (isDesktopApp()) return [];
  if ("showOpenFilePicker" in window) {
    try {
      const handles: FileSystemFileHandle[] = await (window as unknown as {
        showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]>;
      }).showOpenFilePicker({
        types: [{ description: "Images", accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp", ".svg"] } }],
        multiple: true,
      });
      return Promise.all(handles.map((h) => h.getFile()));
    } catch {
      return [];
    }
  }
  return new Promise((res) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/png,image/jpeg,image/webp,image/svg+xml";
    input.onchange = () => res(input.files ? Array.from(input.files) : []);
    input.click();
  });
}

export async function pickFileForElement(elements: PrintElement[], id: string, side: Side): Promise<boolean> {
  if (isDesktopApp()) {
    try {
      const [path] = await openImagePaths(false);
      return path ? await loadPathIntoElement(elements, id, side, await persistAssetPath(path)) : false;
    } catch {
      return false;
    }
  }
  if ("showOpenFilePicker" in window) {
    try {
      const [handle] = await (window as unknown as {
        showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]>;
      }).showOpenFilePicker({
        types: [{ description: "Images", accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp", ".svg"] } }],
        multiple: false,
      });
      const file = await handle.getFile();
      return loadFileIntoElement(elements, id, side, file, handle);
    } catch {
      return false;
    }
  }
  return new Promise((res) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/svg+xml";
    input.onchange = async () => res(input.files?.[0] ? await loadFileIntoElement(elements, id, side, input.files[0]) : false);
    input.click();
  });
}

export async function reconnectAll(elements: PrintElement[]): Promise<void> {
  const pairs = elements.flatMap((el) => {
    const sides: Side[] = [];
    if (!el.frontSrc) sides.push("front");
    if (!el.backSrc) sides.push("back");
    return sides.map((side) => ({ id: el.id, side }));
  });
  for (const { id, side } of pairs) {
    await requestHandlePermission(elements, id, side);
  }

  const stillMissing = elements.flatMap((el) => {
    const missing: Array<{ id: string; side: Side; name: string }> = [];
    if (!el.frontSrc) missing.push({ id: el.id, side: "front", name: el.name });
    if (!el.backSrc) missing.push({ id: el.id, side: "back", name: el.name });
    return missing;
  });
  if (stillMissing.length === 0) return;

  if (isDesktopApp()) {
    const paths = await openImagePaths(true);
    if (paths.length === 0) return;
    const pathMap = new Map<string, string>();
    for (const path of paths) pathMap.set(normName(basename(path)), await persistAssetPath(path));
    for (const missing of stillMissing) {
      const path = pathMap.get(normName(missing.name));
      if (path) await loadPathIntoElement(elements, missing.id, missing.side, path);
    }
    return;
  }

  const files = await pickMultipleFiles();
  if (files.length === 0) return;

  const fileMap = new Map<string, File>();
  for (const file of files) fileMap.set(normName(file.name), file);

  for (const missing of stillMissing) {
    const file = fileMap.get(normName(missing.name));
    if (file) await loadFileIntoElement(elements, missing.id, missing.side, file);
  }
}

function mimeFromDataUrl(dataUrl: string): string {
  return dataUrl.split(";")[0].split(":")[1] ?? "image/png";
}

function extFromMime(mime: string): string {
  return ({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg" } as Record<string, string>)[mime] ?? ".bin";
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const [header, data] = dataUrl.split(",");
  if (header.includes("base64")) {
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(decodeURIComponent(data));
}

function bytesToDataUrl(bytes: Uint8Array, filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "svg") {
    return `data:image/svg+xml,${encodeURIComponent(new TextDecoder().decode(bytes))}`;
  }
  const mime = ({ png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as Record<string, string>)[ext] ?? "image/png";
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}

export async function saveProject(state: PersistedState, embedImages: boolean): Promise<void> {
  const { zip, strToU8 } = await import("fflate");
  const files: Record<string, [Uint8Array, import("fflate").DeflateOptions]> = {};

  const manifestElements: ProjectManifest["elements"] = state.elements.map((el) => {
    const { frontSrc, backSrc, ...rest } = el;
    const entry: ProjectManifest["elements"][0] = { ...rest };
    if (embedImages) {
      if (frontSrc) {
        const mime = mimeFromDataUrl(frontSrc);
        const ref = `images/${el.id}-front${extFromMime(mime)}`;
        files[ref] = [dataUrlToBytes(frontSrc), { level: mime === "image/svg+xml" ? 6 : 0 }];
        entry.frontRef = ref;
      }
      if (backSrc) {
        const mime = mimeFromDataUrl(backSrc);
        const ref = `images/${el.id}-back${extFromMime(mime)}`;
        files[ref] = [dataUrlToBytes(backSrc), { level: mime === "image/svg+xml" ? 6 : 0 }];
        entry.backRef = ref;
      }
    }
    return entry;
  });

  const pageBackRefs: (string | undefined)[] = state.pages.map((_, i) => {
    const src = state.globalBackSrcs[i];
    if (!embedImages || !src) return undefined;
    const mime = mimeFromDataUrl(src);
    const ref = `images/global-back-${i}${extFromMime(mime)}`;
    files[ref] = [dataUrlToBytes(src), { level: mime === "image/svg+xml" ? 6 : 0 }];
    return ref;
  });

  const manifest: ProjectManifest = {
    version: 2,
    elements: manifestElements,
    pages: state.pages,
    currentPageIndex: state.currentPageIndex,
    nextId: state.nextId,
    importedFonts: state.importedFonts,
    pageBackRefs,
  };
  files["project.json"] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];

  const zipBytes = await new Promise<Uint8Array>((res, rej) => zip(files, (err, data) => err ? rej(err) : res(data)));
  if (isDesktopApp()) {
    const path = await saveProjectPath("print-layout.aegis");
    if (!path) return;
    await writeBinaryPath(path, zipBytes);
    return;
  }
  const blob = new Blob([zipBytes.buffer as ArrayBuffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "print-layout.aegis";
  a.click();
  URL.revokeObjectURL(url);
}

export async function loadProject(): Promise<PersistedState | null> {
  if (isDesktopApp()) {
    const path = await openProjectPath();
    if (!path) return null;
    return loadProjectFromBytes(await readBinaryPath(path));
  }
  const rawBytes = await new Promise<Uint8Array | null>((res) => {
    if ("showOpenFilePicker" in window) {
      (window as unknown as { showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]> })
        .showOpenFilePicker({ types: [{ description: "Print Layout Project", accept: { "application/octet-stream": [".aegis"] } }], multiple: false })
        .then(async ([handle]) => res(new Uint8Array(await (await handle.getFile()).arrayBuffer())))
        .catch(() => res(null));
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".aegis";
      input.onchange = () => input.files?.[0]
        ? input.files[0].arrayBuffer().then((b) => res(new Uint8Array(b)))
        : res(null);
      input.click();
    }
  });
  if (!rawBytes) return null;

  return loadProjectFromBytes(rawBytes);
}

async function loadProjectFromBytes(rawBytes: Uint8Array): Promise<PersistedState | null> {
  const { unzip } = await import("fflate");
  const files = await new Promise<Record<string, Uint8Array>>((res, rej) =>
    unzip(rawBytes, (err, data) => err ? rej(err) : res(data))
  );

  const manifest = JSON.parse(new TextDecoder().decode(files["project.json"])) as ProjectManifest;
  setImportedFonts(manifest.importedFonts ?? []);
  const elements = manifest.elements.map((e) => {
    const el: PrintElement = { ...e, frontSrc: null, backSrc: null, pageIndex: e.pageIndex ?? 0 };
    if (e.frontRef && files[e.frontRef]) el.frontSrc = patchSvgStretch(bytesToDataUrl(files[e.frontRef], e.frontRef));
    if (e.backRef && files[e.backRef]) el.backSrc = patchSvgStretch(bytesToDataUrl(files[e.backRef], e.backRef));
    return el;
  });

  const pages = manifest.pages?.length ? manifest.pages : [{ widthIn: 8.5, heightIn: 11, flipAxis: "long" as const }];
  const globalBackSrcs = pages.map((_, i) => {
    const ref = manifest.pageBackRefs?.[i] ?? (i === 0 ? manifest.globalBackRef : undefined);
    return ref && files[ref] ? patchSvgStretch(bytesToDataUrl(files[ref], ref)) : null;
  });

  for (let i = 0; i < pages.length; i++) {
    const src = globalBackSrcs[i];
    if (!src) continue;
    for (const el of elements) {
      if (el.pageIndex === i && !el.backSrc) el.backSrc = src;
    }
  }

  if (manifest.printBrightness != null) pages[0].brightness = manifest.printBrightness;
  if (manifest.printSaturation != null) pages[0].saturation = manifest.printSaturation;
  if (manifest.printContrast   != null) pages[0].contrast   = manifest.printContrast;
  if (manifest.printBlackPoint != null) pages[0].blackPoint = manifest.printBlackPoint;
  if (manifest.printWhitePoint != null) pages[0].whitePoint = manifest.printWhitePoint;

  return {
    elements,
    pages,
    currentPageIndex: Math.min(manifest.currentPageIndex ?? 0, pages.length - 1),
    nextId: manifest.nextId ?? elements.length + 1,
    globalBackSrcs,
    importedFonts: manifest.importedFonts ?? [],
  };
}

export async function restoreGlobalBacks(
  pages: PageSettings[],
  elements: PrintElement[],
  globalBackHandleKey: (idx: number) => string,
): Promise<(string | null)[]> {
  const globalBackSrcs = pages.map(() => null as string | null);
  for (let i = 0; i < pages.length; i++) {
    const cached = await loadCachedImage(globalBackHandleKey(i), "back");
    if (cached) {
      globalBackSrcs[i] = cached;
      for (const el of elements) {
        if (el.pageIndex === i) el.backSrc = cached;
      }
      continue;
    }
    const handle = await loadHandle(globalBackHandleKey(i), "back")
      ?? (i === 0 ? await loadHandle("global-back", "back") : null)
      ?? await loadHandle(globalBackHandleKey(i), "front")
      ?? (i === 0 ? await loadHandle("global-back", "front") : null);
    if (!handle) continue;
    try {
      const src = typeof handle === "string"
        ? patchSvgStretch(bytesToDataUrl(await readBinaryPath(handle), basename(handle)))
        : await (async () => {
            const perm = await (handle as unknown as { queryPermission(o: unknown): Promise<string> }).queryPermission({ mode: "read" });
            if (perm !== "granted") return null;
            return readFileAsDataUrl(await handle.getFile());
          })();
      if (!src) continue;
      globalBackSrcs[i] = src;
      for (const el of elements) {
        if (el.pageIndex === i) el.backSrc = src;
      }
    } catch {
      // permission denied or file gone
    }
  }
  return globalBackSrcs;
}
