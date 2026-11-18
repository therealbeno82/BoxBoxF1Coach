// ─── SUBMIT LAP ───────────────────────────────────────────────────────────────
// The ONLY write path to the leaderboards. Row Level Security grants clients no
// insert or update on `entries` and no write on the traces bucket, so everything
// that reaches a board comes through here, holding the service role key.
//
// That matters because the checks below cannot be expressed as policies: a policy
// can't inflate a gzipped trace and confirm the speeds in it actually add up to
// the lap time being claimed. Validation needs to run somewhere that can read the
// blob, which means it needs to run here.
//
// The validation itself is imported from _shared/lib, which is a verbatim copy of
// what the app runs (see scripts/sync-leaderboard-shared.mjs). The client
// pre-checks so it can grey out a button and explain why; this is the copy that
// decides. Nothing the client sends is trusted — including which board it says
// the lap belongs on, which is re-derived here from the payload's own metadata.
//
// Deploy (order matters — the function calls both RPCs):
//   apply supabase/migrations/0003_atomic_submit.sql to the project
//   node scripts/sync-leaderboard-shared.mjs
//   npx supabase functions deploy submit-lap --project-ref <ref> --no-verify-jwt
//
// --no-verify-jwt turns off the GATEWAY's token check, not this function's. Every
// request is still authenticated below via auth.getUser(), which 401s without a
// valid user, so the gateway check would be redundant — and leaving it on gets
// the CORS preflight rejected before the handler runs, since an OPTIONS request
// carries no Authorization header. The cost is that an unauthenticated request
// burns one invocation before being refused, which the free tier's hard caps
// bound anyway.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { boardIdForLap } from "../_shared/lib/leaderboard/boardKey.js";
import { eligibility } from "../_shared/lib/leaderboard/eligibility.js";
import { validateSubmission } from "../_shared/lib/leaderboard/validate.js";
import { sanitizeDisplayName, cleanAssists } from "../_shared/lib/leaderboard/validate.js";
import { sanitizeTraceSamples } from "../_shared/lib/traceSamples.js";
import { THRESHOLDS } from "../_shared/lib/leaderboard/limits.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Rate limits, per authenticated user. An anonymous identity is free to mint, so
// these bound one identity's throughput rather than one person's — the real
// defences are that the checks below make a junk entry worthless and that the
// free tier throttles instead of billing. See the note in the plan.
const MIN_SECONDS_BETWEEN = 20;
const MAX_PER_DAY = 60;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Reject a submission with a message written to be shown to the driver verbatim.
const refuse = (reason: string, status = 422) => json({ ok: false, reason }, status);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return refuse("Unsupported method.", 405);

  // ── 1. Who is this? ────────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return refuse("You need to be signed in to publish a lap.", 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── 2. Gate: paused, banned, rate limited ──────────────────────────────────
  const { data: cfg } = await admin.from("config").select("value").eq("key", "leaderboard").maybeSingle();
  if (cfg?.value?.paused) return refuse("The leaderboards are paused right now. Try again later.", 503);

  const { data: driverRow } = await admin
    .from("drivers").select("*").eq("id", user.id).maybeSingle();

  if (driverRow?.banned) return refuse("This account can't publish laps.", 403);

  if (driverRow?.last_upload_at) {
    const since = (Date.now() - Date.parse(driverRow.last_upload_at)) / 1000;
    if (since < MIN_SECONDS_BETWEEN) {
      return refuse(`Give it ${Math.ceil(MIN_SECONDS_BETWEEN - since)}s before publishing again.`, 429);
    }
  }
  // Daily cap from the append-only counter on the driver row, NOT by counting
  // entries: an improvement REPLACES the entry, so counting rows under-counts a
  // driver who keeps improving. The date guard means a stale counter reads as 0.
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = driverRow?.daily_upload_date === today
    ? (driverRow.daily_upload_count ?? 0)
    : 0;
  if (todayCount >= MAX_PER_DAY) {
    return refuse("You've hit today's publishing limit. Try again tomorrow.", 429);
  }

  // ── 3. Inflate, with a bomb guard ──────────────────────────────────────────
  // The cap is enforced by counting bytes as they come OUT of the decompressor,
  // not by trusting the gzip trailer's declared size — the trailer is attacker-
  // controlled and a small upload can otherwise expand without limit.
  let payload: any;
  try {
    // Reject on the declared size BEFORE buffering: `arrayBuffer()` reads the
    // whole body into isolate memory, so capping afterwards only documents the
    // limit rather than enforcing it.
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > 512 * 1024) {
      return refuse("That upload is too large.", 413);
    }
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.byteLength > 512 * 1024) return refuse("That upload is too large.", 413);
    payload = JSON.parse(await inflateCapped(raw, THRESHOLDS.maxInflatedBytes));
  } catch {
    return refuse("That upload couldn't be read.", 400);
  }
  if (!payload?.meta || !Array.isArray(payload.samples)) {
    return refuse("That upload isn't a lap trace.", 400);
  }

  // ── 4. Re-derive the board from the payload's OWN metadata ─────────────────
  // Never from anything the client asserted. A lap-shaped object is rebuilt here
  // from the payload so the shared eligibility and board-key code sees exactly
  // what it sees in the app.
  const samples = sanitizeTraceSamples(payload.samples);
  const lapLike = {
    lapTime: payload.meta.lapTime,
    sectorTimes: payload.meta.sectorTimes ?? null,
    invalid: false,
    source: "live",
    // The game's Event packet said a flashback happened (client-reported, like
    // every other field here). eligibility() refuses it, as it does in the app.
    flashbacks: Number(payload.meta.flashbacks) || 0,
    samples,
    meta: {
      driver: payload.meta.driver,
      track: payload.meta.track,
      sessionType: payload.meta.sessionType,
      trackId: payload.meta.trackId,
      trackSlug: payload.meta.trackSlug,
      trackLengthM: payload.meta.trackLengthM,
    },
    tyre: payload.tyre ?? null,
  };

  const elig = eligibility(lapLike);
  if (!elig.ok) return refuse(elig.reason);

  const board = boardIdForLap(lapLike);
  if (!board.boardId) return refuse(board.reason);

  // ── 5. The checks ──────────────────────────────────────────────────────────
  const trackLengthM = Number(payload.meta.trackLengthM) || 0;
  const verdict = validateSubmission({
    samples,
    lapTime: lapLike.lapTime,
    sectorTimes: lapLike.sectorTimes,
    trackLengthM,
    slug: board.slug,
  });
  if (!verdict.ok) return refuse(verdict.reason);
  // The aids the lap reported travel in the stored checks (no schema change), so
  // a board row can show them. Display only — see cleanAssists.
  const assists = cleanAssists(payload.meta.assists);
  if (assists) verdict.checks.assists = assists;

  const displayName = sanitizeDisplayName(payload.meta.driver) ?? "Anonymous";
  // `team` is rendered on every public board row right beside the driver name,
  // so it gets the SAME treatment. Unsanitised it was an unbounded,
  // un-moderatable text channel on a public page: a URL, bidi-override
  // characters, or 50 KB of anything (the column has no constraint, and the row
  // renders it `white-space: nowrap`, so a long value blows the layout out).
  // sanitizeDisplayName returns null for an advert, which is the right outcome
  // here too — drop the field rather than refuse an otherwise-valid lap.
  const teamName = payload.meta.team == null ? null : sanitizeDisplayName(payload.meta.team);
  const lapTimeMs = Math.round(lapLike.lapTime * 1000);

  // ── 6. Store the exact bytes that were validated ───────────────────────────
  // BEFORE the row write, under a UNIQUE key. Row-first ordering left a live
  // entry whose trace_path 404s forever when the upload failed, and a
  // deterministic per-driver key let two concurrent winning requests interleave
  // so the row kept one lap's time and the other lap's blob. Unique keys remove
  // the collision: the loser (below) deletes only its own object. Re-serialised
  // from the parsed-and-sanitised object rather than the client's blob, so what
  // is served later is exactly what was checked here.
  //
  // `meta` is REBUILT from an allow-list rather than spread. The spread copied
  // whatever the client sent into a public, downloadable file: the raw `team`
  // (the row gets the sanitised one), free-text fields of any length, and any
  // extra keys at all. Only fields the app reads are kept, each type-checked.
  const canonical = {
    meta: canonicalMeta(payload.meta, { displayName, teamName, slug: board.slug, sampleCount: samples.length }),
    tyre: canonicalTyre(payload.tyre),
    miniSectors: numArray(payload.miniSectors, 18),
    samples,
  };
  const gz = await gzipJson(canonical);
  const tracePath = `${board.boardId}/${user.id}/${crypto.randomUUID()}.json.gz`;
  const { error: upErr } = await admin.storage.from("traces").upload(tracePath, gz, {
    contentType: "application/octet-stream",
    cacheControl: "300",
    upsert: false,
  });
  if (upErr) return refuse("Couldn't store the lap trace. Try again.", 500);

  // Best-effort: a leftover object is invisible (no row points at it), so this
  // never turns a successful publish into a failure.
  const dropBlob = async () => {
    try { await admin.storage.from("traces").remove([tracePath]); } catch { /* orphan */ }
  };

  // ── 7. Decide and write ATOMICALLY ─────────────────────────────────────────
  // The improvement test and the row write are ONE Postgres statement, so two
  // concurrent publishes from the same driver cannot both pass the test and then
  // overwrite each other — the loser's write simply doesn't happen.
  const { data: upserted, error: rpcErr } = await admin.rpc("submit_entry", {
    p_board_id: board.boardId,
    p_driver_id: user.id,
    p_display_name: displayName,
    p_team: teamName,
    p_track_slug: board.slug,
    p_session_group: board.session,
    p_compound: board.compound,
    p_condition: board.condition,
    p_lap_time_ms: lapTimeMs,
    p_s1_ms: msOf(lapLike.sectorTimes?.[0]),
    p_s2_ms: msOf(lapLike.sectorTimes?.[1]),
    p_s3_ms: msOf(lapLike.sectorTimes?.[2]),
    p_tyre_visual: payload.tyre?.visual ?? null,
    p_tyre_age: payload.tyre?.age ?? null,
    p_weather: payload.meta.weather ?? null,
    p_track_temp: payload.meta.trackTemp ?? null,
    p_air_temp: payload.meta.airTemp ?? null,
    p_sample_count: samples.length,
    // Prefer the circuit's committed length (the validator's effective value)
    // over what the client declared, which is only checked for consistency.
    p_lap_length_m: Math.round(Number(verdict.checks.lengthM) || trackLengthM),
    p_trace_path: tracePath,
    p_trace_bytes: gz.byteLength,
    p_app_version: payload.meta.appVersion ?? null,
    p_verdict: verdict.verdict,
    p_checks: verdict.checks,
  });
  if (rpcErr) {
    await dropBlob();
    return refuse("Couldn't publish the lap. Try again.", 500);
  }

  // ── 8. Count the publish ───────────────────────────────────────────────────
  // Lifetime + daily counters in one atomic statement. A failure here must NOT
  // fail the publish — the lap is already live — it only risks the daily cap
  // under-counting, which is the safe direction.
  //
  // This runs for EVERY accepted submission, improved or not, and that ordering
  // is the whole point: the cooldown and the daily cap at step 2 read
  // last_upload_at / daily_upload_count / daily_upload_date, and this function
  // is the only writer of them. Counting only the improvements meant a driver
  // who had already published could resubmit the same or a slower lap in a
  // tight loop forever — every request passed both limiters because neither
  // counter ever moved, and each one cost an auth round trip, an inflate, full
  // validation, a gzip, a STORAGE UPLOAD and a delete. The work is already
  // spent by the time we know whether the lap improved, so it is also the only
  // place the charge can honestly be made.
  const countPublish = async () => {
    const { error: countErr } = await admin.rpc("record_publish", {
      p_id: user.id,
      p_display_name: displayName,
      p_team: teamName,
    });
    if (countErr) console.error("record_publish failed:", countErr.message);
  };

  // A set-returning function comes back as an array; a tie/slower lap comes back
  // improved=false with the time that already stands.
  const outcome = Array.isArray(upserted) ? upserted[0] : upserted;
  if (!outcome?.improved) {
    await dropBlob();
    await countPublish();
    const best = outcome?.best_lap_time_ms ?? lapTimeMs;
    const rank = await rankOf(admin, board.boardId, best);
    return json({
      ok: true, improved: false, boardId: board.boardId,
      lapTimeMs: best, ...rank,
      reason: "You've already published a faster lap on this board.",
    });
  }

  // The improvement displaced an older trace (migration 0004 reports which).
  // Delete it: no row points at it any more, but the bucket is public-read, so
  // a superseded lap would otherwise stay downloadable — and keep spending the
  // storage quota — forever. Best-effort, like dropBlob: the publish has landed.
  if (outcome.replaced_trace_path) {
    try { await admin.storage.from("traces").remove([outcome.replaced_trace_path]); }
    catch { /* orphan — delete-entry's folder sweep still reaches it */ }
  }

  await countPublish();

  const rank = await rankOf(admin, board.boardId, lapTimeMs);
  return json({
    ok: true, improved: true, boardId: board.boardId, lapTimeMs,
    verdict: verdict.verdict, checks: verdict.checks, ...rank,
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const numArray = (v: unknown, max: number) =>
  Array.isArray(v) && v.length <= max && v.every((x) => x == null || Number.isFinite(x)) ? v : null;
// Short display text: control and bidi characters out, length capped. Not the
// display-name filter — a track or session label is not a name, and refusing
// one would refuse the lap.
const text = (v: unknown, max: number) =>
  typeof v === "string"
    ? v.replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028\u2029\u202A-\u202E\uFEFF]/g, "").trim().slice(0, max) || undefined
    : undefined;

