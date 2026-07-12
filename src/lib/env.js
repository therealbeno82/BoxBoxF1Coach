// ─── ENVIRONMENT ─────────────────────────────────────────────────────────────
// True only inside the Tauri webview. In a plain browser (`npm run dev`) there
// is no IPC, so callers skip `invoke`/`listen` rather than throw. Single source
// of truth — do not re-declare this probe per file.
export const inTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
