// ─── KOKORO VOICE LIST (pure data) ────────────────────────────────────────────
// Split out of kokoroTTS.js so the Settings UI can name a voice without pulling
// the worker client into the module graph. That separation is what keeps the
// Android bundle free of kokoro-js: importing kokoroTTS.js at all makes Vite
// transform it, and transforming it emits the worker chunk (plus kokoro-js and
// its bundled 21 MB ORT wasm) whether or not the code path is reachable.

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
