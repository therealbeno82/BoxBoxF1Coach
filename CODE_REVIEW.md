# F1 Coach — Code Review

Scope: Tauri (Rust) shell, React frontend (`src/`), Node telemetry bridge (`bridge/`), build scripts. Dependencies and build artifacts excluded.

**Overall:** Well-structured and unusually well-commented. Tauri attack surface is minimal, the LLM layer has real prompt-injection guardrails, and all external inputs (trace files, avatar uploads, telemetry) are validated or sanitized. Findings below are mostly hardening and polish — nothing critical.

---

## Security

### 1. OpenRouter API key stored in plaintext — *Moderate*
`F1CoachApp.jsx:1519-1522` persists the key in `localStorage` (`f1coach.openRouterKey`). In a Tauri WebView this is written unencrypted to the app's data directory, readable by any local process or anyone with disk access.

Mitigation: store it via the OS keychain (`tauri-plugin-stronghold` or a keyring plugin), or at minimum surface a note in the Setup tab that the key is kept locally in cleartext. The `type="password"` input only masks display, not storage.

### 2. Bridge WebSocket binds all interfaces — *Low*
`bridge/f1-bridge.cjs:86` — `new WebSocketServer({ port: WS_PORT })` listens on `0.0.0.0`, so any host on the LAN can connect, receive your live telemetry, and send `setUdpPort` to re-point the UDP listener (`:97-101`).

Fix: bind to loopback only —
```js
const wss = new WebSocketServer({ host: "127.0.0.1", port: WS_PORT });
```
Optionally reject connections with an unexpected `Origin`.

### 3. One-shot raw setup dump to logs — *Low*
`bridge/f1-bridge.cjs:276-284` prints the full car-setup JSON to stdout/stderr, which Rust forwards into the app log (`lib.rs:32-37`). Useful in dev, but gate it behind a `DEBUG`/env flag (or remove) for release builds.

### Positives worth keeping
- CSP is tightly scoped and `object-src 'none'`, `frame-src 'none'`, `base-uri 'self'` are set (`tauri.conf.json:26`).
- Capabilities grant only `core:default` (`capabilities/default.json`); the shell plugin is used internally and **not** exposed to the frontend.
- Prompt-injection defense is genuine: `sanitizeUntrusted`, `<< >>` data wrapping, and `SCOPE_RULE` (`lib/coach/guardrails.js`, `config.js`, `prompts.js`).
- Trace JSON is validated + clamped (`sanitizeTraceSamples`), avatar uploads are type/size checked (`avatarImage.js`).
- ONNX runtime is served same-origin instead of a CDN to satisfy CSP (`copy-ort.mjs`, `transformersConfig.js`).

---

## Potential bugs

### 1. Chat spinner race in `useCoachChat.js` — *Low*
On rapid successive `send()` calls, the new call sets `thinking=true` and aborts the previous request. The aborted call's `finally { setThinking(false) }` then runs *after*, switching the spinner off while the new request is still in flight.

Fix: only clear state if the request is still current —
```js
} finally {
  if (abortRef.current === ctrl) setThinking(false);
}
```

### 2. `clearLaps` resolves before deletes complete — *Low*
`lapStore.js:119-123` calls `resolve()` immediately after issuing the deletes inside `getAllKeys.onsuccess`. It works (same transaction), but the promise resolves before the writes finish — fragile if a caller ever awaits it expecting completion. Resolve on `tx.oncomplete` instead.

### 3. Timestamp-based IDs can collide — *Very low*
`lap-${Date.now()}` (`F1CoachApp.jsx:698`), trace id `Date.now().toString()` (`:2108`). Two items created in the same millisecond collide. Use `crypto.randomUUID()` or append a counter.

---

## Cleanup / maintainability

- **`F1CoachApp.jsx` is a ~2,400-line monolith** holding the root component plus the lap recorder, WS logic, and screen orchestration. The `lib/` and `components/` split is good; consider extracting the recorder (`useLapRecorder`) and WS connection into their own hook modules.
- **`lib.rs` uses `.lock().unwrap()`** (`:26`, `:52`) — panics if the mutex is poisoned. Low risk, but `if let Ok(mut g) = ...lock()` is safer on a shutdown path.
- **No automated tests** in the source tree. The guardrails (`cleanOutput`, `enforceGrounding`, `sanitizeUntrusted`) and `sectorSeconds`/lap-completion logic are pure and ideal unit-test targets.
- **`BROADCAST_HZ = 30`** is hardcoded though comments mention a 60 Hz option; make it an env override for consistency with the other tunables.
- **`devCsp`** allows `'unsafe-inline'`/`'unsafe-eval'` for scripts — fine since it's dev-only, just noting it never reaches production CSP.
