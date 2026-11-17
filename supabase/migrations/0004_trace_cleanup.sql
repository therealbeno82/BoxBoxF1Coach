-- ─── TRACE CLEANUP + BOARDS VIEW SECURITY ────────────────────────────────────
-- Two fixes to what 0001-0003 left behind.
--
--   1. ORPHANED TRACES. Since 0003 every upload is stored under a UNIQUE key
--      (`<board_id>/<driver_id>/<uuid>.json.gz`) so two concurrent publishes
--      can't interleave one lap's row with the other's blob. But submit_entry
--      never said which object an improvement REPLACED, so the function had no
--      way to delete it: every improved lap left the previous trace in the
--      bucket, publicly readable and listable, forever. On the free tier that is
--      also the storage quota being spent on laps no row points at.
--
--      submit_entry now returns `replaced_trace_path` — the object the winning
--      write displaced — and submit-lap deletes it. The existing row is read
--      FOR UPDATE first, which serialises two concurrent publishes from the same
--      driver to the same board, so the path each one reports is the one it
--      really replaced. (Two FIRST publishes racing with no row yet can still
--      orphan one blob; delete-entry sweeps the driver's whole folder, which
--      covers that and anything left from before this migration.)
--
--   2. `boards` VIEW RIGHTS. A view runs with its OWNER's rights unless created
--      `security_invoker`, so the comment in 0001 claiming it "inherits the
--      table's RLS" was not true. Nothing leaks today — entries is public-read —
--      but the view should obey RLS by construction rather than by coincidence,
--      and Supabase's security advisor flags it otherwise.
--
-- The return type changes, which CREATE OR REPLACE cannot do, so the function is
-- dropped and recreated — and its grants with it.

drop function if exists public.submit_entry(
  text, uuid, text, text, text, text, text, text, integer, integer, integer,
  integer, smallint, smallint, smallint, smallint, smallint, integer, integer,
  text, integer, text, text, jsonb
);

create function public.submit_entry(
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
returns table (improved boolean, best_lap_time_ms integer, replaced_trace_path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_path text;
begin
  -- Lock the driver's existing entry on this board (if any) and remember which
  -- trace it points at, so an improvement can report what it displaced.
  select e0.trace_path into v_old_path
    from public.entries e0
   where e0.board_id = p_board_id and e0.driver_id = p_driver_id
     for update;

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
    return query select true, p_lap_time_ms,
      (case when v_old_path is distinct from p_trace_path then v_old_path end);
  else
    -- A conflict suppressed the write, so a row exists; read back what stands.
    return query select false, (
      select e2.lap_time_ms
        from public.entries e2
       where e2.board_id = p_board_id and e2.driver_id = p_driver_id
    ), null::text;
  end if;
end;
$$;

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

-- ─── boards: obey RLS ────────────────────────────────────────────────────────
alter view public.boards set (security_invoker = on);
