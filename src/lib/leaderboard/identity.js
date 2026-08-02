// ─── LEADERBOARD IDENTITY ─────────────────────────────────────────────────────
// Who you are to the online boards.
//
// An anonymous account, minted silently the first time you publish a lap. No
// sign-up, no password, no email — you drive a lap, you press publish, you're on
// the board. The account exists only so that a board can enforce one entry per
// driver and so an abusive uploader can be stopped.
//
// NO SDK. Supabase's auth endpoints are ordinary REST: sign-in is one POST, and
// refresh is one more. @supabase/supabase-js would add ~40KB and a lazy-import
// dance to wrap three fetches, and this app's whole networking idiom (see
// lib/updateCheck.js, lib/coach/provider.js) is plain fetch that fails soft.
//
// THE HONEST LIMITS, which the Settings UI should state plainly:
//   • The session lives in localStorage. Clear it and the account is gone along
//     with the ability to update your own entries — they stay on the board under
//     your name, but you can no longer replace or delete them.
//   • A second PC is a second account, so it gets its own entry on a board.
//   • Both are fixed by claiming the account with an email, which is deferred.

import { AUTH_URL, ANON_KEY, TIMEOUT_MS, LS_SESSION, configured } from "./config.js";

// Refresh this long before the token actually expires, so a request that takes a
// moment to send doesn't arrive with a just-expired token.
const REFRESH_SKEW_S = 60;

let inflight = null; // de-dupes concurrent sign-in/refresh attempts

function readSession() {
  try {
    const raw = localStorage.getItem(LS_SESSION);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSession(s) {
  try {
    if (s) localStorage.setItem(LS_SESSION, JSON.stringify(s));
    else localStorage.removeItem(LS_SESSION);
  } catch { /* private mode / quota — the caller degrades to signed-out */ }
}

function toSession(body) {
  if (!body?.access_token || !body?.user?.id) return null;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    // expires_at is seconds since epoch; expires_in is a duration. Prefer the
    // absolute one — a duration is wrong the moment it's stored.
    expiresAt: body.expires_at ?? (Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600)),
    userId: body.user.id,
  };
}

async function post(path, body, headers = {}) {
  const res = await fetch(`${AUTH_URL}${path}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, json };
}

// The user id this install is publishing under, or null if it has never
// published. Never triggers a sign-in — reading who you are must not create an
// account as a side effect.
export function currentUserId() {
  return readSession()?.userId ?? null;
}

export function isSignedIn() {
  return !!readSession()?.accessToken;
}

// A valid access token, minting or refreshing the account as needed.
// → token | null   (null = offline, disabled, or anonymous sign-ins are off)
//
// CALLING THIS CREATES AN ACCOUNT if there isn't one. Only call it on a path the
// user actually initiated, never on app start.
export async function getAccessToken() {
  if (!configured) return null;
  if (inflight) return inflight;

  const session = readSession();
  const now = Math.floor(Date.now() / 1000);
  if (session?.accessToken && session.expiresAt - REFRESH_SKEW_S > now) {
    return session.accessToken;
  }

  inflight = (async () => {
    try {
      // Refresh first — keeping the same account is the whole point, since the
      // board entries hang off its id.
      if (session?.refreshToken) {
        const { ok, json } = await post("/token?grant_type=refresh_token",
          { refresh_token: session.refreshToken });
        const next = ok ? toSession(json) : null;
        if (next) { writeSession(next); return next.accessToken; }
        // Refresh failed: the token was revoked or expired past recovery. Fall
        // through to a fresh account rather than leaving the user unable to
        // publish — their existing entries stay on the board either way.
      }
      const { ok, json } = await post("/signup", {});
      const fresh = ok ? toSession(json) : null;
      if (!fresh) return null;
      writeSession(fresh);
      return fresh.accessToken;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

// Forget this install's account. The entries it published stay on the boards —
// there is no way to reclaim them afterwards, so the UI must say so before
// calling this.
export function signOut() {
  writeSession(null);
}

// Why a publish attempt couldn't authenticate, phrased for the driver. Called
// only after getAccessToken() has already returned null.
export async function diagnoseAuthFailure() {
  if (!configured) return "The leaderboards aren't set up in this build.";
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "You're offline — connect to publish a lap.";
  }
  try {
    const { json } = await post("/signup", {});
    if (json?.error_code === "anonymous_provider_disabled") {
      return "The leaderboard server isn't accepting new drivers yet.";
    }
  } catch { /* fall through to the generic message */ }
  return "Couldn't reach the leaderboard server. Try again later.";
}
