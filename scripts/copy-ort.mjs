// ─── BUNDLE THE ONNX RUNTIME WASM LOCALLY ──────────────────────────────────────
// Kokoro TTS + Whisper STT run on onnxruntime-web (via @huggingface/transformers).
// By default transformers.js points ORT's WASM runtime at the jsdelivr CDN, which
// the packaged app's Content-Security-Policy blocks — so the model never starts in
// the built .exe (it only works in `npm run dev`, where no CSP is enforced).
//
// We instead serve the runtime from our own origin. This copies the two ORT files
// from node_modules into public/ort/ so Vite emits them verbatim to dist/ort/ (no
// content-hash → stable filenames, which ORT requires). transformersConfig.js then
// pins env.backends.onnx.wasm.wasmPaths to "/ort/". Running this on predev/prebuild
// keeps the bundled copy locked to the installed transformers version.

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = resolve(root, "node_modules/@huggingface/transformers/dist");
const outDir = resolve(root, "public/ort");

const FILES = [
  "ort-wasm-simd-threaded.jsep.wasm", // the runtime (~21 MB)
  "ort-wasm-simd-threaded.jsep.mjs",  // Emscripten glue ORT fetches alongside it
];

mkdirSync(outDir, { recursive: true });
for (const f of FILES) {
  const from = resolve(srcDir, f);
  if (!existsSync(from)) {
    console.error(`[copy-ort] missing ${from} — is @huggingface/transformers installed?`);
    process.exit(1);
  }
  copyFileSync(from, resolve(outDir, f));
  console.log(`[copy-ort] ${f} → public/ort/`);
}
