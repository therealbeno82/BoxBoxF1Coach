// ─── ENVIRONMENT ─────────────────────────────────────────────────────────────
// True only inside the Tauri webview. In a plain browser (`npm run dev`) there
// is no IPC, so callers skip `invoke`/`listen` rather than throw. Single source
// of truth — do not re-declare this probe per file.
export const inTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

// True in the Android build only. A BUILD-TIME constant (vite.config.js reads
// Tauri's TAURI_ENV_PLATFORM), not a runtime user-agent sniff — so Rollup folds
// the branches and the excluded screens' code can be dropped rather than shipped
// unreachable. Android deliberately leaves out three desktop-only things:
//   • FFB      — drives a wheel over SDL2; no Android counterpart, and the Rust
//                side is already cfg'd out, so the panel would only ever say
//                "WAITING…" at you.
//   • OpenRouter LLM — the between-lap analyst. The deterministic rule-engine
//                coach STAYS; only the cloud call and its API-key UI go.
//   • Trace Calibrator — a mouse-only drag/resize tool (raw onMouseDown, thin
//                edge hit-areas); unusable by touch and not worth porting.
export const isAndroid = __IS_ANDROID__;
