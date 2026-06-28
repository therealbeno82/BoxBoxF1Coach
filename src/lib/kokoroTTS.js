// ─── KOKORO NEURAL TTS ────────────────────────────────────────────────────────
// Runs the 82M-parameter Kokoro text-to-speech model 100% locally via
// Transformers.js — WebGPU when the browser supports it (fast + best quality),
// otherwise WASM. The library and model weights are imported/downloaded LAZILY
// the first time the user opts into this engine, so the base app stays light.
//
// First load fetches ~90 MB of weights from the Hugging Face CDN (needs internet
// once); transformers.js then caches them in the WebView's storage, so every
// launch after the first works fully offline (see src/lib/transformersConfig.js).
// The built-in browser voices need no download and work offline immediately.

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

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

export function isKokoroLoaded() { return !!_tts; }

// Load (download + initialise) the model. Safe to call repeatedly — the first
// call kicks off the load and every later call awaits the same promise.
export async function loadKokoro(onProgress) {
  if (_tts) return _tts;
  if (!_ttsPromise) {
    _ttsPromise = (async () => {
      // Share the same transformers.js policy as Whisper (download-on-first-use +
      // browser cache → offline after first run). kokoro-js uses the same env.
      const { configureTransformers } = await import("./transformersConfig.js");
      await configureTransformers();
      const { KokoroTTS } = await import("kokoro-js");
      const webgpu = typeof navigator !== "undefined" && !!navigator.gpu;
      const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        // WebGPU is dramatically faster and pairs best with full precision;
        // WASM falls back to an 8-bit quantised model (~90 MB) that still sounds great.
        dtype:  webgpu ? "fp32"   : "q8",
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
