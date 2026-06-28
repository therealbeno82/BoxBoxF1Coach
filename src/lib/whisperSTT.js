// ─── WHISPER SPEECH-TO-TEXT ───────────────────────────────────────────────────
// Offline speech recognition with OpenAI's Whisper, run 100% locally in the
// browser/WebView via Transformers.js — WebGPU when the browser supports it,
// otherwise WASM. This replaces the old Web Speech API (which is cloud-backed in
// Chrome/Edge and needs internet); the model is downloaded LAZILY the first time
// the driver actually uses the mic, so the base app stays light.
//
// Mirrors src/lib/kokoroTTS.js on purpose: lazy singleton + progress callback,
// and both share one transformers.js policy (src/lib/transformersConfig.js).
//
// First load fetches the model weights (~73 MB q8) from the Hugging Face CDN
// (needs internet once); transformers.js then caches them in the WebView's
// storage, so every launch after the first transcribes fully offline.

// Transformers.js (+ its ~21 MB onnxruntime WASM) is imported LAZILY inside
// loadWhisper(), exactly like src/lib/kokoroTTS.js dynamically imports kokoro-js —
// so merely importing this module (the mic hook does) never pulls the heavy ML
// runtime into the initial bundle. It loads only when the driver first speaks.

// English-only base model: a good accuracy/latency balance for short push-to-talk
// coaching questions. `.en` is smaller and more accurate than multilingual for
// English speech. Swappable here if a different size is wanted.
const MODEL_ID = "onnx-community/whisper-base.en";

// Whisper expects 16 kHz mono audio.
const TARGET_SAMPLE_RATE = 16000;

let _asr = null; // the loaded pipeline, once ready
let _asrPromise = null; // in-flight load, shared by concurrent callers

export function isWhisperLoaded() { return !!_asr; }

// Load (download + initialise) the model. Safe to call repeatedly — the first
// call kicks off the load and every later call awaits the same promise.
export async function loadWhisper(onProgress) {
  if (_asr) return _asr;
  if (!_asrPromise) {
    _asrPromise = (async () => {
      const { configureTransformers } = await import("./transformersConfig.js");
      await configureTransformers();
      const { pipeline } = await import("@huggingface/transformers");
      const webgpu = typeof navigator !== "undefined" && !!navigator.gpu;
      const asr = await pipeline("automatic-speech-recognition", MODEL_ID, {
        // q8 weights run well on both backends and keep the download small.
        dtype: "q8",
        device: webgpu ? "webgpu" : "wasm",
        progress_callback: onProgress,
      });
      _asr = asr;
      return asr;
    })().catch((err) => { _asrPromise = null; throw err; });
  }
  return _asrPromise;
}

// Down-mix to mono and resample to 16 kHz using an OfflineAudioContext — the
// browser's own high-quality resampler — returning the Float32Array Whisper wants.
async function toMono16k(audioBuffer) {
  const frames = Math.max(1, Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

// Decode a recorded audio Blob (webm/opus from MediaRecorder) → 16 kHz mono PCM.
export async function blobToPcm(blob) {
  const arrayBuf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuf);
    return await toMono16k(decoded);
  } finally {
    ctx.close();
  }
}

// Transcribe 16 kHz mono PCM (Float32Array) → trimmed text.
// NB: MODEL_ID is the English-only (`.en`) Whisper, which rejects `language`/`task`
// options — they're only valid for the multilingual models. So we don't pass them.
export async function transcribe(pcm) {
  const asr = await loadWhisper();
  const out = await asr(pcm, { chunk_length_s: 30 });
  return (out?.text || "").trim();
}

// Convenience: a recorded Blob straight to text.
export async function transcribeBlob(blob) {
  const pcm = await blobToPcm(blob);
  return transcribe(pcm);
}
