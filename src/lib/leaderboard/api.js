// ─── LEADERBOARD API ──────────────────────────────────────────────────────────
// Every call the app makes to the online boards. Reads only, for now — the
// upload path arrives with the Edge Function.
//
// PLAIN FETCH, NO SDK. Supabase's REST layer (PostgREST) is an ordinary HTTP API
// and reads need nothing but the public anon key, so the Leaderboard screen and
// — more importantly — the Dashboard card, which runs on the default tab at
// every launch, never pull in a dependency. Only the auth and upload paths need
// the SDK, and they load it lazily.
//
// EVERY FUNCTION FAILS SOFT. No call here throws; each resolves to null or an
// empty list. This is the same contract as lib/updateCheck.js and it exists
// because CLAUDE.md's first rule is that the app works with no network at all.
// A driver at a race weekend with the router off must see the app behave
// normally, minus a board.

import { REST_URL, ANON_KEY, STORAGE_URL, FUNCTIONS_URL, TRACE_BUCKET, TIMEOUT_MS, configured } from "./config.js";
import { entryFromRow, rankEntries } from "./entries.js";
import { buildSubmission, gzipJson } from "./payload.js";
import { getAccessToken, diagnoseAuthFailure, currentUserId } from "./identity.js";

// Is the feature usable right now? Configured, enabled by the user, and the
// browser believes it has a network. The onLine check is the cheap one that
// avoids a guaranteed-doomed request on a plane.
export function available({ enabled = true } = {}) {
  if (!configured || !enabled) return false;
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

// One fetch, with a timeout and no way to throw.
// → parsed JSON | null. `head` returns the Content-Range count instead.
async function request(url, { headers = {}, signal, count = false } = {}) {
  try {
    const res = await fetch(url, {
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
        Accept: "application/json",
        ...(count ? { Prefer: "count=exact" } : {}),
        ...headers,
      },
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    if (count) {
      // PostgREST reports an exact count in Content-Range as "0-24/518".
      const range = res.headers.get("content-range") || "";
      const total = Number(range.split("/")[1]);
      return Number.isFinite(total) ? total : null;
    }
    return await res.json();
  } catch {
    return null; // offline, timeout, DNS, CORS, malformed JSON — all the same here
  }
}

// Every board that has at least one entry, with its count and leader time.
// → [{ boardId, trackSlug, sessionGroup, entryCount, bestTimeMs }] (never null)
export async function listBoards({ enabled, signal } = {}) {
  if (!available({ enabled })) return [];
  const rows = await request(
    `${REST_URL}/boards?select=board_id,track_slug,session_group,entry_count,best_time_ms`,
    { signal });
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    boardId: r.board_id,
    trackSlug: r.track_slug,
    sessionGroup: r.session_group,
    entryCount: r.entry_count,
    bestTimeMs: r.best_time_ms,
  }));
}

// One board's ranked rows, fastest first.
// → { entries, total } | null   (null means the fetch failed — which the UI has
// to tell apart from an empty board, since they need different messages)
export async function getBoard(boardId, { limit = 50, offset = 0, myDriverId, enabled, signal } = {}) {
  if (!boardId || !available({ enabled })) return null;
  const cols = [
    "board_id", "driver_id", "display_name", "team", "lap_time_ms",
    "s1_ms", "s2_ms", "s3_ms", "compound", "condition", "tyre_visual", "tyre_age",
    "verdict", "trace_path", "created_at",
  ].join(",");
  const url = `${REST_URL}/entries` +
    `?select=${cols}&board_id=eq.${encodeURIComponent(boardId)}` +
    `&order=lap_time_ms.asc&limit=${limit}&offset=${offset}`;
  const rows = await request(url, { signal });
  if (!Array.isArray(rows)) return null;
  const entries = rankEntries(rows.map((r) => entryFromRow(r, { myDriverId })).filter(Boolean));
  return { entries, total: entries.length };
}

// Where a given time would sit on a board, as a 1-based position, without
// pulling the rows down. Counting the entries strictly faster than `lapTimeMs`
// is exact and rides the same (board_id, lap_time_ms) index a board page uses.
// → { pos, total } | null
export async function rankFor(boardId, lapTimeMs, { enabled, signal } = {}) {
  if (!boardId || !(lapTimeMs > 0) || !available({ enabled })) return null;
  const base = `${REST_URL}/entries?select=driver_id&board_id=eq.${encodeURIComponent(boardId)}`;
  const [faster, total] = await Promise.all([
    request(`${base}&lap_time_ms=lt.${lapTimeMs}&limit=1`, { signal, count: true }),
    request(`${base}&limit=1`, { signal, count: true }),
  ]);
  if (faster == null || total == null) return null;
  return { pos: faster + 1, total };
}

