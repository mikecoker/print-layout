import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 1420,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || "0.0.0.0",
  },
});
