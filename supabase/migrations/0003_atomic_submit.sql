-- ─── ATOMIC SUBMIT + DAILY COUNTER ───────────────────────────────────────────
-- Two problems the client-side upsert in submit-lap couldn't solve, both fixed
-- by moving the decision into Postgres:
--
--   1. CHECK-THEN-WRITE RACE. The function used to SELECT the existing lap, test
--      it in JS, then upsert. Two concurrent publishes from one driver could both
--      pass the test and both write; the row would end up one lap and the opaque
--      trace blob another. submit_entry makes the test and the write ONE
--      statement, so exactly one of them lands and the loser never reaches
--      storage.
--
--   2. RACY RATE COUNTER. `upload_count` was read-modify-written in JS, and the
--      daily cap was a COUNT over entries — which under-counts a driver who keeps
--      improving, because an improvement REPLACES the row rather than adding one.
--      record_publish increments both counters in a single statement and resets
--      the daily one on a calendar-day rollover.
--
-- Both functions are SECURITY DEFINER (they must bypass the deny-all write RLS),
-- so they are revoked from every client role and granted only to service_role —
-- the role the Edge Function connects with. Without the REVOKE, PostgREST would
-- expose them at /rest/v1/rpc and a client could write an entry directly.

-- ─── drivers: daily counter ──────────────────────────────────────────────────
-- Lifetime `upload_count` already exists. These add today's count plus the day
-- it belongs to, so a row is self-describing: a date that isn't today means the
-- count has effectively reset.
alter table public.drivers
  add column if not exists daily_upload_count integer not null default 0;
alter table public.drivers
  add column if not exists daily_upload_date date;

-- ─── submit_entry ────────────────────────────────────────────────────────────
-- Inserts the entry, or updates it only when the new lap is STRICTLY faster.
-- `FOUND` after the statement is true when a row was inserted or updated — i.e.
-- when this lap now stands as the driver's entry on that board — and false when
-- the WHERE on the conflict branch suppressed the update. Returns that flag plus
-- the time that currently stands, so the caller can answer "already faster"
-- without a second read.
create or replace function public.submit_entry(
  p_board_id       text,
  p_driver_id      uuid,
  p_display_name   text,
  p_team           text,
  p_track_slug     text,
  p_session_group  text,
  p_compound       text,
  p_condition      text,
  p_lap_time_ms    integer,
  p_s1_ms          integer,
  p_s2_ms          integer,
  p_s3_ms          integer,
  p_tyre_visual    smallint,
  p_tyre_age       smallint,
  p_weather        smallint,
  p_track_temp     smallint,
  p_air_temp       smallint,
  p_sample_count   integer,
  p_lap_length_m   integer,
  p_trace_path     text,
  p_trace_bytes    integer,
  p_app_version    text,
  p_verdict        text,
  p_checks         jsonb
)
returns table (improved boolean, best_lap_time_ms integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.entries as e (
    board_id, driver_id, display_name, team, track_slug, session_group,
    compound, condition, lap_time_ms, s1_ms, s2_ms, s3_ms,
    tyre_visual, tyre_age, weather, track_temp, air_temp,
    sample_count, lap_length_m, trace_path, trace_bytes,
    app_version, verdict, checks, created_at, updated_at
  ) values (
    p_board_id, p_driver_id, p_display_name, p_team, p_track_slug, p_session_group,
    p_compound, p_condition, p_lap_time_ms, p_s1_ms, p_s2_ms, p_s3_ms,
    p_tyre_visual, p_tyre_age, p_weather, p_track_temp, p_air_temp,
    p_sample_count, p_lap_length_m, p_trace_path, p_trace_bytes,
    p_app_version, p_verdict, p_checks, now(), now()
  )
  on conflict (board_id, driver_id) do update set
    display_name  = excluded.display_name,
    team          = excluded.team,
    track_slug    = excluded.track_slug,
    session_group = excluded.session_group,
    compound      = excluded.compound,
    condition     = excluded.condition,
    lap_time_ms   = excluded.lap_time_ms,
    s1_ms         = excluded.s1_ms,
    s2_ms         = excluded.s2_ms,
    s3_ms         = excluded.s3_ms,
    tyre_visual   = excluded.tyre_visual,
    tyre_age      = excluded.tyre_age,
    weather       = excluded.weather,
    track_temp    = excluded.track_temp,
    air_temp      = excluded.air_temp,
    sample_count  = excluded.sample_count,
    lap_length_m  = excluded.lap_length_m,
    trace_path    = excluded.trace_path,
    trace_bytes   = excluded.trace_bytes,
    app_version   = excluded.app_version,
    verdict       = excluded.verdict,
    checks        = excluded.checks,
    updated_at    = now()
  -- STRICTLY faster: a tie keeps the lap already on the board, so re-submitting
  -- an identical time is a no-op rather than a rewrite of the stored trace.
  where e.lap_time_ms > excluded.lap_time_ms;

  if found then
    return query select true, p_lap_time_ms;
  else
    -- A conflict suppressed the write, so a row exists; read back what stands.
    return query select false, (
      select e2.lap_time_ms
        from public.entries e2
       where e2.board_id = p_board_id and e2.driver_id = p_driver_id
    );
  end if;
end;
$$;

-- ─── record_publish ──────────────────────────────────────────────────────────
-- Called once per SUCCESSFUL publish. Upserts the driver row (name/team and the
-- lifetime counter) and rolls the daily counter over on a date change, all in one
-- statement so two concurrent publishes can't lose an increment the way the old
-- JS read-modify-write could.
create or replace function public.record_publish(
  p_id           uuid,
  p_display_name text,
  p_team         text
)
returns table (upload_count integer, daily_upload_count integer, daily_upload_date date)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  insert into public.drivers as d (
    id, display_name, team, upload_count, daily_upload_count, daily_upload_date, last_upload_at
  ) values (
    p_id, p_display_name, p_team, 1, 1, current_date, now()
  )
  on conflict (id) do update set
    display_name       = excluded.display_name,
    team               = excluded.team,
    upload_count       = d.upload_count + 1,
    daily_upload_count = case
                           when d.daily_upload_date is distinct from current_date then 1
                           else d.daily_upload_count + 1
                         end,
    daily_upload_date  = current_date,
    last_upload_at     = now()
  returning d.upload_count, d.daily_upload_count, d.daily_upload_date;
end;
$$;

-- ─── Lock the functions down ─────────────────────────────────────────────────
-- Default grant is EXECUTE to PUBLIC, which PostgREST turns into a callable
-- endpoint for anon/authenticated. That would hand clients exactly the write
-- path RLS exists to deny, so revoke it everywhere and grant only the role the
-- Edge Function uses.
revoke all on function public.submit_entry(
  text, uuid, text, text, text, text, text, text, integer, integer, integer,
  integer, smallint, smallint, smallint, smallint, smallint, integer, integer,
  text, integer, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.submit_entry(
  text, uuid, text, text, text, text, text, text, integer, integer, integer,
  integer, smallint, smallint, smallint, smallint, smallint, integer, integer,
  text, integer, text, text, jsonb
) to service_role;

revoke all on function public.record_publish(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.record_publish(uuid, text, text)
  to service_role;
