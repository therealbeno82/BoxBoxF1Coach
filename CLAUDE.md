# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**F1 Coach** (npm name `box-box`; formerly "Box, Box") — a Windows desktop AI race engineer for EA SPORTS F1 25/26. It reads the game's live UDP telemetry, compares laps against reference traces, drives a force-feedback wheel, and coaches the driver over "team radio" (rule-engine calls in-corner, an LLM analyst between laps, voice in/out). Tauri 2 (Rust) shell + React 18 / Vite frontend.

## Commands

```bash
npm install                              # deps; predev/prebuild auto-copy ONNX wasm to public/ort
node scripts/fetch-kokoro-model.mjs      # one-time: Kokoro TTS weights (~97 MB, gitignored)
npm run tauri:dev                        # full native app (Rust core owns the UDP listener)
npm run dev                              # web UI only in a browser — no Rust core, no telemetry/FFB
npm run tauri:build                      # release build + NSIS installer
```

- No game running? Set `F1_FAKE=1` (or the Settings toggle) — the Rust core replays a real recorded 25-lap race (`src-tauri/demo/session.json`).
- Rust-only iteration: `cargo check` in `src-tauri/`. First compile is slow: SDL2 is built from source and statically linked (needs CMake + MSVC, both installed).
- Build outputs: `src-tauri/target/release/boxbox.exe` (binary name is fixed by `[[bin]]` in `Cargo.toml`) and the installer `src-tauri/target/release/bundle/nsis/F1 Coach_<version>_x64-setup.exe` (named after `productName`).
- **No JS tests and no linter configured** (the Rust core has unit tests: `cargo test --lib` in `src-tauri/`). Verify frontend changes by running the app — demo mode covers most UI/telemetry paths.
- One-time dev scripts: `scripts/make-demo-session.mjs` (rebuilds `src-tauri/demo/session.json`, the demo-mode replay, from a session export out of the app's own lap log — see Demo mode below), `scripts/fetch-tracks.mjs` (regenerates committed `public/tracks/` geometry from the f1-circuits GeoJSON — all 25 circuits, current layouts), `scripts/fit-corners.mjs` (re-measures each circuit's corner apexes from that geometry into `apexes` — run it after fetch-tracks), `scripts/fetch-fonts.mjs` (re-vendors the committed `public/fonts/` woff2 + `fonts.css` from Google Fonts — run it only to change the family/weight set), `scripts/make-fixture-lap.mjs` (synthetic trace JSON to exercise track-fitting without driving — output is dev-only, do not commit).

## Architecture

### Rust core (`src-tauri/src/`) — real-time work lives here, not in JS
Everything real-time is in-process Rust (an earlier Node sidecar bridge was deleted; ignore any references to it):

- `telemetry/` — single UDP listener on port 20777 parsing the game's **2026-format packets only**. Publishes a lock-free snapshot (`arc-swap`) shared by two consumers.
- `ffb/` — force-feedback engine thread; reads the shared snapshot at full rate and outputs to the wheel via SDL2 haptics.
- `telemetry/demo.rs` — demo mode. Instead of synthesising telemetry it **replays a real recorded session** (`demo/session.json`, ~2 MB, `include_str!`-compiled so a fresh install needs no side files): 25 laps at Singapore, dry mediums into a wet intermediate stint. The file is distance-binned every 10 m with a precomputed time axis, so a tick is a lerp between two bins and each lap comes out at the time it was really set. Only the channels a lap recording can't carry are modelled — forces/slips (from the measured lateral/longitudinal g), ERS state of charge, rpm, tyre wear.
- `lib.rs` — Tauri commands (`set_udp_port`, `set_fake_mode`, `get_local_ips`, `get_ffb_*`/`set_ffb_*`) plus an emitter thread that samples shared state at ~30 Hz and emits Tauri events **only when the `Arc` pointer changed**: `telemetry`, `core_status`, `ffb_gauges`, `ffb_status`. UI event cadence never affects FFB latency.

