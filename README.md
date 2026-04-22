# Print Layout

Print Layout is a standalone desktop app for laying out printable cards and similar front/back assets on physical sheets.

It is built for workflows where browser-based file access is too fragile. The desktop version keeps imported assets available across app restarts, supports project save/load, and exports print-ready PDFs.

## What It Does

- import card fronts and backs from SVG, PNG, JPEG, and WebP files
- place items on one or more sheets with auto-layout
- apply per-sheet and per-element bleed settings
- set a shared back image for a sheet
- import font files for SVG text rendering consistency
- export duplex-friendly PDFs
- save and reopen portable project files

## Why This Exists

The original web version ran into browser storage and file-access issues, especially around losing image references. This standalone Tauri app moves the workflow onto local desktop file APIs so imports, autosave, and project reloads are more reliable.

## Tech Stack

- Vite + TypeScript frontend
- Tauri desktop shell
- pdf-lib for PDF generation
- fflate for portable project packaging

## Development

Install dependencies:

```bash
npm install
```

Run the desktop app in development mode:

```bash
npm run tauri:dev
```

## Production Build

Build distributable desktop artifacts:

```bash
npm run tauri:build
```

## Release Workflow

GitHub Actions is configured to build release artifacts for macOS and Windows on pushed tags matching `v*`.

Example:

```bash
git tag v0.0.1
git push origin v0.0.1
```
