// ─── KOKORO NEURAL TTS (main-thread client) ───────────────────────────────────
// Runs the 82M-parameter Kokoro text-to-speech model 100% locally — but not on
// this thread. All heavy work (model load + wasm inference) lives in a dedicated
// module worker (kokoroWorker.js): ORT-web's wasm backend executes on the thread
// that calls it, so running Kokoro here used to freeze the whole UI for seconds
// per phrase — worst on the corner-call prewarm that fires when a reference lap
// is first selected. This module is the thin promise-per-message client, keeping
// the same API the app always used: loadKokoro / synthesize / isKokoroLoaded.
//
// Synthesised clips are also cached in IndexedDB (keyed voice|speed|text), so
// the one-time cost of synthesising a track's corner calls is paid once EVER,
// not once per app run — after the first session on a track, prewarm is all
// cache hits and calls are instant from launch. The cache is LRU-pruned so
// one-shot AI tips/chat replies can't grow it unbounded.
//
// The worker is only spawned on first use, so the base app stays light.

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

// ── Worker plumbing: one lazy worker, promise-per-message by request id ────────
let _worker = null;
let _pending = new Map();
let _nextId = 1;
let _loaded = false;       // model ready in the worker
let _loadPromise = null;   // in-flight load, so concurrent callers share it
let _onProgress = null;    // forwarded download-progress callback for the UI

function getWorker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL("./kokoroWorker.js", import.meta.url), { type: "module" });
  _worker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === "progress") { _onProgress?.(m.data); return; }
    const p = _pending.get(m.id);
    if (!p) return;
    _pending.delete(m.id);
    if (m.ok) p.resolve(m);
    else p.reject(new Error(m.error || "Kokoro worker error"));
  };
  // A worker-level crash (script load failure etc.) gets no per-id reply — fail
  // everything in flight so callers' catch paths run instead of hanging forever.
  _worker.onerror = (e) => {
    const err = new Error(e?.message || "Kokoro worker failed");
    for (const p of _pending.values()) p.reject(err);
    _pending.clear();
  };
  return _worker;
}

function callWorker(msg) {
  const id = _nextId++;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, ...msg });
  });
}

export function isKokoroLoaded() { return _loaded; }

// Load (download + initialise) the model in the worker. Safe to call repeatedly —
// the first call kicks off the load and every later call awaits the same promise.
export async function loadKokoro(onProgress) {
  if (onProgress) _onProgress = onProgress;
  if (_loaded) return true;
  if (!_loadPromise) {
    _loadPromise = callWorker({ type: "load" })
      .then(() => { _loaded = true; _onProgress = null; return true; })
      .catch((err) => { _loadPromise = null; _onProgress = null; throw err; });
  }
  return _loadPromise;
}

// Synthesise `text` and return raw mono audio ready for the Web Audio API.
// Persistent-cache first: a hit skips the worker (and even the model load)
// entirely; a miss synthesises off-thread and stores the clip for next launch.
export async function synthesize(text, voice = DEFAULT_KOKORO_VOICE, speed = 1) {
  const key = `${voice}|${speed}|${text}`;
  const hit = await cacheGet(key);
  if (hit) return hit;
  await loadKokoro();
  const { audio, sampleRate } = await callWorker({ type: "synthesize", text, voice, speed });
  cachePut(key, audio, sampleRate); // fire-and-forget — a failed write just means a re-synth later
  return { audio, sampleRate };
}

// ── Persistent clip cache (IndexedDB) ─────────────────────────────────────────
// Every helper resolves null / no-ops on any failure — IDB being unavailable or
// corrupt must never break speech, only make it slower.
const DB_NAME = "boxbox-tts-cache";
const DB_STORE = "clips";
const CACHE_CAP = 400; // ~a dozen tracks' call sets + plenty of one-shot tips

let _dbPromise = null;
function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(DB_STORE, { keyPath: "key" });
        store.createIndex("lastUsed", "lastUsed");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return _dbPromise;
}

async function cacheGet(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const store = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        const rec = req.result;
        if (rec?.audio instanceof Float32Array && rec.sampleRate > 0) {
          rec.lastUsed = Date.now(); // touch so frequently-played calls survive pruning
          try { store.put(rec); } catch {}
          resolve({ audio: rec.audio, sampleRate: rec.sampleRate });
        } else resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cachePut(key, audio, sampleRate) {
  const db = await openDb();
  if (!db) return;
  try {
    const store = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE);
    store.put({ key, audio, sampleRate, lastUsed: Date.now() });
    // Bound the store: walk the lastUsed index oldest-first, deleting the excess.
    const cnt = store.count();
    cnt.onsuccess = () => {
      let excess = cnt.result - CACHE_CAP;
      if (excess <= 0) return;
      const cursor = store.index("lastUsed").openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (c && excess-- > 0) { c.delete(); c.continue(); }
      };
    };
  } catch {}
}