// The published trace's meta: exactly the fields a downloaded reference uses.
function canonicalMeta(m: any, { displayName, teamName, slug, sampleCount }:
  { displayName: string; teamName: string | null; slug: string; sampleCount: number }) {
  const out: Record<string, unknown> = {
    driver: displayName,
    team: teamName ?? undefined,
    track: text(m?.track, 64),
    sessionType: text(m?.sessionType, 32),
    trackId: num(m?.trackId),
    trackSlug: slug,
    trackLengthM: num(m?.trackLengthM),
    assists: cleanAssists(m?.assists) ?? undefined,
    penalties: num(m?.penalties),
    lapTime: num(m?.lapTime),
    sectorTimes: numArray(m?.sectorTimes, 3),
    sectors: numArray(m?.sectors, 2),
    weather: num(m?.weather),
    trackTemp: num(m?.trackTemp),
    airTemp: num(m?.airTemp),
    sampleCount,
    appVersion: text(m?.appVersion, 32),
    schema: num(m?.schema),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null) delete out[k];
  return out;
}

// Tyre block — numbers only (compound ids, age, per-wheel wear).
function canonicalTyre(t: any) {
  if (!t || typeof t !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const k of ["visual", "actual", "age"]) { const v = num(t[k]); if (v !== undefined) out[k] = v; }
  const wear = numArray(t.wear, 4);
  if (wear) out.wear = wear;
  return Object.keys(out).length ? out : null;
}

const msOf = (s: number | null | undefined) =>
  (typeof s === "number" && s > 0 ? Math.round(s * 1000) : null);

// Position on a board, counted rather than stored: a rank column would be stale
// the moment anyone else published. Rides the (board_id, lap_time_ms) index.
async function rankOf(admin: any, boardId: string, lapTimeMs: number) {
  const faster = await admin.from("entries")
    .select("driver_id", { count: "exact", head: true })
    .eq("board_id", boardId).lt("lap_time_ms", lapTimeMs);
  const total = await admin.from("entries")
    .select("driver_id", { count: "exact", head: true })
    .eq("board_id", boardId);
  return { pos: (faster.count ?? 0) + 1, total: total.count ?? 0 };
}

// Inflate, aborting the moment the output passes `cap`. Counting actual output
// bytes is the point — a gzip header's declared size is attacker-controlled.
async function inflateCapped(bytes: Uint8Array, cap: number): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel(); throw new Error("inflated payload too large"); }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

async function gzipJson(obj: unknown): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
