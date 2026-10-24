// ─── PLATFORM TTS (ANDROID) ───────────────────────────────────────────────────
// The third speech engine, and the only one the Android build ships. Kokoro's
// ~90 MB of weights and 21 MB ONNX runtime are stripped from that bundle (see
// ./index.js), and the Android System WebView does not reliably implement the Web
// Speech API — `speechSynthesis` may exist and simply never make a sound. So the
// coach speaks through `android.speech.tts.TextToSpeech` via the f1android
// plugin.
//
// The contract deliberately matches the other two engines: `speakNative()`
// RESOLVES WHEN THE PHRASE ENDS, because the plugin parks the invoke until
// Android's UtteranceProgressListener fires. That is what lets the arbiter in
// BoxBoxApp advance its queue on the same `onDone` for all three paths.
//
// Readiness is polled rather than pushed. The engine initialises asynchronously
// (usually well under a second) and the plugin does emit a `tts_ready` event, but
// a listener needs a Channel and a teardown path to answer one question exactly
// once — polling is the smaller thing to own, and it is also how a device with
// its voice data missing reports that state.

import { callPlugin } from "../androidBridge.js";
import { inTauri, isAndroid } from "../env.js";

/** True only in the Android build — a folded build constant, like HAS_KOKORO. */
export const HAS_NATIVE_TTS = isAndroid;

let _ready  = false;
let _error  = null;   // e.g. "no English voice data installed" — user-fixable
let _voices = [];
let _initPromise = null;

/**
 * SYNCHRONOUS, like `isKokoroLoaded()` — the speech arbiter tests this inside a
 * render path, so it can never become a promise.
 */
export function isNativeTtsReady() { return _ready; }
export function nativeTtsError()   { return _error; }
export function nativeVoices()     { return _voices; }

/**
 * Wait for the platform engine to come up, then read its voice list.
 * Resolves `{ ready, error, voices }`; never rejects. Safe to call repeatedly —
 * concurrent callers share one in-flight attempt.
 */
export function loadNativeTts() {
  // `TAURI_ENV_PLATFORM=android npm run dev` previews the Android branches in a
  // desktop browser, where there is no IPC to poll — answer at once rather than
  // spending eight seconds asking nobody.
  if (!HAS_NATIVE_TTS || !inTauri) return Promise.resolve({ ready: false, error: null, voices: [] });
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    // ~8 s of patience: a cold TTS engine on a mid-range phone can take a second
    // or two, and the app's first spoken call may be a whole out-lap away anyway.
    for (let i = 0; i < 32; i++) {
      const st = await callPlugin("is_ready");
      if (st && st.ready) { _ready = true; _error = st.error || null; break; }
      if (st && st.error) _error = st.error;
      await new Promise(r => setTimeout(r, 250));
    }
    if (_ready) {
      const res = await callPlugin("voices");
      _voices = (res && res.voices) || [];
    } else if (!_error) {
      // Give up with a definite answer rather than sitting on "starting…"
      // forever: an engine that hasn't come up in eight seconds isn't going to.
      _error = "the device's speech engine did not start";
    }
    const result = { ready: _ready, error: _error, voices: _voices };
    // A failure must be retryable (installing voice data is user-fixable), so
    // clear the cached promise and let the next call poll again — don't pin a
    // permanent "failed" for the whole session.
    if (!_ready) _initPromise = null;
    return result;
  })();

  return _initPromise;
}

/**
 * Speak `text`, resolving when it finishes (or is preempted, or fails — all three
 * mean "the queue may advance").
 *
 * `flush` maps to QUEUE_FLUSH, which is the arbiter's own semantics: an urgent
 * corner call must not wait behind a debrief.
 */
export function speakNative(text, { rate = 1.0, pitch = 1.0, voice = null, flush = true } = {}) {
  if (!HAS_NATIVE_TTS) return Promise.resolve(null);
  return callPlugin("speak", { text, rate, pitch, voice: voice || null, flush });
}

/** Silence the engine. Every parked `speakNative` settles as a result. */
export function stopNative() {
  if (!HAS_NATIVE_TTS) return Promise.resolve(null);
  return callPlugin("stop");
}
