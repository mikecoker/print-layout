# Print Layout

**Web app:** https://mikecoker.github.io/print-layout/

Print Layout is a tool for laying out printable cards and similar front/back assets on physical sheets. It runs as a web app and as a standalone desktop app.

The desktop version keeps imported assets available across app restarts, supports project save/load, and exports print-ready PDFs.

## What It Does

- import card fronts and backs from SVG, PNG, JPEG, and WebP files
- place items on one or more sheets with auto-layout
- apply per-sheet and per-element bleed settings
- set a shared back image for a sheet
- import font files for SVG text rendering consistency
- export duplex-friendly PDFs
- apply adjustments to the entire sheet or an individual element.

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
