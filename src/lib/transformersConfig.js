// ─── TRANSFORMERS.JS RUNTIME CONFIG (shared by Whisper STT + Kokoro TTS) ───────
// Both the offline speech-to-text (whisperSTT.js) and the neural voice
// (kokoroTTS.js → kokoro-js) run on the SAME @huggingface/transformers instance
// (npm dedupes it to one copy), so its global `env` is shared. We configure it
// once, here, and call configureTransformers() from each model's lazy loader
// before the first pipeline call.
//
// Policy: DOWNLOAD-ON-FIRST-USE (weights are not bundled in the installer).
//   • allowLocalModels = false  → we ship no local model files, so don't waste a
//     round-trip 404-ing for `/models/...` before falling back to the CDN.
//   • allowRemoteModels = true  → fetch weights from the Hugging Face CDN the
//     first time the driver uses voice in/out.
//   • useBrowserCache = true    → persist them in the WebView's Cache storage so
//     every launch after the first works fully offline (no network needed).

let _configured = false;

export async function configureTransformers() {
  if (_configured) return;
  const { env } = await import("@huggingface/transformers");
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
  // Serve the ONNX runtime WASM from our own bundle instead of the jsdelivr CDN
  // transformers.js defaults to (that default is set at module load — see
  // node_modules/@huggingface/transformers/src/backends/onnx.js — so we override it
  // here, after import and before any model loads). The CDN is blocked by the
  // packaged app's CSP; a same-origin "/ort/" path passes 'self' and stays offline.
  // BASE_URL is "/" in the Tauri build → resolves to "/ort/" (see scripts/copy-ort.mjs).
  env.backends.onnx.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
  _configured = true;
}
