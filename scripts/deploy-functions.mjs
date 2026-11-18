// ─── DEPLOY THE LEADERBOARD EDGE FUNCTIONS ────────────────────────────────────
// The two-step deploy, as one command that cannot skip its first step:
//
//   1. sync-leaderboard-shared.mjs — copy the app's own validation modules into
//      supabase/functions/_shared/, so the server validates with byte-identical
//      code. Deploying without it ships whatever stale copy is lying there.
//   2. `supabase functions deploy <name> --no-verify-jwt` for each function.
//      --no-verify-jwt is REQUIRED: the gateway's JWT check rejects the CORS
//      preflight (an OPTIONS request carries no Authorization header), so the
//      app's fetch fails before the function runs. Each function authenticates
//      the caller itself. supabase/config.toml says the same thing, so a deploy
//      typed by hand without the flag is covered too.
//
// The project ref is read from src/lib/leaderboard/config.js's PROJECT_URL (it is
// public — it's the host every client already talks to), or pass one:
//
//   node scripts/deploy-functions.mjs                 # every function
//   node scripts/deploy-functions.mjs submit-lap      # just one
//   SUPABASE_PROJECT_REF=abc node scripts/deploy-functions.mjs
//
// Migrations are NOT applied here — they are a separate, deliberate step, since a
// schema change can't be rolled back the way a function deploy can:
//
//   npx supabase@3 db push --remote=<ref> --dry-run   # what would be applied
//   npx supabase@3 db push --remote=<ref>
//
// The --remote is not optional: since CLI v3, a bare `db push` targets the LOCAL
// Docker stack and fails with "connect ECONNREFUSED 127.0.0.1:54322".
//
// The CLI is pinned to major 3 because nothing in this repo installs it — npx
// fetches whatever is latest, and v3 already moved one default from under us
// (and drops --project-ref, which this script used to pass, in v4).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const FUNCTIONS = ["submit-lap", "delete-entry"];

function projectRef() {
  if (process.env.SUPABASE_PROJECT_REF) return process.env.SUPABASE_PROJECT_REF;
  const cfg = fs.readFileSync(path.join(repo, "src/lib/leaderboard/config.js"), "utf8");
  const m = cfg.match(/PROJECT_URL\s*=\s*"https:\/\/([a-z0-9]+)\.supabase\.co"/);
  if (!m) throw new Error("Couldn't read the project ref from config.js — set SUPABASE_PROJECT_REF.");
  return m[1];
}

// On Windows `npx` is a .cmd, which Node only spawns through a shell — and a
// shell given an argument ARRAY just concatenates it (DEP0190). Hand it the one
// command line instead; every argument here is a fixed word, a function name off
// the allow-list or a [a-z0-9] project ref, so there is nothing to quote.
function run(cmd, args) {
  const line = `${cmd} ${args.join(" ")}`;
  console.log(`\n$ ${line}`);
  const r = process.platform === "win32"
    ? spawnSync(line, { cwd: repo, stdio: "inherit", shell: true })
    : spawnSync(cmd, args, { cwd: repo, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n✗ ${cmd} exited with ${r.status}`);
    process.exit(r.status || 1);
  }
}

const wanted = process.argv.slice(2);
const targets = wanted.length ? wanted : FUNCTIONS;
for (const t of targets) {
  if (!FUNCTIONS.includes(t)) {
    console.error(`✗ unknown function "${t}" (known: ${FUNCTIONS.join(", ")})`);
    process.exit(1);
  }
}

const ref = projectRef();
if (!/^[a-z0-9]+$/.test(ref)) {
  console.error(`✗ "${ref}" doesn't look like a Supabase project ref`);
  process.exit(1);
}
run("node", ["scripts/sync-leaderboard-shared.mjs"]);
for (const fn of targets) {
  run("npx", ["supabase@3", "functions", "deploy", fn, `--remote=${ref}`, "--no-verify-jwt"]);
}
console.log(`\n✓ deployed ${targets.join(", ")} to ${ref}`);
