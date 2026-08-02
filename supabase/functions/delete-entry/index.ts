// ─── DELETE ENTRY ─────────────────────────────────────────────────────────────
// Take your own lap off a board.
//
// There IS an owner-delete policy on `entries`, so a client could remove its own
// row directly — but a policy can only touch the database. The trace blob lives
// in storage and would be left orphaned and still publicly readable, which is
// exactly the wrong outcome for someone who just asked to take their lap down.
// Both halves have to go, so both go through here.
//
// Deploy:
//   npx supabase functions deploy delete-entry --project-ref <ref> --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...cors },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, reason: "Unsupported method." }, 405);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ ok: false, reason: "You need to be signed in." }, 401);

  let boardId: string | undefined;
  try { ({ boardId } = await req.json()); } catch { /* handled below */ }
  if (!boardId) return json({ ok: false, reason: "No board given." }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // Scoped to this user's own row by both keys, so there is no path here that
  // touches anyone else's entry even if boardId is attacker-chosen.
  const { data: row } = await admin
    .from("entries").select("trace_path")
    .eq("board_id", boardId).eq("driver_id", user.id).maybeSingle();

  if (!row) return json({ ok: false, reason: "You have no lap on that board." }, 404);

  // Storage first, and its result is CHECKED. If the row went first and this
  // failed, the blob would be orphaned with nothing left pointing at it to retry
  // from — still publicly readable, by someone who just asked to take their lap
  // down. Ignoring this error is precisely how that ships unnoticed, so a
  // storage failure aborts the whole delete and the row stays put.
  if (row.trace_path) {
    const { error: rmErr } = await admin.storage.from("traces").remove([row.trace_path]);
    if (rmErr) {
      return json({ ok: false, reason: `Couldn't remove the lap's trace: ${rmErr.message}` }, 500);
    }
  }

  const { error } = await admin
    .from("entries").delete()
    .eq("board_id", boardId).eq("driver_id", user.id);
  if (error) return json({ ok: false, reason: "Couldn't remove that lap." }, 500);

  return json({ ok: true });
});
