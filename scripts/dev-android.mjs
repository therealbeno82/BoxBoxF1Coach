// Dev server with the ANDROID build flags on, in a desktop browser.
//
// `npm run dev` is always the desktop build: `isAndroid` comes from
// TAURI_ENV_PLATFORM, which only Tauri sets, so a narrow viewport reproduces every
// responsive branch but NONE of the three Android-only omissions (no FFB tab, no
// OpenRouter card, no Trace Calibrator) or the platform-voice UI. Setting the
// variable by hand gets those too, without a device, an emulator or the NDK.
//
// What it still can't show is anything that needs the Rust side: `inTauri` is
// false in a browser, so telemetry, the local-IP card and the f1android plugin
// (speech, keep-awake, multicast lock) all report themselves unavailable rather
// than working. Use it for LAYOUT and build-flag branches; use a real build to
// test the plugin.
//
// A node wrapper rather than an inline `VAR=… vite`, because that syntax differs
// between cmd.exe and the Git Bash shell this repo is also driven from.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run vite's own entry under this node, rather than the `vite`/`npx` shim: node 24
// on Windows refuses to spawn a .cmd without a shell, and a shell is exactly what
// this script exists to avoid.
const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const args = [vite, "--port", "1431", "--strictPort", ...process.argv.slice(2)];

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: { ...process.env, TAURI_ENV_PLATFORM: "android" },
});
// Without an error handler a failed spawn (missing node_modules/vite) is
// reported as a clean exit by the `exit` handler's `code ?? 0`.
child.on("error", (err) => {
  console.error(`dev:android: could not start vite — ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));
