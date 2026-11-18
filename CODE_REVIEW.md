# F1 Coach — Security & Code Review Notes

What a reviewer should know about this codebase's attack surface and its known
limits. The history of individual fixes lives in the git log (each review pass
landed as commits that explain the failure they fixed); this file is the
standing summary, not a changelog.

## Attack surface

- **Tauri capabilities** grant `core:default`, `opener:default` and
  `dialog:default` on desktop (`src-tauri/capabilities/default.json`), plus the
  `f1android` plugin on Android only (`capabilities/android.json`).
- **CSP** (`tauri.conf.json`) is tightly scoped: `object-src 'none'`,
  `frame-src 'none'`, `base-uri 'self'`, and `connect-src` lists only
  OpenRouter, the GitHub release API and the Supabase project. `devCsp` is
  looser (it allows the jsdelivr CDN and `unsafe-eval` for Vite) and never
  reaches a packaged build.
- **The UDP listener binds all interfaces** on the game port so a console on the
  LAN can reach it. It only receives; every reader in `telemetry/raw.rs` is
  bounds-checked and every packet parser is all-or-nothing, so a short or
  spoofed datagram is dropped without writing a field. A LAN host can still
  send fake telemetry — and through it drive the wheel — within the FFB
  engine's own output caps (`max_output`, slew, soft-start, the safety release).
- **`write_text_file`** writes to any path it is given. Deliberately: the path
  comes from the native Save dialog the user just answered, and the command
  avoids opening a filesystem scope for the whole app.
- **FFB settings** are clamped to the tab's own ranges on the way in
  (`FfbSettings::sanitized`), so an imported profile can't reverse the steering
  force or defeat the output cap.

## Data the app holds

- **The OpenRouter API key is stored in plaintext** in `localStorage` (the
  WebView's app-data directory). It only ever travels to OpenRouter. Moving it to
  the OS keychain is an open follow-up.
- Laps, avatars, track maps and downloaded references live in IndexedDB. A
  profile export carries all of them except the API key.

## LLM guardrails (`src/lib/coach/`)

The debrief is the only LLM call. Untrusted text (driver, track and zone names
from imported traces) is sanitised before it enters a prompt and wrapped in
`<< >>`; the model may only cite numbers present in the lap evidence
(`enforceGrounding`); replies are shaped and length-capped, and a reply cut off
mid-JSON is never shown or spoken as JSON. Covered by `npm test`.

## Online leaderboards (`lib/leaderboard/`, `supabase/`)

- Clients never write: RLS is read-only everywhere, and the `submit-lap` Edge
  Function (service role) is the only writer. It re-derives the board, validates
  the trace (`validate.js`, shared byte-for-byte with the app), stores the exact
  bytes it validated, writes atomically, and deletes the trace an improvement
  replaces. Published meta is rebuilt from an allow-list.
- **Known limit:** validation cannot catch a genuinely driven lap with assists
  on unless the client reports them — and anything the client reports is an
  honesty check, not anti-tamper.
- The anonymous-auth session lives in `localStorage`; losing it loses the ability
  to replace or delete your own entries (they stay on the board).

## Testing

`npm test` (pure JS modules, `node --test`, no dependencies) and
`cargo test --lib` in `src-tauri/` (parsers, FFB reconstruction and safety
gates, core status). UI paths are verified by running the app — see CLAUDE.md.
