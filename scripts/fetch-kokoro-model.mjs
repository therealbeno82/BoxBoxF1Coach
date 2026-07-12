// ─── FETCH + VENDOR THE KOKORO TTS MODEL ───────────────────────────────────────
// One-time per-clone setup script (see README "Getting started"). The output is
// gitignored — ~97 MB of weights is too heavy for the repo (unlike the small
// committed output of scripts/fetch-tracks.mjs). Downloads the quantized (q8) Kokoro
// ONNX weights + config/tokenizer from the Hugging Face Hub, and copies the curated
// voice style vectors that ship inside the kokoro-js npm package, into public/kokoro/
// so the packaged app never needs to hit huggingface.co at runtime — see the fetch
// interceptor in src/lib/kokoroTTS.js that redirects kokoro-js's requests here.
//
//   node scripts/fetch-kokoro-model.mjs
//
// Re-run after bumping the kokoro-js version in package.json (voice files are
// re-copied every run; the ~90 MB model download is skipped if already present).

import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KOKORO_VOICES } from "../src/lib/kokoroTTS.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "public/kokoro");
const HF_BASE = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main";

// Only the q8-quantized model — see src/lib/kokoroTTS.js for why fp32 isn't bundled.
const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"];

async function fetchToFile(url, destPath) {
  if (existsSync(destPath) && statSync(destPath).size > 0) {
    console.log(`[fetch-kokoro-model] skip (already present) ${destPath}`);
    return;
  }
  console.log(`[fetch-kokoro-model] downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, buf);
  console.log(`[fetch-kokoro-model] wrote ${destPath} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

for (const file of MODEL_FILES) {
  await fetchToFile(`${HF_BASE}/${file}`, resolve(outDir, file));
}

// Voice style vectors ship inside kokoro-js itself (node_modules/kokoro-js/voices/) —
// no network needed. Only vendor the accents/voices this app actually exposes
// (see KOKORO_VOICES in src/lib/kokoroTTS.js) to keep the bundle size down.
const voicesSrcDir = resolve(root, "node_modules/kokoro-js/voices");
const voicesOutDir = resolve(outDir, "voices");
mkdirSync(voicesOutDir, { recursive: true });
for (const { id } of KOKORO_VOICES) {
  const from = resolve(voicesSrcDir, `${id}.bin`);
  const to = resolve(voicesOutDir, `${id}.bin`);
  if (!existsSync(from)) {
    console.error(`[fetch-kokoro-model] missing ${from} — is kokoro-js installed?`);
    process.exit(1);
  }
  copyFileSync(from, to);
  console.log(`[fetch-kokoro-model] ${id}.bin -> public/kokoro/voices/`);
}

console.log("[fetch-kokoro-model] done.");
