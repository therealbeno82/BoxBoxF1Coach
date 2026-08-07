// ─── KOKORO STUB (Android builds only) ────────────────────────────────────────
// vite.config.js aliases `lib/kokoroTTS.js` to this file when building for
// Android. An alias rather than dead-code elimination, because DCE is too late:
// Rollup builds the module graph — transforming kokoroTTS.js, which makes Vite's
// worker plugin `emitFile` the worker chunk plus kokoro-js and its own bundled
// 21.6 MB ORT wasm — and only tree-shakes afterwards. Measured: folding the
// `__HAS_KOKORO__` branch does drop the import from the entry chunk, but the
// three files still ship as orphans and dist/ stays at 30 MB. Aliasing stops the
// real module being resolved at all, which takes dist/ to ~6 MB.
//
// Nothing should reach these: lib/tts/index.js rejects on !__HAS_KOKORO__ before
// it ever awaits the import. They exist so the module's shape stays honest.

const unavailable = () =>
  Promise.reject(new Error("Kokoro is not included in the Android build"));

export const loadKokoro = unavailable;
export const synthesize = unavailable;
export function isKokoroLoaded() {
  return false;
}

export { KOKORO_VOICES, DEFAULT_KOKORO_VOICE } from "./voices.js";
