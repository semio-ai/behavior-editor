import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The desktop app's page, built into app/dist, which the Tauri binary embeds:
 * `npm run build:app`.
 */
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // The language's and the device's wasm are megabytes: they are the editor.
    chunkSizeWarningLimit: 4096,
  },
  server: { port: 5189, strictPort: true },
});
