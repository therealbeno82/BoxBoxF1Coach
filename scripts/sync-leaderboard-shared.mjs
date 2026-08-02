// ─── SYNC SHARED LEADERBOARD LOGIC INTO THE EDGE FUNCTIONS ────────────────────
// The submit-lap function has to reach the same verdict as the app: the same
// board key, the same eligibility rules, the same validation thresholds. The one
// way to guarantee that is for both to run the same source.
//
// Supabase's function bundler only reliably includes files under
// supabase/functions/, so this copies the modules there. Directory layout is
// PRESERVED (src/lib/x.js → _shared/lib/x.js), which means every relative import
// still resolves and not one line of the copied source is rewritten — no path
// munging, nothing to get subtly wrong.
//
// The set copied is derived by walking imports from the entry points below, so
// adding a dependency to a shared module doesn't need a change here.
//
// Run before deploying a function:
//   node scripts/sync-leaderboard-shared.mjs
//
// The output is generated and gitignored. Never edit _shared/lib by hand — the
// next sync overwrites it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const SRC = path.join(repo, "src");
const OUT = path.join(repo, "supabase/functions/_shared");

// What the Edge Functions actually import. Everything these reach comes along.
const ENTRY_POINTS = [
  "lib/leaderboard/boardKey.js",
  "lib/leaderboard/limits.js",
  "lib/leaderboard/validate.js",
  "lib/leaderboard/eligibility.js",
  "lib/traceSamples.js",
];

const BANNER = (rel) => `// GENERATED FILE — DO NOT EDIT.
// Copied from src/${rel} by scripts/sync-leaderboard-shared.mjs so the Edge
// Function validates with exactly the same code the app does. Edit the original.

`;

// Relative specifiers only — a bare specifier would be a real dependency and
// this whole set is deliberately dependency-free.
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["'](\.[^"']+)["']/g;

const seen = new Set();
const queue = [...ENTRY_POINTS];

while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);

  const abs = path.join(SRC, rel);
  if (!fs.existsSync(abs)) {
    console.error(`  ✗ missing: src/${rel}`);
    process.exitCode = 1;
    continue;
  }
  const source = fs.readFileSync(abs, "utf8");

  // Follow this file's relative imports.
  for (const m of source.matchAll(IMPORT_RE)) {
    const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
    if (!seen.has(dep)) queue.push(dep);
  }

  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, BANNER(rel) + source);
}

const copied = [...seen].sort();
console.log(`\nsynced ${copied.length} modules → supabase/functions/_shared/`);
for (const rel of copied) console.log(`  ${rel}`);
console.log();
