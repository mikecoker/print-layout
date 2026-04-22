# Standalone App Plan

## Goal

Convert the current Vite web app into a portable desktop app with reliable local file access, stable image references, and a project format that does not depend on browser storage behavior.

## Why Desktop

The current web app relies on:

- `localStorage` for layout state
- `IndexedDB` for cached image data and persisted file handles
- optional browser `FileSystemFileHandle` APIs for reconnecting images

That model is inherently fragile in a browser. Handles can lose permission, storage can be cleared or evicted, and image state gets split across multiple browser-managed stores. The result is the image loss and reconnection flow you are seeing.

## Chosen Direction

Use Tauri v2 with the existing Vite frontend.

Reasons:

- small app footprint compared with Electron
- native file dialogs and file system access
- good fit for an existing frontend-only app
- better path to portable project files and autosave

## Product Shape

### Project Modes

Support two save modes:

1. Portable project
   - Save a single `.aegis` bundle with embedded images.
   - Best for moving projects between machines.

2. Linked project
   - Save a project manifest on disk plus explicit file paths to source images.
   - Best for large local image libraries.

The portable mode should become the default because it directly addresses missing-image issues.

### Storage Model

Replace browser-only persistence with desktop-native persistence:

- autosave current workspace into the app data directory
- save/open real project files with native dialogs
- track the current project path and dirty state
- keep a recent-projects list in app data

## Technical Plan

### Phase 1: Tauri Shell

- add `src-tauri/` for Tauri v2
- update `package.json` scripts for `tauri dev` and `tauri build`
- configure Tauri to load Vite in dev and `dist/` in production

### Phase 2: File Access Abstraction

Create a frontend storage layer so the app no longer talks directly to browser file APIs from UI code.

Targets:

- wrap file open/save dialogs
- wrap project load/save
- wrap image import and image byte reads
- expose environment detection: web vs Tauri

### Phase 3: Persistence Refactor

- keep the current browser fallback for web mode
- in desktop mode, stop depending on `localStorage` and `IndexedDB` for primary project state
- move autosave to the app data directory
- use file paths or copied assets instead of browser file handles

### Phase 4: Portability

- make `.aegis` the default portable format
- optionally add unpacked folder mode later if manual editing is useful
- ensure the app can reopen embedded-image projects without reconnect prompts

### Phase 5: Packaging

- produce signed desktop builds later if needed
- also produce unpacked bundles or portable archives for local distribution
- verify macOS and Windows behavior around file paths and image reopening

## Implementation Notes

### Near-Term Refactors

- introduce a project session model:
  - `currentProjectPath`
  - `isDirty`
  - `saveMode`
- separate persisted project data from runtime-only image caches
- centralize all file dialog usage

### Risks

- Tauri v2 plugin permissions need to be configured correctly for file access
- linked-path projects need a clear relink flow if files move
- autosave should avoid overwriting a deliberate project file unexpectedly

## Execution Order

1. Add Tauri scaffolding and npm scripts.
2. Add desktop environment detection and a file/project adapter.
3. Route save/open through the adapter.
4. Add autosave in app data for desktop mode.
5. Migrate image imports away from browser handle persistence in desktop mode.
6. Verify web fallback still works.

## Definition Of Done

- app runs in Tauri dev mode
- desktop app can import images from disk reliably
- desktop app can save and reopen projects without losing images
- portable `.aegis` workflow works without browser reconnect prompts
- current web mode still builds and remains usable as a fallback
