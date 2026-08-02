-- ─── F1 COACH LEADERBOARDS ───────────────────────────────────────────────────
-- Published reference laps, one board per circuit + session type.
--
-- The shape of this schema follows two decisions worth restating here, because
-- they're the reason it looks the way it does:
--
--   1. NO CLIENT EVER WRITES. There is no insert/update policy on entries. The
--      only write path is the submit-lap Edge Function, which uses the service
--      role key and therefore bypasses RLS. Every anti-tamper check lives there;
--      a policy can't open a trace blob and check it against its own lap time.
--
--   2. ONE ENTRY PER DRIVER PER BOARD, enforced structurally by the primary key
--      rather than by a query somebody might forget. An upload is a single
--      upsert that only lands when it beats what's already there. Boards stay
--      readable (nobody occupies the top ten), storage is bounded by drivers x
--      boards entered rather than by upload count, and there's no orphan sweep
--      to write.
--
-- Compound is stored but is NOT part of the board key. A board is "the fastest
-- lap set here in this session type"; qualifying and time trial are both
-- low-fuel push running, and every extra axis divides a thin population further.
-- The client shows the compound on each row and warns when it wouldn't match
-- what the driver is running, since the coach still blocks on that.

-- ─── drivers ─────────────────────────────────────────────────────────────────
-- One row per authenticated (anonymous) user. Holds the display name shown on
-- boards plus the rate-limit counters the Edge Function reads.
create table if not exists public.drivers (
  id             uuid primary key references auth.users(id) on delete cascade,
  display_name   text not null,
  team           text,
  upload_count   integer not null default 0,
  last_upload_at timestamptz,
  banned         boolean not null default false,
  created_at     timestamptz not null default now()
);

-- ─── entries ─────────────────────────────────────────────────────────────────
create table if not exists public.entries (
  board_id      text not null,
  driver_id     uuid not null references auth.users(id) on delete cascade,

  -- Snapshotted at upload. A later rename doesn't retro-update old rows; the
  -- alternative is joining drivers on every board read to save a rename that
  -- almost never happens.
  display_name  text not null,
  team          text,

  -- Board axes, denormalised so a board can be filtered without parsing its id.
  track_slug    text not null,
  session_group text not null check (session_group in ('qualifying', 'time-trial')),

  -- Shown and filtered on, never part of the key. Null when the lap predates
  -- compound tagging.
  compound      text check (compound in ('soft','medium','hard','superhard','inter','wet')),
  condition     text check (condition in ('dry','wet')),

  -- Integer milliseconds, not float seconds: ranking a board is an exact sort,
  -- and two laps that tie should tie rather than depending on float rounding.
  lap_time_ms   integer not null check (lap_time_ms > 0),
  s1_ms         integer,
  s2_ms         integer,
  s3_ms         integer,

  tyre_visual   smallint,
  tyre_age      smallint,
  weather       smallint,
  track_temp    smallint,
  air_temp      smallint,

  sample_count  integer not null,
  lap_length_m  integer not null,

  trace_path    text not null,     -- object key in the `traces` storage bucket
  trace_bytes   integer not null,
  app_version   text,

  -- Not binary. A lap that passed every hard check but tripped a borderline one
  -- still ranks — this is a leaderboard for fun, not FIA scrutineering — it just
  -- renders with a marker naming the check. `checks` keeps the raw numbers so a
  -- threshold can be re-examined later against rows already submitted.
  verdict       text not null default 'ok' check (verdict in ('ok', 'flagged')),
  checks        jsonb,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  primary key (board_id, driver_id)
);

-- The one index a board page needs: WHERE board_id = ? ORDER BY lap_time_ms.
-- Also serves the rank query (COUNT WHERE lap_time_ms < ?) off the same scan.
create index if not exists entries_board_time on public.entries (board_id, lap_time_ms);

-- "My entries" in Settings.
create index if not exists entries_driver on public.entries (driver_id, updated_at desc);

-- ─── boards ──────────────────────────────────────────────────────────────────
-- Summary for the board picker. A plain view is correct and always consistent;
-- at this scale the group-by is cheap. If it ever gets slow, make it a
-- materialised view refreshed on write — don't denormalise counters onto a table
-- that the Edge Function then has to keep in step.
create or replace view public.boards as
  select
    board_id,
    track_slug,
    session_group,
    count(*)::integer          as entry_count,
    min(lap_time_ms)::integer  as best_time_ms,
    max(updated_at)            as updated_at
  from public.entries
  group by board_id, track_slug, session_group;

-- ─── config ──────────────────────────────────────────────────────────────────
-- Server-tunable overrides for the validator's thresholds, so a bad one can be
-- corrected without redeploying the function. The committed constants in
-- src/lib/leaderboard/limits.js remain the working default: an empty or missing
-- row here must never DISABLE a check, only adjust it.
create table if not exists public.config (
  key   text primary key,
  value jsonb not null
);

insert into public.config (key, value)
values ('leaderboard', '{"paused": false}'::jsonb)
on conflict (key) do nothing;

-- ─── Row Level Security ──────────────────────────────────────────────────────
-- Reads are public; the boards are meant to be read by anyone, including before
-- a user has signed in at all.
--
-- There is deliberately NO insert or update policy anywhere. The Edge Function
-- holds the service role key, which bypasses RLS entirely, so "deny all client
-- writes" needs no conditional policy — and there is no way to forget one.

alter table public.entries enable row level security;
alter table public.drivers enable row level security;
alter table public.config  enable row level security;

drop policy if exists entries_public_read on public.entries;
create policy entries_public_read on public.entries
  for select using (true);

-- A user may delete their own entry. The client doesn't use this — deletes go
-- through an Edge Function so the storage object goes with the row — but it
-- means a stuck row is always recoverable by its owner.
drop policy if exists entries_owner_delete on public.entries;
create policy entries_owner_delete on public.entries
  for delete using (auth.uid() = driver_id);

-- Drivers are private. Public reads would expose the id-to-name map and every
-- user's upload counts for no benefit: entries already carry the display name.
drop policy if exists drivers_self_read on public.drivers;
create policy drivers_self_read on public.drivers
  for select using (auth.uid() = id);

-- No self-update policy: upload_count and banned live on this row, and a
-- client-writable rate-limit counter is not a rate limit. Display-name changes
-- go through the Edge Function.

-- config is function-only: no policies at all, so RLS denies every client read.

-- The `boards` view inherits the underlying table's RLS, so it is readable by
-- anyone exactly as entries is.
grant select on public.boards to anon, authenticated;
