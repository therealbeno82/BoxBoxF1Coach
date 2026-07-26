// ─── KOKORO TTS WORKER ────────────────────────────────────────────────────────
// All heavy Kokoro work — the model load and every synthesis pass — runs here,
// in a dedicated module worker, so the 82M-parameter wasm inference never blocks
// the UI thread. (It used to: ORT-web's wasm backend executes on the calling
// thread, so each generate() froze the app for seconds — and the corner-call
// prewarm that fires when a reference lap is first selected froze it for the
// whole phrase list.) The main-thread side is the thin client in kokoroTTS.js.
//
// Protocol: the client posts { id, type: "load" | "synthesize", text, voice,
// speed } and gets back { id, ok, audio?, sampleRate?, error? } — audio is a
// Float32Array whose buffer is transferred, not copied. Model-download progress
// streams as id-less { type: "progress", data } events.
//
// kokoro-js bundles its OWN copy of onnxruntime-web + @huggingface/transformers
// (rolled up into dist/kokoro.web.js), and it has no `env.allowLocalModels` /
// `localModelPath` escape hatch (only `env.wasmPaths` is exported). So instead of
// configuring it, we (a) point its ORT wasm at the /ort/ copy that
// scripts/copy-ort.mjs vendors, and (b) patch `fetch` (this worker's global —
// kokoro-js runs entirely in here) to redirect its hardcoded Hugging Face Hub
// requests (model weights, tokenizer, and — for voice style vectors specifically
// — a fetch that bypasses transformers.js entirely) to the files vendored under
// public/kokoro/ by scripts/fetch-kokoro-model.mjs. Net result: no network access
// and no CDN needed at runtime, so the packaged app's CSP can't break speech.
//
// Only the q8-quantized weights are bundled (~90 MB) — not fp32 — to keep the
// installer size down, so dtype is pinned to "q8" regardless of WebGPU support.

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const HF_REPO_PREFIX = `https://huggingface.co/${MODEL_ID}/resolve/main/`;

let _tts = null;          // the loaded model, once ready
let _loadPromise = null;  // in-flight load, so concurrent messages share it
let _fetchPatched = false;

function patchFetchForBundledKokoro() {
  if (_fetchPatched) return;
  _fetchPatched = true;
  const localBase = `${import.meta.env.BASE_URL}kokoro/`;
  const originalFetch = self.fetch.bind(self);
  self.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url;
    if (url && url.startsWith(HF_REPO_PREFIX)) {
      return originalFetch(localBase + url.slice(HF_REPO_PREFIX.length), init);
    }
    return originalFetch(input, init);
  };
}

async function ensureLoaded() {
  if (_tts) return _tts;
  if (!_loadPromise) {
    _loadPromise = (async () => {
      patchFetchForBundledKokoro();
      const { KokoroTTS, env: kokoroEnv } = await import("kokoro-js");
      // kokoro-js's bundled ORT defaults to the jsdelivr CDN, which the packaged
      // app's CSP blocks — point it at the local copy vendored into public/ort/
      // (see scripts/copy-ort.mjs). Production only: the Vite dev
      // server refuses to serve public/ files as module imports (ORT dynamically
      // imports the .mjs glue), so dev falls back to the CDN default — allowed by
      // the browser (no CSP) and by devCsp, which whitelists cdn.jsdelivr.net.
      if (import.meta.env.PROD) {
        kokoroEnv.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
      }
      const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype:  "q8",  // the only precision bundled locally — see header comment
        device: "wasm", // q8 on webgpu yields garbled audio; kokoro-js pairs webgpu with fp32 only
        // Forward only the fields the UI progress bar reads — the raw callback
        // object isn't guaranteed structured-cloneable across library versions.
        progress_callback: (p) => self.postMessage({
          type: "progress",
          data: { status: p?.status, file: p?.file, progress: p?.progress, loaded: p?.loaded, total: p?.total },
        }),
      });
      _tts = tts;
      return tts;
    })().catch((err) => { _loadPromise = null; throw err; });
  }
  return _loadPromise;
}

self.onmessage = async (e) => {
  const { id, type, text, voice, speed } = e.data || {};
  try {
    if (type === "load") {
      await ensureLoaded();
      self.postMessage({ id, ok: true });
    } else if (type === "synthesize") {
      const tts = await ensureLoaded();
      const raw = await tts.generate(text, { voice, speed });
      const audio = raw.audio instanceof Float32Array ? raw.audio : new Float32Array(raw.audio);
      self.postMessage({ id, ok: true, audio, sampleRate: raw.sampling_rate }, [audio.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
