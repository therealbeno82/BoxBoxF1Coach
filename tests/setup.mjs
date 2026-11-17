// ─── TEST SETUP ────────────────────────────────────────────────────────────────
// `npm test` runs the pure modules under src/lib straight in Node (node --test, no
// test-framework dependency). A few of them read build-time constants that Vite's
// `define` normally inlines; in Node those are just undefined globals, so give
// them the desktop values here. Loaded with `--import` before any test file.

globalThis.__IS_ANDROID__ = false;
globalThis.__HAS_KOKORO__ = false;
globalThis.__APP_VERSION__ = "0.0.0-test";
