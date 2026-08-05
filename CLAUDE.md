# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**F1 Coach** (npm name `box-box`; formerly "Box, Box") — a Windows desktop AI race engineer for EA SPORTS F1 25/26. It reads the game's live UDP telemetry, compares laps against reference traces, drives a force-feedback wheel, and coaches the driver over "team radio" (rule-engine calls in-corner, an LLM analyst between laps, voice in/out). Drivers can publish a lap to an online leaderboard and download other drivers' laps to use as their reference. Tauri 2 (Rust) shell + React 18 / Vite frontend.

## Commands

```bash
npm install                              # deps; predev/prebuild auto-copy ONNX wasm to public/ort
node scripts/fetch-kokoro-model.mjs      # one-time: Kokoro TTS weights (~97 MB, gitignored)
npm run tauri:dev                        # full native app (Rust core owns the UDP listener)
npm run dev                              # web UI only in a browser — no Rust core, no telemetry/FFB
npm run tauri:build                      # release build + NSIS installer

node scripts/sync-leaderboard-shared.mjs                            # ALWAYS run before the next line
npx supabase functions deploy <name> --project-ref <ref> --no-verify-jwt
```

- No game running? Set `F1_FAKE=1` (or the Settings toggle) — the Rust core replays a real recorded 25-lap race (`src-tauri/demo/session.json`).
- Rust-only iteration: `cargo check` in `src-tauri/`. First compile is slow: SDL2 is built from source and statically linked (needs CMake + MSVC, both installed).
- Build outputs: `src-tauri/target/release/boxbox.exe` (binary name is fixed by `[[bin]]` in `Cargo.toml`) and the installer `src-tauri/target/release/bundle/nsis/F1 Coach_<version>_x64-setup.exe` (named after `productName`).
- **No JS tests and no linter configured** (the Rust core has unit tests: `cargo test --lib` in `src-tauri/`). Verify frontend changes by running the app — demo mode covers most UI/telemetry paths.
- One-time dev scripts: `scripts/make-demo-session.mjs` (rebuilds `src-tauri/demo/session.json`, the demo-mode replay, from a session export out of the app's own lap log — see Demo mode below), `scripts/fetch-tracks.mjs` (regenerates committed `public/tracks/` geometry from the f1-circuits GeoJSON — all 25 circuits, current layouts), `scripts/fit-corners.mjs` (re-measures each circuit's corner apexes from that geometry into `apexes` — run it after fetch-tracks), `scripts/fetch-fonts.mjs` (re-vendors the committed `public/fonts/` woff2 + `fonts.css` from Google Fonts — run it only to change the family/weight set), `scripts/make-fixture-lap.mjs` (synthetic trace JSON to exercise track-fitting without driving — output is dev-only, do not commit), `scripts/calibrate-leaderboard.mjs` (measures how well a lap's own trace reconstructs its recorded time, so the leaderboard validator's thresholds are set from data — takes a "Save Session" export, defaults to the demo session).
- `scripts/sync-leaderboard-shared.mjs` is **not** one-time: it copies the pure leaderboard modules into `supabase/functions/_shared/` (gitignored, layout preserved so no import is rewritten) so an Edge Function validates with byte-identical copies of what the app runs. Run it before every function deploy or you ship stale validation logic.
- `node scripts/check-tcam-camera.mjs` asserts that the T-Cam's three.js camera is the *same* camera as its 2D projection, to sub-pixel agreement. Pure math — three needs no WebGL for `Matrix4`/`PerspectiveCamera`, so it runs in plain node. The closest thing to a JS test in this repo; run it after touching either.
- The T-Cam's car assets are **baked from a model, not hand-authored**. `scripts/render-tcam-ego.py` drives headless Blender over `public/Car Models/Formula 2 Car High Poly.blend` and writes all three: `public/tcam-ego.png` (your own car, as seen from the onboard camera), `public/tcam-ego-mask.png` (which of those pixels are bodywork) and `public/tcam-car.glb` (the ghost car). **Blender is not on PATH** — it's the Steam build at `F:\Programs\Steam\steamapps\common\Blender\blender.exe`. Re-run it after ANY change to `CAM_HEIGHT`/`CAM_SETBACK`/`CAM_PITCH`/`FOV_H`/`FOV_V_MAX` in `lib/tcamProjection.js`, or the overlay stops sitting on the road:

