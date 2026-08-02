// ─── LEADERBOARD CONFIG ───────────────────────────────────────────────────────
// Where the online boards live.
//
// THE ANON KEY IS NOT A SECRET. Supabase publishable/anon keys are designed to
// ship in client code — everything they can reach is bounded by Row Level
// Security, which on this project grants public SELECT and no write at all. It
// is committed here rather than read from .env deliberately: an env var that
// goes missing yields `undefined` and fails at runtime with a confusing error,
// there is nothing to protect, and a fresh clone should build a working app.
//
// The SERVICE ROLE key is a real secret and appears nowhere in this repo. It
// lives only in the Edge Function's environment.
//
// Until PROJECT_URL is filled in, `enabled` is false and every call in api.js
// short-circuits — the Leaderboard screen falls back to the local preview and
// nothing else in the app notices. That is also exactly what happens when the
// user turns the feature off, so the offline path gets exercised either way.

// Replace with the project URL from Supabase → Project Settings → Data API.
// Shape: https://<project-ref>.supabase.co
export const PROJECT_URL = "";

// Supabase → Project Settings → API Keys → anon / public.
export const ANON_KEY = "";

// One host covers REST, Auth, Storage and Functions — they're all paths on the
// same origin, which is why the CSP needs exactly one new entry.
export const REST_URL = `${PROJECT_URL}/rest/v1`;
export const AUTH_URL = `${PROJECT_URL}/auth/v1`;
export const STORAGE_URL = `${PROJECT_URL}/storage/v1`;
export const FUNCTIONS_URL = `${PROJECT_URL}/functions/v1`;

export const TRACE_BUCKET = "traces";

// Is the feature configured at all? Every entry point checks this first.
export const configured = !!PROJECT_URL && !!ANON_KEY;

// Requests give up quickly. A leaderboard is a nice-to-have on a screen the
// driver may be looking at between sessions — it must never be the reason the
// app feels stuck, and CLAUDE.md's no-network rule means a hang is the one
// failure mode that actually hurts.
export const TIMEOUT_MS = 6000;

// localStorage keys, following the app's f1coach.* convention.
export const LS_ENABLED = "f1coach.leaderboard.enabled";
export const LS_SESSION = "f1coach.leaderboard.session";
export const LS_DISPLAY_NAME = "f1coach.leaderboard.name";