### Frontend (`src/`)
- `BoxBoxApp.jsx` (~2,700 lines) is the root and deliberate orchestration hub: all telemetry/lap/coaching state, the lap recorder, and the speech-output pipeline live here; screens under `components/screens/` are mostly presentational and receive props from it.
- Hooks wrap the Tauri boundary: `useTelemetry`/`useTauriEvents` (events in), `useFfbEngine` (FFB commands/gauges), `useLlmHealth`, `useUpdateCheck`.
- `lib/env.js` exports `inTauri`; every `invoke()` is guarded with it so plain `npm run dev` in a browser doesn't throw. Keep that pattern for any new Tauri call.
- Laps recorded while demo mode is on are stamped `source: "demo"` by the recorder and kept off every board by `isDemoLap` (`lib/driverStats.js`) — a replay carries real lap times, so without that it would take personal bests. Demo and driven laps are two separate worlds: `computeDriverStats(laps, { demo })` picks a side (default = the driver's own), the Live screen's record buckets key on it, and the coach's `trackLaps` pool only ever holds one of them.

### Coaching — two layers, never let the LLM into the real-time path
- A deterministic rule engine makes in-corner calls (brake, lift-and-coast, ERS) and always runs.
- The LLM (`lib/coach/`) is a **between-lap analyst only** — one debrief call when a lap completes, via **OpenRouter** (cloud-only; a former Ollama path was removed). The chat panel and the on-track one-shot tip that used to sit alongside it are gone. `prompts.js` builds the prompt, `schema.js` validates/repairs the structured reply, `guardrails.js` enforces grounding — the model may only cite numbers present in the lap evidence.
- Neither layer runs when the loaded reference isn't comparable with the lap driven (`lib/coach/refMatch.js`): different circuit, dry vs wet, race vs push lap, or a different compound withholds the insights AND mutes the corner calls, since both are derived from that reference.
- A priority speech arbiter (`urgent > normal > low`) in BoxBoxApp keeps engine calls and AI tips from talking over each other; stale tips are dropped.
- Voice out is local ONNX Kokoro TTS (`lib/kokoroTTS.js`, in a worker — see `lib/kokoroWorker.js`). There is no voice input; the Whisper STT stack was removed with the chat.

### Telemetry facts that shape the code
- The UDP stream has only **3 real sectors**; the app derives **18 mini-sectors** locally from real sector boundaries (`MINI_SECTORS`/`MINI_PER_SECTOR` in `lib/format.js`). Don't look for mini-sector data in packets — it doesn't exist.
- Track geometry (`public/tracks/`) is committed data; runtime alignment into the game's world frame happens in `lib/trackGeometry.js`.
- **Corner positions are not lap fractions in the data.** Each track file's `apexes` are fractions of that centerline's own arc length from point 0 — and point 0 is wherever the upstream GeoJSON way started (the start/finish line at Monza, ~845 m past it at Monaco), with file order not always the racing direction (Singapore's is traced backwards). `trackGeometry` recovers both when it fits a lap (`reverse`, `sfFrac`), `lib/cornerAnchors.js` caches them per circuit and does the numbering, and `hooks/useTrackCorners.js` hands the rest of the app `{ n, name, f }` with `f` as a real lap fraction. Don't hand-write lap fractions — run `scripts/fit-corners.mjs`.

### Theming
Team "livery" skins recolour the whole app via CSS variables set on `<html>` (`lib/ui/skins.js`). UI colour tokens (`C` in `lib/ui/tokens.js`) are var()-backed and skinnable; **data-meaning colours (tyre compounds, flags, ERS modes) stay fixed** — don't route those through skin vars.

## Gotchas

- **CSP is strict** (`tauri.conf.json`): any new external endpoint must be added to `connect-src` or it silently fails in the packaged exe while working in `npm run dev`. This is why ONNX runtime wasm is self-hosted in `public/ort/` (copied by `scripts/copy-ort.mjs` on predev/prebuild) instead of ORT's default jsdelivr CDN. Note `tauri dev` enforces `devCsp` (dev is NOT CSP-free): it deliberately allows `cdn.jsdelivr.net` because the self-hosted `/ort/` path is PROD-only (Vite's dev server can't serve `public/` files as module imports), so dev voice falls back to the CDN.
- **The app must work with no network** — telemetry is UDP and the TTS weights are bundled, so a race weekend never needs the internet. Everything the UI needs at startup is therefore vendored: UI fonts in `public/fonts/` (see `scripts/fetch-fonts.mjs`), ORT wasm in `public/ort/`, Kokoro weights in `public/kokoro/`. Don't add a render-blocking remote `<link>`/`<script>` to `index.html` — an offline launch stalls on it until it times out. Only three network calls remain, all optional and all failing soft: OpenRouter (coaching), the GitHub release check, and the Kokoro CDN fallback in dev.
- `vite.config.js` excludes `kokoro-js` and `@huggingface/transformers` from `optimizeDeps` — pre-bundling breaks their wasm/worker asset URLs. Don't remove that.
- Keep the version in `package.json` and `tauri.conf.json` in sync — Vite inlines it as `__APP_VERSION__` for the GitHub-release update check (`lib/updateCheck.js`).
