import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port 1420 is Tauri's conventional dev port — keeping it here means the
// Tauri shell we add later can point at this same dev server with no changes.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
