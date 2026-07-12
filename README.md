# Box, Box

**An AI race engineer for EA SPORTS F1™ 25/26.** Box, Box reads the game's live UDP
telemetry, compares your driving against Esports-grade reference traces, and coaches you
over "team radio" — with real-time braking/ERS calls in the corner and an LLM race
engineer you can talk to between laps, by voice or text.

> Windows desktop app built with **Tauri 2** (Rust shell) + **React 18 / Vite** frontend,
> with a bundled **Node** telemetry bridge sidecar. Small installer, low RAM — designed to
> run alongside the game.

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
 ┌────────────────────┐   UDP :20777    ┌─────────────────────┐   WS :9001    ┌──────────────────────┐
 │  F1 25/26 (game)   │ ──────────────▶ │  Node bridge        │ ────────────▶ │  React UI (WebView)  │
 │  UDP telemetry      │   format 2025   │  (Tauri sidecar)    │   JSON frames │  in the Tauri shell  │
 └────────────────────┘                 └─────────────────────┘               └──────────┬───────────┘
                                                                                          │
                                                                          ┌───────────────┴───────────────┐
                                                                          │  Coaching                       │
                                                                          │  • Rule engine (real-time calls)│
                                                                          │  • LLM (between-lap analyst+chat)│
                                                                          │  • Whisper STT / Kokoro TTS      │
                                                                          └─────────────────────────────────┘
```

**Why a bridge?** Browsers can't read raw UDP, so a small native Node process (bundled as a
Tauri sidecar) listens on the game's UDP port and re-broadcasts each frame over a localhost
WebSocket the UI subscribes to. The Tauri shell spawns and tears down this sidecar
automatically — no manual step.

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

| Layer        | Tech                                                                 |
|--------------|----------------------------------------------------------------------|
| Native shell | Tauri 2 (Rust), `tauri-plugin-shell`, `tauri-plugin-log`             |
| Frontend     | React 18, Vite 6, Three.js (3D track view)                          |
| Telemetry    | Node bridge (`ws`, `@deltazeroproduction/f1-udp-parser`)            |
| Speech       | `@huggingface/transformers` (Whisper STT), `kokoro-js` (TTS), ONNX  |
| LLM          | OpenRouter                                                          |
| Packaging    | `@yao-pkg/pkg` (bridge sidecar), Tauri NSIS installer               |

---

## Project layout

```
src/                     React app
  BoxBoxApp.jsx          Root: dashboard, WS telemetry client, lap recorder, coaching orchestration
  components/            Screens (Live, Dashboard, Analytics, Settings…), modals, chat, telemetry studio
  lib/coach/             LLM persona, prompts, guardrails, lap analysis, provider client
  lib/                   Track data, tyres, formatting, Whisper/Kokoro wrappers, 3D scene
  hooks/                 useCoachChat, useLlmHealth, useSpeechRecognition
bridge/f1-bridge.cjs     UDP → WebSocket bridge (Tauri sidecar)
scripts/copy-ort.mjs     Copies ONNX runtime wasm into /public/ort (CSP: served same-origin, not via CDN)
src-tauri/               Rust shell: spawns/stops the bridge sidecar, window + CSP config
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
# 1. Build the bridge sidecar (≈55 MB packaged Node binary)
npm run build:bridge

# 2. Build the Tauri app + NSIS installer
npm run tauri:build
```

Outputs:
- Raw binary: `src-tauri/target/release/boxbox.exe`
- Installer:  `src-tauri/target/release/bundle/nsis/…`

---

## Configuration reference

| Setting            | Default                       | Where                                   |
|--------------------|-------------------------------|-----------------------------------------|
| UDP port           | `20777`                       | bridge (`setUdpPort` over WS)           |
| Bridge WebSocket   | `ws://localhost:9001`         | `bridge/f1-bridge.cjs`                  |
| Broadcast rate     | 30 Hz                         | `BROADCAST_HZ` in the bridge            |
| UDP format         | `2025`                        | in-game telemetry settings              |
| OpenRouter model   | `anthropic/claude-3.5-haiku`  | `src/lib/coach/config.js` / Setup tab   |

---

## Security notes

A full review lives in [CODE_REVIEW.md](CODE_REVIEW.md). Highlights:

- The Tauri attack surface is minimal — capabilities grant only `core:default`, the shell
  plugin is internal (not exposed to the frontend), and the CSP is tightly scoped
  (`object-src 'none'`, `frame-src 'none'`, `base-uri 'self'`).
- The LLM layer has real prompt-injection defenses (grounding, scope rule, `<< >>` data
  wrapping, output sanitization).
- **Your OpenRouter API key is stored in plaintext** in the app's local data
  (`localStorage`). It never leaves your machine except in requests to OpenRouter, but a
  local process or anyone with disk access could read it. Treat it accordingly.
- The bridge WebSocket currently binds all interfaces — fine on a trusted LAN, but consider
  binding to loopback if that's a concern.

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
