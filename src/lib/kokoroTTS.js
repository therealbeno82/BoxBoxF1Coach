// ─── KOKORO NEURAL TTS ────────────────────────────────────────────────────────
// Runs the 82M-parameter Kokoro text-to-speech model 100% locally via
// Transformers.js. The library is imported LAZILY the first time the user opts
// into this engine, so the base app stays light.
//
// kokoro-js bundles its OWN copy of onnxruntime-web + @huggingface/transformers
// (rolled up into dist/kokoro.web.js) — it does NOT share the app's copy that
// src/lib/transformersConfig.js configures, and it has no `env.allowLocalModels`/
// `localModelPath` escape hatch (only `env.wasmPaths` is exported). So instead of
// configuring it, we (a) point its ORT wasm at our bundled /ort/ copy the same way
// transformersConfig.js does for Whisper, and (b) patch `fetch` to redirect its
// hardcoded Hugging Face Hub requests (model weights, tokenizer, and — for voice
// style vectors specifically — a fetch that bypasses transformers.js entirely) to
// the files vendored under public/kokoro/ by scripts/fetch-kokoro-model.mjs. Net
// result: no network access and no CDN needed at runtime, matching the CSP-block
// fix already in place for Whisper (see src/lib/transformersConfig.js).
//
// Only the q8-quantized weights are bundled (~90 MB) — not fp32 — to keep the
// installer size down, so dtype is pinned to "q8" regardless of WebGPU support.

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const HF_REPO_PREFIX = `https://huggingface.co/${MODEL_ID}/resolve/main/`;

// Curated, accent-grouped voice list. Kokoro v1.0 ships American + British
// English only (no Australian — use the browser engine's Google AU voice for
// that). Ordered best-quality-first within each accent. ★ marks the top grades.
export const KOKORO_VOICES = [
  // British — fits the classic F1 race-engineer voice
  { id: "bm_george",   label: "George — British male",     accent: "British"  },
  { id: "bm_lewis",    label: "Lewis — British male",      accent: "British"  },
  { id: "bm_fable",    label: "Fable — British male",      accent: "British"  },
  { id: "bm_daniel",   label: "Daniel — British male",     accent: "British"  },
  { id: "bf_emma",     label: "Emma — British female",     accent: "British"  },
  { id: "bf_isabella", label: "Isabella — British female", accent: "British"  },
  { id: "bf_alice",    label: "Alice — British female",    accent: "British"  },
  { id: "bf_lily",     label: "Lily — British female",     accent: "British"  },
  // American
  { id: "af_heart",    label: "Heart — American female ★", accent: "American" },
  { id: "af_bella",    label: "Bella — American female ★", accent: "American" },
  { id: "af_nicole",   label: "Nicole — American female",  accent: "American" },
  { id: "af_sarah",    label: "Sarah — American female",   accent: "American" },
  { id: "af_kore",     label: "Kore — American female",    accent: "American" },
  { id: "am_michael",  label: "Michael — American male",   accent: "American" },
  { id: "am_fenrir",   label: "Fenrir — American male",    accent: "American" },
  { id: "am_puck",     label: "Puck — American male",      accent: "American" },
  { id: "am_onyx",     label: "Onyx — American male",      accent: "American" },
];

export const DEFAULT_KOKORO_VOICE = "bm_george";

let _tts = null;          // the loaded model, once ready
let _ttsPromise = null;   // in-flight load, so concurrent callers share it
let _fetchPatched = false;

export function isKokoroLoaded() { return !!_tts; }

// Redirect kokoro-js's hardcoded `https://huggingface.co/onnx-community/Kokoro-…`
// requests to the local copy vendored under public/kokoro/ (see HF_REPO_PREFIX
// header comment above for why this can't be done via transformers.js env config).
function patchFetchForBundledKokoro() {
  if (_fetchPatched) return;
  _fetchPatched = true;
  const localBase = `${import.meta.env.BASE_URL}kokoro/`;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url;
    if (url && url.startsWith(HF_REPO_PREFIX)) {
      return originalFetch(localBase + url.slice(HF_REPO_PREFIX.length), init);
    }
    return originalFetch(input, init);
  };
}

// Load (download + initialise) the model. Safe to call repeatedly — the first
// call kicks off the load and every later call awaits the same promise.
export async function loadKokoro(onProgress) {
  if (_tts) return _tts;
  if (!_ttsPromise) {
    _ttsPromise = (async () => {
      patchFetchForBundledKokoro();
      const { KokoroTTS, env: kokoroEnv } = await import("kokoro-js");
      // kokoro-js's bundled ORT defaults to the jsdelivr CDN, which the packaged
      // app's CSP blocks — point it at the same local copy transformersConfig.js
      // uses for Whisper (see scripts/copy-ort.mjs).
      kokoroEnv.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
      const webgpu = typeof navigator !== "undefined" && !!navigator.gpu;
      const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype:  "q8", // the only precision bundled locally — see header comment
        device: webgpu ? "webgpu" : "wasm",
        progress_callback: onProgress,
      });
      _tts = tts;
      return tts;
    })().catch(err => { _ttsPromise = null; throw err; });
  }
  return _ttsPromise;
}

// Synthesise `text` and return raw mono audio ready for the Web Audio API.
export async function synthesize(text, voice = DEFAULT_KOKORO_VOICE, speed = 1) {
  const tts = await loadKokoro();
  const raw = await tts.generate(text, { voice, speed });
  return { audio: raw.audio, sampleRate: raw.sampling_rate };
}