```bash
"F:\Programs\Steam\steamapps\common\Blender\blender.exe" -b -P scripts/render-tcam-ego.py -- public
```

  Append `<setback-metres> <pitch-degrees>` to trial one framing without touching the shipped files. Those previews render at a real pane's vertical FOV (~50°), **not** the 68° cap the shipped image uses — judging a camera position on the full-height frame overstates how much of the car ends up on screen, which is how the halo got picked and then cropped out.

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
- Laps recorded while demo mode is on are stamped `source: "demo"` by the recorder and kept off every board by `isDemoLap` (`lib/driverStats.js`) — a replay carries real lap times, so without that it would take personal bests. Demo and driven laps are two separate worlds: `computeDriverStats(laps, { demo })` picks a side (default = the driver's own), the Live screen's record buckets key on it, and the coach's `trackLaps` pool only ever holds one of them. Demo laps also can never be published online — which means **the upload path can't be exercised in demo mode**; test it against real laps already in IndexedDB.
- A recorded lap's `meta` carries `trackId`, `trackSlug` and `trackLengthM` alongside the display name. Laps recorded before those existed still resolve their circuit via `getTrackByName(meta.track)`, so the whole back history stays publishable — resolve lazily at read time, never bulk-migrate at boot.
- Persistence is IndexedDB `f1coach` **v4** (`lib/lapStore.js`): `laps`, `avatars`, `trackmaps`, `reftraces`. Every `onupgradeneeded` branch is guarded by a `contains()` check, so a version bump is a pure addition — **don't rewrite it into an `oldVersion` ladder**. Any new driver-keyed store must also be re-keyed in `renameDriver`, or a profile rename silently orphans it.

### T-Cam onboard view (`lib/tcamProjection.js`, `lib/tcamScene.js`, `lib/tcamCarLayer.js`)
Analytics ▸ Driving Lines ▸ T-Cam — a first-person camera riding a recorded lap.

- `tcamProjection.js` is a hand-written pinhole camera with **zero imports**: pure arithmetic on plain numbers, so it can be reasoned about and checked in node without a canvas anywhere near it. Its camera constants are shared by the live road AND by the Blender bake — they are not private tuning knobs.
- `tcamScene.js` paints the world into 2D canvas in a **fixed layer order rather than a depth sort**, because everything it draws sits on one surface and there is no occlusion to resolve.
- **three.js is back** — dropped in f6618fe with the old 3D track scene, re-added 2026-08-04 for exactly one job: the cars (`tcamCarLayer.js`). A car has volume and turns independently of the camera, which a flat decal can't express. It renders to an **offscreen** canvas that `TrackCamView` blits into the 2D context mid-scene, after the ribbons and before the fog. Stacking a transparent canvas over the top instead puts a 200 m-distant car through the haze and out through your own halo. It is dynamically imported, so ~560 kB of three + GLTFLoader never lands in the entry chunk every launch parses.
- Both cars — the ghost *and* your own — are the same `tcam-car.glb` drawn in **one GL pass**, so the depth buffer sorts them against each other. The lap colour (white = reference, accent = comparison) is applied to the model's `Body` material alone; that separation is what keeps tyres and suspension black, and it's why a liveried model was rejected. Wheels roll off **ground distance** (`dist / 0.335`), never an integrated speed, so scrubbing or pausing stays correct.
- Everything fails soft. No WebGL, a lost context, or a model that won't load falls back to `tcamScene`'s flat ground decal for the ghost and the baked `tcam-ego.png` + mask for your own car.

### Coaching — two layers, never let the LLM into the real-time path
- A deterministic rule engine makes in-corner calls (brake, lift-and-coast, ERS) and always runs.
- The LLM (`lib/coach/`) is a **between-lap analyst only** — one debrief call when a lap completes, via **OpenRouter** (cloud-only; a former Ollama path was removed). The chat panel and the on-track one-shot tip that used to sit alongside it are gone. `prompts.js` builds the prompt, `schema.js` validates/repairs the structured reply, `guardrails.js` enforces grounding — the model may only cite numbers present in the lap evidence.
- Neither layer runs when the loaded reference isn't comparable with the lap driven (`lib/coach/refMatch.js`): different circuit, dry vs wet, race vs push lap, or a different compound withholds the insights AND mutes the corner calls, since both are derived from that reference.
- A priority speech arbiter (`urgent > normal > low`) in BoxBoxApp keeps engine calls and AI tips from talking over each other; stale tips are dropped.
- Voice out is local ONNX Kokoro TTS (`lib/kokoroTTS.js`, in a worker — see `lib/kokoroWorker.js`). There is no voice input; the Whisper STT stack was removed with the chat.

### Online leaderboards (`lib/leaderboard/`, `supabase/`)
Publishing a lap to a public board and downloading someone else's as a reference. Backed by **Supabase free tier** (Postgres + storage + anonymous auth + Edge Functions) — chosen over Firebase because Firebase requires a paid plan with no hard spending cap just to run functions.

- **A board is `<trackSlug>__<sessionGroup>`** — 50 of them, **Qualifying and Time Trial only**. Race is refused (fuel and tyre management a push lap doesn't carry); Practice is refused because it can be either and the game gives no way to tell, the same reason `refMatch` won't classify it. `lib/sessionGroups.js` holds the shared `SESSION_GROUP` map (Sprint Shootout → Qualifying) — **do not use it directly as the board map**, it also maps the two types boards refuse; `boardKey.js` layers an explicit allow-set on top.
- **Compound is shown, not partitioned on.** But `refMatch` still blocks on it, so a board can hold a Soft and an Inter reference side by side — every row runs `matchReference` to warn before you pick one the coach would then mute.
- **The primary key `(board_id, driver_id)` IS the one-lap-per-driver rule.** An upload is an upsert that only lands when it's faster. There is no rank column — rank is counted, because a stored one is stale the moment anyone else publishes.
- **Clients never write.** No insert/update policy exists anywhere; the only writer is the `submit-lap` Edge Function holding the service role key. That split is structural: a policy can't inflate a gzipped trace and check the speeds in it against the lap time being claimed.
- **Anti-tamper (`validate.js`) and its limit.** Five checks — sector sum (tightest, exact to 20 ms), lap time re-derived from the trace, distance coverage/gaps, ERS monotonicity + ceiling, speed sanity. Catches edited lap times, truncated traces and flashback signatures. **It cannot catch a genuinely-driven lap with assists on** — the game sends those flags, the Rust parser doesn't read them yet. Highest-value follow-up.
- **Thresholds in `limits.js` were measured, not guessed** (`scripts/calibrate-leaderboard.mjs`). Read the comments before touching them: integrating a distance-binned trace runs systematically ~2% HIGH, so the tolerance window is offset rather than centred — a symmetric one rejects nearly every honest lap. Likewise the ERS ceiling is 13 MJ, not 4: 4 MJ is the battery's capacity, not a per-lap deployment limit.
- **Everything fails soft**, following `lib/updateCheck.js` — no call throws, reads resolve to null. Turning the feature off in Settings makes *zero* requests. The screen distinguishes four states (ready / disabled / offline / error) because collapsing them is how a board looks broken at a race weekend.
- Downloaded references persist in IndexedDB (`reftraces` store) so they survive a restart and work offline; they flow into `refTraces` through the same path `loadTrace` uses.

### Telemetry facts that shape the code
- The UDP stream has only **3 real sectors**; the app derives **18 mini-sectors** locally from real sector boundaries (`MINI_SECTORS`/`MINI_PER_SECTOR` in `lib/format.js`). Don't look for mini-sector data in packets — it doesn't exist.
- Track geometry (`public/tracks/`) is committed data; runtime alignment into the game's world frame happens in `lib/trackGeometry.js`.
- **Corner positions are not lap fractions in the data.** Each track file's `apexes` are fractions of that centerline's own arc length from point 0 — and point 0 is wherever the upstream GeoJSON way started (the start/finish line at Monza, ~845 m past it at Monaco), with file order not always the racing direction (Singapore's is traced backwards). `trackGeometry` recovers both when it fits a lap (`reverse`, `sfFrac`), `lib/cornerAnchors.js` caches them per circuit and does the numbering, and `hooks/useTrackCorners.js` hands the rest of the app `{ n, name, f }` with `f` as a real lap fraction. Don't hand-write lap fractions — run `scripts/fit-corners.mjs`.

### Theming
Team "livery" skins recolour the whole app via CSS variables set on `<html>` (`lib/ui/skins.js`). UI colour tokens (`C` in `lib/ui/tokens.js`) are var()-backed and skinnable; **data-meaning colours (tyre compounds, flags, ERS modes) stay fixed** — don't route those through skin vars.

## Gotchas

- **CSP is strict** (`tauri.conf.json`): any new external endpoint must be added to `connect-src` in **both `csp` and `devCsp`** or it silently fails in the packaged exe while working in `npm run dev`. This is why ONNX runtime wasm is self-hosted in `public/ort/` (copied by `scripts/copy-ort.mjs` on predev/prebuild) instead of ORT's default jsdelivr CDN. Note `tauri dev` enforces `devCsp` (dev is NOT CSP-free): it deliberately allows `cdn.jsdelivr.net` because the self-hosted `/ort/` path is PROD-only (Vite's dev server can't serve `public/` files as module imports), so dev voice falls back to the CDN. The Supabase origin needs only ONE entry — REST, auth, storage and functions are all paths on the same host. **The packaged NSIS build is the only place a CSP mistake actually shows up**; check there before shipping.
- **The app must work with no network** — telemetry is UDP and the TTS weights are bundled, so a race weekend never needs the internet. Everything the UI needs at startup is therefore vendored: UI fonts in `public/fonts/` (see `scripts/fetch-fonts.mjs`), ORT wasm in `public/ort/`, Kokoro weights in `public/kokoro/`. Don't add a render-blocking remote `<link>`/`<script>` to `index.html` — an offline launch stalls on it until it times out. Four network calls remain, all optional and all failing soft: OpenRouter (coaching), the GitHub release check, the Kokoro CDN fallback in dev, and the leaderboards. The leaderboard's Dashboard card is the one that renders on the default tab at every launch — it fires post-paint, times out, and renders nothing on any failure. Keep it that way.
- **`public/Car Models/` is ~49 MB of source models** (.blend/.c4d/.fbx/.obj plus 4K textures) and is deliberately **NOT committed**. Anything under `public/` is copied verbatim by Vite into `dist/` and therefore into the NSIS installer, so leaving it where it is bloats every build by 49 MB for no runtime benefit — only the three derived files (`tcam-ego.png`, `tcam-ego-mask.png`, `tcam-car.glb`) are needed at runtime. Move it out of `public/` before cutting a release. Note this also means `scripts/render-tcam-ego.py` cannot run on a fresh clone until the model is put back.
- **The T-Cam car model's licence is unknown.** `Formula 2 Car High Poly.blend` arrived with no readme and is now baked into three shipping assets. Establish its terms before a public release. (The two F1 models beside it were rejected: one carries a full Ferrari livery with live trademarks and mirrored UVs, the other floats off the ground and ships a studio backdrop.)
- **The leaderboard's public Supabase anon key is committed** in `lib/leaderboard/config.js` and that is correct — it is scoped entirely by row-level security (public read, zero write) and an env var that goes missing would just fail at runtime with a confusing error. The **service role key is a real secret** and appears nowhere in this repo; Edge Functions read it from their own environment.
- `vite.config.js` excludes `kokoro-js` and `@huggingface/transformers` from `optimizeDeps` — pre-bundling breaks their wasm/worker asset URLs. Don't remove that.
- Keep the version in `package.json` and `tauri.conf.json` in sync — Vite inlines it as `__APP_VERSION__` for the GitHub-release update check (`lib/updateCheck.js`).