// This driver's own published entry on a board, if they have one.
// → entry | null. Null also means "not published", which the caller has to tell
// apart from "failed to ask" using `available()` if it matters.
export async function myEntryOn(boardId, { enabled, signal } = {}) {
  const uid = currentUserId();
  if (!boardId || !uid || !available({ enabled })) return null;
  const rows = await request(
    `${REST_URL}/entries?select=board_id,driver_id,display_name,team,lap_time_ms,s1_ms,s2_ms,s3_ms,` +
    `compound,condition,tyre_visual,tyre_age,verdict,trace_path,created_at` +
    `&board_id=eq.${encodeURIComponent(boardId)}&driver_id=eq.${uid}&limit=1`, { signal });
  if (!Array.isArray(rows) || !rows.length) return null;
  return entryFromRow(rows[0], { myDriverId: uid });
}

// Every board this driver has an entry on, newest first. Powers the "your
// published laps" list in Settings — the only place a driver can take one back
// down, which is why it exists at all.
// → entry[] | null   (null = couldn't ask; [] = nothing published)
export async function myEntries({ enabled, signal } = {}) {
  const uid = currentUserId();
  if (!uid || !available({ enabled })) return null;
  const rows = await request(
    `${REST_URL}/entries?select=board_id,driver_id,display_name,team,lap_time_ms,` +
    `s1_ms,s2_ms,s3_ms,compound,condition,tyre_visual,tyre_age,verdict,trace_path,created_at` +
    `&driver_id=eq.${uid}&order=updated_at.desc`, { signal });
  if (!Array.isArray(rows)) return null;
  return rows.map((r) => entryFromRow(r, { myDriverId: uid })).filter(Boolean);
}

// ─── Publishing ───────────────────────────────────────────────────────────────
// Publish a lap to its board. Unlike every read above, this one reports failure
// rather than swallowing it — the driver pressed a button and is owed an answer.
//
// → { ok: true, improved, boardId, lapTimeMs, pos, total, verdict, reason? }
// → { ok: false, reason }        reason is written to be shown verbatim
//
// The server re-runs every check this client already ran, and re-derives the
// board from the payload rather than trusting what we say it is. That isn't
// redundancy: the client's answer is a courtesy so a button can be greyed out
// with an explanation, and the server's is the one that decides.
export async function submitLap(lap, { displayName, team, enabled, signal } = {}) {
  if (!configured) return { ok: false, reason: "The leaderboards aren't set up in this build." };
  if (!available({ enabled })) {
    return { ok: false, reason: "You're offline — connect to publish a lap." };
  }

  const payload = buildSubmission(lap);
  if (!payload) return { ok: false, reason: "This lap can't be published." };
  if (displayName) payload.meta.driver = displayName;
  if (team) payload.meta.team = team;

  // Minting the account is deferred to exactly here: the first time the driver
  // actually chooses to publish something, never on app start.
  const token = await getAccessToken();
  if (!token) return { ok: false, reason: await diagnoseAuthFailure() };

  try {
    const body = await gzipJson(payload);
    const res = await fetch(`${FUNCTIONS_URL}/submit-lap`, {
      method: "POST",
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body,
      // Publishing is a deliberate action and carries ~11KB, so it gets a longer
      // leash than the background reads above.
      signal: signal ?? AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => null);
    if (!json) return { ok: false, reason: "The leaderboard server didn't respond properly." };
    if (!res.ok || json.ok === false) {
      return { ok: false, reason: json.reason || "The lap was refused." };
    }
    return json;
  } catch {
    return { ok: false, reason: "Couldn't reach the leaderboard server. Try again." };
  }
}

// Take your own entry off a board. Routed through the Edge Function rather than
// the owner-delete RLS policy so the stored trace goes with the row — a policy
// can delete the database row but not the object in storage, which would leave
// the blob orphaned and still publicly readable.
// → { ok: true } | { ok: false, reason }
export async function deleteEntry(boardId, { signal } = {}) {
  if (!boardId || !configured) return { ok: false, reason: "Not available." };
  const token = await getAccessToken();
  if (!token) return { ok: false, reason: await diagnoseAuthFailure() };
  try {
    const res = await fetch(`${FUNCTIONS_URL}/delete-entry`, {
      method: "POST",
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ boardId }),
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) return { ok: false, reason: json?.reason || "Couldn't remove that lap." };
    return { ok: true };
  } catch {
    return { ok: false, reason: "Couldn't reach the leaderboard server." };
  }
}

// Pull an entry's trace blob and inflate it.
// → { meta, tyre, samples } | null
//
// The object is stored gzipped, so it's inflated here with DecompressionStream
// rather than trusting a Content-Encoding header to survive the round trip.
// Callers must still run the samples through sanitizeTraceSamples: this is
// third-party data about to reach the coaching engine.
export async function fetchTrace(tracePath, { signal } = {}) {
  if (!tracePath || !configured) return null;
  try {
    const url = `${STORAGE_URL}/object/public/${TRACE_BUCKET}/${tracePath}`;
    const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
    const text = await new Response(stream).text();
    const json = JSON.parse(text);
    return (json && json.meta && Array.isArray(json.samples)) ? json : null;
  } catch {
    return null;
  }
}
