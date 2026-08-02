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
// Deploy:
//   node scripts/sync-leaderboard-shared.mjs
//   supabase functions deploy submit-lap

import { createClient } from "jsr:@supabase/supabase-js@2";
import { boardIdForLap } from "../_shared/lib/leaderboard/boardKey.js";
import { eligibility } from "../_shared/lib/leaderboard/eligibility.js";
import { validateSubmission } from "../_shared/lib/leaderboard/validate.js";
import { sanitizeDisplayName } from "../_shared/lib/leaderboard/validate.js";
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
  if (await uploadsToday(admin, user.id) >= MAX_PER_DAY) {
    return refuse("You've hit today's publishing limit. Try again tomorrow.", 429);
  }

  // ── 3. Inflate, with a bomb guard ──────────────────────────────────────────
  // The cap is enforced by counting bytes as they come OUT of the decompressor,
  // not by trusting the gzip trailer's declared size — the trailer is attacker-
  // controlled and a small upload can otherwise expand without limit.
  let payload: any;
  try {
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

  const displayName = sanitizeDisplayName(payload.meta.driver) ?? "Anonymous";
  const lapTimeMs = Math.round(lapLike.lapTime * 1000);

  // ── 6. Is it actually an improvement? ──────────────────────────────────────
  // Checked BEFORE touching storage, so a slower lap costs one cheap read rather
  // than an object write that then has to be rolled back.
  const { data: existing } = await admin
    .from("entries").select("lap_time_ms")
    .eq("board_id", board.boardId).eq("driver_id", user.id).maybeSingle();

  if (existing && existing.lap_time_ms <= lapTimeMs) {
    const rank = await rankOf(admin, board.boardId, existing.lap_time_ms);
    return json({
      ok: true, improved: false, boardId: board.boardId,
      lapTimeMs: existing.lap_time_ms, ...rank,
      reason: "You've already published a faster lap on this board.",
    });
  }

  // ── 7. Store the exact bytes that were validated ───────────────────────────
  // Re-serialised from the parsed-and-sanitised object rather than storing the
  // client's blob verbatim: that closes any gap between what was checked here and
  // what gets served to everyone else later.
  const canonical = {
    meta: { ...payload.meta, driver: displayName },
    tyre: payload.tyre ?? null,
    miniSectors: payload.miniSectors ?? null,
    samples,
  };
  const gz = await gzipJson(canonical);
  const tracePath = `${board.boardId}/${user.id}.json.gz`;

  const { error: upErr } = await admin.storage.from("traces").upload(tracePath, gz, {
    contentType: "application/octet-stream",
    cacheControl: "300",
    upsert: true,
  });
  if (upErr) return refuse("Couldn't store the lap trace. Try again.", 500);

  // ── 8. Upsert the row ──────────────────────────────────────────────────────
  const row = {
    board_id: board.boardId,
    driver_id: user.id,
    display_name: displayName,
    team: payload.meta.team ?? null,
    track_slug: board.slug,
    session_group: board.session,
    compound: board.compound,
    condition: board.condition,
    lap_time_ms: lapTimeMs,
    s1_ms: msOf(lapLike.sectorTimes?.[0]),
    s2_ms: msOf(lapLike.sectorTimes?.[1]),
    s3_ms: msOf(lapLike.sectorTimes?.[2]),
    tyre_visual: payload.tyre?.visual ?? null,
    tyre_age: payload.tyre?.age ?? null,
    weather: payload.meta.weather ?? null,
    track_temp: payload.meta.trackTemp ?? null,
    air_temp: payload.meta.airTemp ?? null,
    sample_count: samples.length,
    lap_length_m: Math.round(trackLengthM),
    trace_path: tracePath,
    trace_bytes: gz.byteLength,
    app_version: payload.meta.appVersion ?? null,
    verdict: verdict.verdict,
    checks: verdict.checks,
    updated_at: new Date().toISOString(),
  };

  const { error: insErr } = await admin
    .from("entries").upsert(row, { onConflict: "board_id,driver_id" });
  if (insErr) return refuse("Couldn't publish the lap. Try again.", 500);

  await admin.from("drivers").upsert({
    id: user.id,
    display_name: displayName,
    team: payload.meta.team ?? null,
    upload_count: (driverRow?.upload_count ?? 0) + 1,
    last_upload_at: new Date().toISOString(),
  }, { onConflict: "id" });

  const rank = await rankOf(admin, board.boardId, lapTimeMs);
  return json({
    ok: true, improved: true, boardId: board.boardId, lapTimeMs,
    verdict: verdict.verdict, checks: verdict.checks, ...rank,
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

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

async function uploadsToday(admin: any, userId: string) {
  const since = new Date(Date.now() - 86400_000).toISOString();
  const { count } = await admin.from("entries")
    .select("driver_id", { count: "exact", head: true })
    .eq("driver_id", userId).gte("updated_at", since);
  return count ?? 0;
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
