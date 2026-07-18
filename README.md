# F1 Coach

**An AI race engineer for EA SPORTS F1™ 25/26.** F1 Coach reads the game's live UDP
telemetry, compares your driving against Esports-grade reference traces, and coaches you
over "team radio" — with real-time braking/ERS calls in the corner and an LLM race
engineer you can talk to between laps, by voice or text.

> Windows desktop app built with **Tauri 2** (Rust shell) + **React 18 / Vite** frontend.
> Telemetry parsing and force feedback run in-process in the Rust core. Small installer,
> low RAM — designed to run alongside the game.

---

## What it does

- **Live telemetry dashboard** — speed, throttle/brake, gear, ERS mode, tyre & brake temps,
  DRS, fuel, and per-sector / mini-sector timing, all streamed live from the game at up to
  30 Hz.
- **Reference-trace comparison** — load an Esports / hot-lap reference trace and see where
  you're losing time, corner by corner, sector by sector.
- **Two-layer coaching** (see [Architecture](#architecture)):
  - A **real-time rule engine** makes in-corner calls (brake point, lift-and-coast, ERS
    deployment) the instant they're needed.
  - An **LLM race engineer** acts as a between-lap analyst — one focused improvement tip per
    completed lap, plus free-form **voice/text chat** ("how do I carry more speed through
    the hairpin?").
- **Voice in and out** — local **Whisper** speech-to-text and **Kokoro** text-to-speech
  (ONNX, self-hosted), so you can keep your hands on the wheel.
- **Speech arbiter** so the engine and the AI never talk over each other — urgent real-time
  calls preempt; stale AI tips are dropped.
- **Mini-sector derivation** — the F1 UDP stream only broadcasts 3 real sectors, so the app
  derives 18 mini-sectors locally from the real sector boundaries and colours them with the
  game's own faster/slower rule.

---

## Architecture

```
 ┌────────────────────┐   UDP :20777    ┌─────────────────────┐  Tauri events  ┌──────────────────────┐
 │  F1 25/26 (game)   │ ──────────────▶ │  Rust telemetry core│ ─────────────▶ │  React UI (WebView)  │
 │  UDP telemetry      │   format 2026   │  (in-process)       │  ~30 Hz, only  │  in the Tauri shell  │
 └────────────────────┘                 └──────────┬──────────┘   on change    └──────────┬───────────┘
                                                   │ lock-free snapshot                    │
                                                   ▼ (full rate)               ┌───────────┴───────────────────┐
                                        ┌─────────────────────┐               │  Coaching                       │
                                        │  FFB engine (Rust)  │               │  • Rule engine (real-time calls)│
                                        │  → wheel via SDL2   │               │  • LLM (between-lap analyst+chat)│
                                        └─────────────────────┘               │  • Whisper STT / Kokoro TTS      │
                                                                              └─────────────────────────────────┘
```

**Why an in-process core?** The webview can't read raw UDP, so the Rust shell owns a single
UDP listener that parses the game's packets and publishes a lock-free snapshot. Two consumers
read it: the force-feedback engine at full rate (UI cadence never adds FFB latency), and an
emitter thread that forwards changes to the UI as Tauri events at ~30 Hz. No sidecar process,
no WebSocket — it starts and stops with the app.

**Why two coaching layers?** An LLM is too slow to make on-the-mark corner calls, so all
real-time calls live in a deterministic rule engine that always runs (and is the fallback
when no AI is connected). The LLM only speaks in quiet windows — at the start/finish line
with a lap debrief, or when you ask it something. A priority-based speech arbiter
(`urgent > normal > low`) keeps the two from overlapping.

**Coaching control** — a header toggle cycles `AUTO ▸ AI ▸ ENGINE`. `AUTO` enables the AI
only when the LLM backend is actually reachable (a live health probe); the real-time engine
layer runs regardless.

### LLM provider
The coach speaks through **OpenRouter** (cloud, low-latency models suit short radio
calls — default `anthropic/claude-3.5-haiku`, switchable to any OpenRouter model from
the Setup tab). The prompt layer includes genuine guardrails — grounding (no invented
numbers), location language (corners, not metres), scope/anti-jailbreak, and untrusted-data
wrapping.

---

## Tech stack

| Layer          | Tech                                                                 |
|----------------|----------------------------------------------------------------------|
| Native shell   | Tauri 2 (Rust), `tauri-plugin-opener`, `tauri-plugin-log`            |
| Frontend       | React 18, Vite 6, Three.js (3D track view)                          |
| Telemetry      | In-process Rust UDP parser (2026 packet format), lock-free `arc-swap` snapshot |
| Force feedback | Rust FFB engine → wheel via SDL2 haptics (statically linked)        |
| Speech         | `@huggingface/transformers` (Whisper STT), `kokoro-js` (TTS), ONNX  |
| LLM            | OpenRouter                                                          |
| Packaging      | Tauri NSIS installer                                                |

---

## Project layout

```
src/                     React app
  BoxBoxApp.jsx          Root: dashboard, WS telemetry client, lap recorder, coaching orchestration
  components/            Screens (Live, Dashboard, Analytics, Settings…), modals, chat, telemetry studio
  lib/coach/             LLM persona, prompts, guardrails, lap analysis, provider client
  lib/                   Track data, tyres, formatting, Whisper/Kokoro wrappers, 3D scene
  hooks/                 useCoachChat, useLlmHealth, useSpeechRecognition
scripts/copy-ort.mjs     Copies ONNX runtime wasm into /public/ort (CSP: served same-origin, not via CDN)
src-tauri/src/telemetry/ Rust core: UDP listener + 2026-format packet parsing, shared snapshot
src-tauri/src/ffb/       Rust FFB engine: reads the snapshot, drives the wheel via SDL2
src-tauri/src/lib.rs     Tauri commands + the ~30 Hz change-only event emitter; window + CSP config
public/ort/              Self-hosted ONNX runtime wasm
```

---

## Prerequisites

- **Windows 10/11** (the game broadcasts UDP; the native core listens in-process).
- **Node.js 22+** and npm.
- For building the native app: **Rust** (stable, MSVC toolchain) + **Visual Studio Build
  Tools** (Desktop C++), plus **WebView2** runtime (preinstalled on current Windows).
- In **F1 25/26**: enable UDP telemetry — *Settings → Telemetry Settings → UDP Telemetry:
  On*, **UDP Format: 2026**, IP `127.0.0.1`, port `20777`.

---

## Getting started (development)

```bash
# 1. Install dependencies (also copies the ONNX runtime into /public/ort)
npm install

# 2. Fetch the local Kokoro TTS weights (~97 MB, one-time — not in git)
node scripts/fetch-kokoro-model.mjs

# 3. Run the full native app (the Rust core owns the UDP listener)
npm run tauri:dev
```

> No game running? Launch with the `F1_FAKE=1` environment variable (or flip the fake-mode
> toggle in Settings) and the core feeds synthetic telemetry so you can develop the UI
> without the game. `npm run dev` alone previews the web UI with no native core.

### Configure the coach
Open the **Setup** tab, paste an **OpenRouter API key**, and pick a model. The key is
stored locally on your machine.

---

## Building the installer

```bash
# Build the Tauri app + NSIS installer (frontend build runs automatically first)
npm run tauri:build
```

Outputs:
- Raw binary: `src-tauri/target/release/boxbox.exe`
- Installer:  `src-tauri/target/release/bundle/nsis/…`

---

## Configuration reference

| Setting            | Default                       | Where                                        |
|--------------------|-------------------------------|----------------------------------------------|
| UDP port           | `20777`                       | Rust core (`set_udp_port` Tauri command / Settings tab) |
| UI event rate      | ~30 Hz, change-only           | emitter thread in `src-tauri/src/lib.rs`     |
| UDP format         | `2026`                        | in-game telemetry settings                   |
| OpenRouter model   | `anthropic/claude-3.5-haiku`  | `src/lib/coach/config.js` / Setup tab        |

---

## Security notes

A full review lives in [CODE_REVIEW.md](CODE_REVIEW.md). Highlights:

- The Tauri attack surface is minimal — capabilities grant only `core:default` and
  `opener:default`, and the CSP is tightly scoped (`object-src 'none'`, `frame-src 'none'`,
  `base-uri 'self'`).
- The LLM layer has real prompt-injection defenses (grounding, scope rule, `<< >>` data
  wrapping, output sanitization).
- **Your OpenRouter API key is stored in plaintext** in the app's local data
  (`localStorage`). It never leaves your machine except in requests to OpenRouter, but a
  local process or anyone with disk access could read it. Treat it accordingly.
- The UDP listener binds all interfaces so console players can point a second device at the
  PC's LAN IP — it only ever *receives* game telemetry; nothing is served on the network.

---

## Status

v1.0.0 — first tagged release. The app is functional: live telemetry, reference-trace
comparison, the two-layer coach, and voice in/out all work. See
[CODE_REVIEW.md](CODE_REVIEW.md) for known hardening items and the issue tracker for
roadmap.

---

## Acknowledgements

- F1 UDP parsing via [`@deltazeroproduction/f1-udp-parser`](https://www.npmjs.com/package/@deltazeroproduction/f1-udp-parser)
- On-device speech via [Hugging Face Transformers.js](https://huggingface.co/docs/transformers.js) (Whisper) and [Kokoro](https://github.com/hexgrad/kokoro) (TTS)
- Cloud LLM routing via [OpenRouter](https://openrouter.ai)

*Not affiliated with or endorsed by EA, Codemasters, or Formula 1. "F1" and related marks
belong to their respective owners. For personal, non-commercial use.*
