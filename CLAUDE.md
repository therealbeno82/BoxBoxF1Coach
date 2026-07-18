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

- No game running? Set `F1_FAKE=1` (or the Settings toggle) — the Rust core feeds a synthetic lap.
- Rust-only iteration: `cargo check` in `src-tauri/`. First compile is slow: SDL2 is built from source and statically linked (needs CMake + MSVC, both installed).
- Build outputs: `src-tauri/target/release/boxbox.exe` (binary name is fixed by `[[bin]]` in `Cargo.toml`) and the installer `src-tauri/target/release/bundle/nsis/F1 Coach_<version>_x64-setup.exe` (named after `productName`).
- **There are no tests and no linter configured.** Verify changes by running the app (fake mode covers most UI/telemetry paths).
- One-time dev scripts: `scripts/fetch-tracks.mjs` (regenerates committed `public/tracks/` geometry from the TUMFTM dataset), `scripts/make-fixture-lap.mjs` (synthetic trace JSON to exercise track-fitting without driving — output is dev-only, do not commit).

## Architecture

### Rust core (`src-tauri/src/`) — real-time work lives here, not in JS
Everything real-time is in-process Rust (an earlier Node sidecar bridge was deleted; ignore any references to it):

- `telemetry/` — single UDP listener on port 20777 parsing the game's **2026-format packets only**. Publishes a lock-free snapshot (`arc-swap`) shared by two consumers.
- `ffb/` — force-feedback engine thread; reads the shared snapshot at full rate and outputs to the wheel via SDL2 haptics.
- `lib.rs` — Tauri commands (`set_udp_port`, `set_fake_mode`, `get_local_ips`, `get_ffb_*`/`set_ffb_*`) plus an emitter thread that samples shared state at ~30 Hz and emits Tauri events **only when the `Arc` pointer changed**: `telemetry`, `core_status`, `ffb_gauges`, `ffb_status`. UI event cadence never affects FFB latency.

### Frontend (`src/`)
- `BoxBoxApp.jsx` (~2,700 lines) is the root and deliberate orchestration hub: all telemetry/lap/coaching state, the lap recorder, and the speech pipeline live here; screens under `components/screens/` are mostly presentational and receive props from it.
- Hooks wrap the Tauri boundary: `useTelemetry`/`useTauriEvents` (events in), `useFfbEngine` (FFB commands/gauges), `useLlmHealth`, `useCoachChat`, `useSpeechRecognition`.
- `lib/env.js` exports `inTauri`; every `invoke()` is guarded with it so plain `npm run dev` in a browser doesn't throw. Keep that pattern for any new Tauri call.

### Coaching — two layers, never let the LLM into the real-time path
- A deterministic rule engine makes in-corner calls (brake, lift-and-coast, ERS) and always runs.
- The LLM (`lib/coach/`) is a between-lap analyst + chat only, via **OpenRouter** (cloud-only; a former Ollama path was removed). `prompts.js` builds prompts, `schema.js` validates/repairs structured replies, `guardrails.js` enforces grounding — the model may only cite numbers from an allowed set extracted from real telemetry.
- A priority speech arbiter (`urgent > normal > low`) in BoxBoxApp keeps engine calls and AI tips from talking over each other; stale tips are dropped.
- Voice is local ONNX: Whisper STT (`lib/whisperSTT.js`) and Kokoro TTS (`lib/kokoroTTS.js`).

### Telemetry facts that shape the code
- The UDP stream has only **3 real sectors**; the app derives **18 mini-sectors** locally from real sector boundaries (`MINI_SECTORS`/`MINI_PER_SECTOR` in `lib/format.js`). Don't look for mini-sector data in packets — it doesn't exist.
- Track geometry (`public/tracks/`) is committed data; runtime alignment into the game's world frame happens in `lib/trackGeometry.js`.

### Theming
Team "livery" skins recolour the whole app via CSS variables set on `<html>` (`lib/ui/skins.js`). UI colour tokens (`C` in `lib/ui/tokens.js`) are var()-backed and skinnable; **data-meaning colours (tyre compounds, flags, ERS modes) stay fixed** — don't route those through skin vars.

## Gotchas

- **CSP is strict** (`tauri.conf.json`): any new external endpoint must be added to `connect-src` or it silently fails in the packaged exe while working in `npm run dev`. This is why ONNX runtime wasm is self-hosted in `public/ort/` (copied by `scripts/copy-ort.mjs` on predev/prebuild) instead of ORT's default jsdelivr CDN. Note `tauri dev` enforces `devCsp` (dev is NOT CSP-free): it deliberately allows `cdn.jsdelivr.net` because the self-hosted `/ort/` path is PROD-only (Vite's dev server can't serve `public/` files as module imports), so dev voice falls back to the CDN.
- `vite.config.js` excludes `kokoro-js` and `@huggingface/transformers` from `optimizeDeps` — pre-bundling breaks their wasm/worker asset URLs. Don't remove that.
- Keep the version in `package.json` and `tauri.conf.json` in sync — Vite inlines it as `__APP_VERSION__` for the GitHub-release update check (`lib/updateCheck.js`).
