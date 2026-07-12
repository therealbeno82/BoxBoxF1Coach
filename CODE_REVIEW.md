# Box, Box — Code Review

Scope: Tauri shell + in-process Rust core (`src-tauri/src/telemetry`, `src-tauri/src/ffb`),
React frontend (`src/`), build scripts. Dependencies and build artifacts excluded.

> Architecture note: the old Node telemetry bridge (`bridge/f1-bridge.cjs`) has been
> removed. A single UDP listener now lives in-process in Rust and pushes snapshots to the
> webview via Tauri events (`telemetry`, `core_status`, `ffb_gauges`, `ffb_status`). The
> LLM path is OpenRouter-only.

**Overall:** Well-structured and unusually well-commented. The Tauri attack surface is
minimal, Rust UDP parsing is fully bounds-checked, the FFB engine has genuine safety-release
gating, and the LLM layer has real prompt-injection guardrails. Findings are hardening and
polish — nothing critical. Items marked ✅ were fixed in the review pass.

---

## Security

### S1. OpenRouter API key stored in plaintext — *Moderate*
`src/BoxBoxApp.jsx` persists the key in `localStorage` (`f1coach.openRouterKey`). In the
Tauri WebView this is written unencrypted to the app data directory, readable by any local
process. The `type="password"` input only masks display, not storage.

✅ Partially addressed: the Setup tab now states the key is kept locally in cleartext.
Recommended follow-up: move it to the OS keychain (a keyring/stronghold Tauri plugin).

### S2. Derived strings interpolated into prompts without sanitization — *Low (hardening)*
`prompts.js` runs the clearly-untrusted fields (driver/track/zone names) through
`sanitizeUntrusted`, but `evidence`, `lapLog`, `trends`, and `cornerProfiles` are
interpolated raw. They are app-computed from numeric telemetry, but a corner/zone label
originating in a loaded trace can pass through. `SCOPE_RULE` + `<< >>` data-wrapping already
mitigate; sanitizing these too would be defense-in-depth.

### S3. UDP listener binds all interfaces — *Informational*
`src-tauri/src/telemetry/udp.rs` binds `0.0.0.0` on the game port. Inherent to receiving
telemetry, and every accessor in `raw.rs` is bounds-checked so a malformed/short datagram
bails via `?` rather than panicking — no memory-safety risk. A LAN host could still inject
fake telemetry / drive the FFB; acceptable for this app.

### Positives worth keeping
- CSP is tightly scoped: `object-src 'none'`, `frame-src 'none'`, `base-uri 'self'`
  (`tauri.conf.json`).
- Capabilities grant only `core:default` + `opener:default` (`capabilities/default.json`).
- Prompt-injection defense is genuine: `sanitizeUntrusted`, `<< >>` wrapping, `SCOPE_RULE`.
- Trace JSON is validated + clamped (`sanitizeTraceSamples`) on import.
- Rust readers are `Option`-returning and bounds-checked end to end.

---

## Bugs

### B1. Chat spinner race in `useCoachChat.js` — *fixed* ✅
On rapid `send()` calls the new call aborts the previous one and sets `thinking=true`; the
aborted call's `finally` then cleared it while the new request was still in flight. Guarded
with `if (abortRef.current === ctrl) setThinking(false)`.

### B2. `clearLaps` resolved before deletes completed — *fixed* ✅
`lapStore.js` resolved inside `getAllKeys.onsuccess`, before the delete writes landed.
Now resolves on `transaction.oncomplete` (and rejects on `transaction.onerror`).

### B3. Timestamp-based IDs could collide — *fixed* ✅
`lap-${Date.now()}` and the trace id `Date.now().toString()` collided when two items were
created in the same millisecond. Both now use `crypto.randomUUID()`.

### B4. `useTauriEvents` subscribes to the handler keys present at mount — *documented* ✅
The effect's empty dep array means the event *names* are read once. All callers pass a fixed
key set, so it is not a live bug; the constraint is now documented in the hook.

---

## Cleanup / maintainability

- **`BoxBoxApp.jsx` is a ~2,400-line monolith** holding the root component, lap recorder,
  telemetry wiring, and screen orchestration. Consider extracting `useLapRecorder`.
- **`lib.rs` uses `.lock().unwrap()`** in `spawn_emitter` — safe today (runs once at setup,
  before any thread could poison the mutex), but `if let Ok(..)` would be more defensive.
- **No automated tests.** The pure guardrail functions (`cleanOutput`, `enforceGrounding`,
  `sanitizeUntrusted`, `compareVersions`) are ideal, cheap unit-test targets.
- **`devCsp`** allows `'unsafe-inline'`/`'unsafe-eval'` for scripts — fine, dev-only; it
  never reaches the production CSP.
