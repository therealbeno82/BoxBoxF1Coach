import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// Single source of truth for the running build's version: read it straight from
// package.json and inline it as __APP_VERSION__ so the update check (see
// src/lib/updateCheck.js) can compare against the latest GitHub release without
// a runtime Tauri call. Keep package.json + tauri.conf.json versions in sync.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

// Port 1420 is Tauri's conventional dev port — keeping it here means the
// Tauri shell we add later can point at this same dev server with no changes.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    // Default to Tauri's conventional 1420, but honour a PORT override (e.g. a
    // preview harness that assigns its own port to avoid clashing with another
    // running dev server).
    port: process.env.PORT ? Number(process.env.PORT) : 1420,
    strictPort: false,
  },
  // kokoro-js pulls in @huggingface/transformers + onnxruntime-web, which ship
  // their own .wasm and worker assets. Pre-bundling them with esbuild breaks
  // those asset URLs, so exclude them and let Vite serve them as-is. They're
  // only loaded lazily when the user switches to the Kokoro voice engine.
  optimizeDeps: {
    exclude: ["kokoro-js", "@huggingface/transformers"],
  },
});
