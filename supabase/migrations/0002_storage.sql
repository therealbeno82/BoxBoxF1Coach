-- ─── TRACE STORAGE ───────────────────────────────────────────────────────────
-- The gzipped { meta, tyre, samples } blob behind each entry, one object per
-- entry at `<board_id>/<driver_id>.json.gz`. Keeping the trace out of Postgres
-- means a board page fetches ~50 small rows instead of 50 x 80KB of telemetry.
--
-- Public read, no client write — same rule as the entries table, and for the
-- same reason: the Edge Function is the only writer, and it holds the service
-- role key which bypasses these policies.
--
-- Stored gzipped and inflated client-side with DecompressionStream rather than
-- relying on a Content-Encoding header surviving the round trip. ~10.6KB an
-- object instead of ~82KB, and deterministic.

insert into storage.buckets (id, name, public)
values ('traces', 'traces', true)
on conflict (id) do nothing;

drop policy if exists traces_public_read on storage.objects;
create policy traces_public_read on storage.objects
  for select using (bucket_id = 'traces');

-- No insert/update/delete policies for the traces bucket. Uploads and deletes
-- happen only through the Edge Functions.
