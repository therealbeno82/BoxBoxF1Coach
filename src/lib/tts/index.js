// ─── TTS FAÇADE ───────────────────────────────────────────────────────────────
// The app's single import point for speech synthesis. It exists to keep the heavy
// Kokoro client OUT of the static module graph, because Vite's worker handling is
// eager: transforming a module that contains `new Worker(new URL(...))` emits the
// worker chunk — and kokoro-js, @huggingface/transformers and their own bundled
// 21.6 MB copy of the ORT wasm along with it — regardless of whether the code path
// can ever run. A dead `if (false)` branch does NOT prevent that (measured: the
// bundle stayed at 30 MB); only keeping the module out of the graph does.
//
// So Kokoro is reached exclusively through a dynamic import behind
// `__HAS_KOKORO__`, a build-time constant Rollup folds. On Android that branch is
// statically dead, the module is never transformed, and dist/ drops to ~6 MB.
//
// The API mirrors the one BoxBoxApp has always used, including the SYNCHRONOUS
// `isKokoroLoaded()` — the speech arbiter tests it inside a render path and in a
// useState initialiser, so it can't become a promise. A local mirror of the flag
// keeps that contract; it is only ever set from the real module's own answer.

export { KOKORO_VOICES, DEFAULT_KOKORO_VOICE } from "./voices.js";

// The platform engine (Android only). It is a handful of `invoke` calls with no
// worker and no model, so unlike Kokoro it costs nothing to have in the graph —
// on desktop `HAS_NATIVE_TTS` folds to false and the calls fold away with it.
// Re-exported here so the app still has ONE import point for speech.
export {
  HAS_NATIVE_TTS, isNativeTtsReady, nativeTtsError, nativeVoices,
  loadNativeTts, speakNative, stopNative,
} from "./native.js";

/** True when this build ships Kokoro at all (false on Android). */
export const HAS_KOKORO = __HAS_KOKORO__;

let _mod = null;      // the resolved kokoroTTS module
let _modPromise = null;
let _loaded = false;  // mirrors _mod.isKokoroLoaded() — see note above

/** Synchronous, and false until the model is genuinely ready in the worker. */
export function isKokoroLoaded() {
  return _loaded;
}

function kokoro() {
  if (!__HAS_KOKORO__) {
    return Promise.reject(new Error("Kokoro is not included in this build"));
  }
  // Concurrent callers share one in-flight import rather than racing.
  if (!_modPromise) {
    _modPromise = import("../kokoroTTS.js").then((m) => {
      _mod = m;
      return m;
    });
  }
  return _modPromise;
}

/** Download + initialise the model. Safe to call repeatedly. */
export async function loadKokoro(onProgress) {
  const m = await kokoro();
  const ok = await m.loadKokoro(onProgress);
  _loaded = m.isKokoroLoaded();
  return ok;
}

/** Synthesise `text` to raw mono audio for the Web Audio API. */
export async function synthesize(text, voice, speed) {
  const m = await kokoro();
  const out = await m.synthesize(text, voice, speed);
  // synthesize() loads the model on a cache miss, so the flag can flip here too.
  _loaded = m.isKokoroLoaded();
  return out;
}
