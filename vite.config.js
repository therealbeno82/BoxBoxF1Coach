import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Single source of truth for the running build's version: read it straight from
// package.json and inline it as __APP_VERSION__ so the update check (see
// src/lib/updateCheck.js) can compare against the latest GitHub release without
// a runtime Tauri call. Keep package.json + tauri.conf.json versions in sync.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

// Tauri exports TAURI_ENV_PLATFORM (windows|darwin|linux|android|ios) into the
// environment of beforeDevCommand/beforeBuildCommand, so the Android build keys
// off the platform it is actually building for — no extra npm script, and no
// flag anyone can forget to pass. Empty for a plain `npm run dev`/`npm run build`.
const isAndroid = process.env.TAURI_ENV_PLATFORM === "android";

// Android ships no Kokoro: it speaks through android.speech.tts instead, so the
// 88 MB model and the 21 MB ORT runtime have no reader there. `public/` is copied
// verbatim into dist/, which no amount of tree-shaking can reach — so delete the
// two directories after the copy. Deleting (rather than an explicit allow-list via
// publicDir:false) fails safe: a new asset dropped into public/ just works, and
// forgetting to update this can only ever ship MORE, never less.
function stripVoiceAssets() {
  return {
    name: "strip-voice-assets",
    apply: "build",
    closeBundle() {
      if (!isAndroid) return;
      for (const dir of ["kokoro", "ort"]) {
        const path = resolve(import.meta.dirname, "dist", dir);
        if (!existsSync(path)) continue;
        rmSync(path, { recursive: true, force: true });
        this.info?.(`[strip-voice-assets] removed dist/${dir}`);
      }
    },
  };
}

// The desktop build shipped the 21.6 MB ORT wasm TWICE: once as the vendored
// copy in dist/ort/ (from public/ort/, which scripts/copy-ort.mjs fills), and
// once as a hashed asset Vite emits because onnxruntime-web references the wasm
// with `new URL(…, import.meta.url)`. Production never fetches the hashed one —
// kokoroWorker.js points `wasmPaths` at /ort/ (the CSP blocks ORT's own CDN, and
// the hashed copy sits beside a glue .mjs that isn't emitted) — so it was 21.6 MB
// of installer for nothing. Delete it, but ONLY when the vendored copy is really
// there: if copy-ort ever stops running, the hashed asset is the one left.
function stripDuplicateOrt() {
  return {
    name: "strip-duplicate-ort",
    apply: "build",
    closeBundle() {
      if (isAndroid) return; // stripVoiceAssets removes both there
      const vendored = resolve(import.meta.dirname, "dist", "ort", "ort-wasm-simd-threaded.jsep.wasm");
      if (!existsSync(vendored)) return;
      const assets = resolve(import.meta.dirname, "dist", "assets");
      if (!existsSync(assets)) return;
      for (const f of readdirSync(assets)) {
        if (/^ort-wasm-simd-threaded\.jsep-[\w-]+\.wasm$/.test(f)) {
          rmSync(resolve(assets, f), { force: true });
          this.info?.(`[strip-duplicate-ort] removed dist/assets/${f}`);
        }
      }
    },
  };
}

// Port 1420 is Tauri's conventional dev port — keeping it here means the
// Tauri shell we add later can point at this same dev server with no changes.
export default defineConfig({
  plugins: [react(), stripVoiceAssets(), stripDuplicateOrt()],
  clearScreen: false,
  resolve: {
    // Swap the Kokoro client for a stub on Android. This has to be an ALIAS, not
    // a dead branch: Rollup builds the module graph before it tree-shakes, and
    // merely transforming kokoroTTS.js makes Vite's worker plugin emit the worker
    // chunk, kokoro-js, and its own bundled 21.6 MB ORT wasm. Folding the branch
    // does remove the reference, but still ships all three as orphans (measured:
    // dist/ stayed at 30 MB). Aliasing means the real module is never resolved.
    // Two NBs, both of which cost a build to learn. `find` is matched against the
    // import SPECIFIER, not the resolved path — lib/tts/index.js asks for
    // "../kokoroTTS.js", so anchoring on "lib/" silently never matches and the
    // build comes out byte-identical. And the match is a string REPLACE, so the
    // pattern must cover the whole specifier: a tail-only match leaves the "../"
    // glued to the front of the absolute replacement path.
    alias: isAndroid
      ? [{
          find: /^.*\/kokoroTTS\.js$/,
          replacement: resolve(import.meta.dirname, "src/lib/tts/kokoroStub.js"),
        }]
      : [],
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Rollup constant-folds this, so the Kokoro subgraph drops out of the Android
    // bundle entirely rather than shipping as unreachable code.
    __HAS_KOKORO__: JSON.stringify(!isAndroid),
    __IS_ANDROID__: JSON.stringify(isAndroid),
  },
  server: {
    // Default to Tauri's conventional 1420, but honour a PORT override (e.g. a
    // preview harness that assigns its own port to avoid clashing with another
    // running dev server).
    port: process.env.PORT ? Number(process.env.PORT) : 1420,
    strictPort: false,
  },
  // The Kokoro TTS worker (src/lib/kokoroWorker.js) lazily import()s kokoro-js,
  // which splits the worker bundle into chunks — only the "es" worker format
  // supports that (the "iife" default errors). Module workers are fine in every
  // runtime we target (WebView2 + modern browsers).
  worker: {
    format: "es",
  },
  // kokoro-js pulls in @huggingface/transformers + onnxruntime-web, which ship
  // their own .wasm and worker assets. Pre-bundling them with esbuild breaks
  // those asset URLs, so exclude them and let Vite serve them as-is. They're
  // only loaded lazily when the user switches to the Kokoro voice engine.
  optimizeDeps: {
    exclude: ["kokoro-js", "@huggingface/transformers"],
  },
});
