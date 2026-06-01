-- Sweepsnake — Supabase schema
-- Paste this whole file into the Supabase SQL editor (Dashboard -> SQL Editor -> New query) and Run.
-- Safe to re-run: it uses IF NOT EXISTS and drops/recreates policies.
--
-- SECURITY NOTE: this app has no login (per the brief). The policies below grant
-- the public `anon` key full read/write on these tables. That is acceptable for a
-- private friends' sweepstake reached by a shared link, but anyone with the link
-- can write. The football-data.org key and Supabase service_role key are NOT used
-- here — they stay server-side in GitHub Actions.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Key/value configuration (n_players, n_teams, n_rounds, stake, draft_status, ...)
create table if not exists config (
  key   text primary key,
  value jsonb
);

-- Participants
create table if not exists players (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  colour     text,                 -- hex, assigned from the player palette
  slot       integer,              -- draft seat 1..n_players
  created_at timestamptz default now()
);

-- Teams: all 48 are seeded; `tier` and `player_id` are filled by the draft.
create table if not exists teams (
  id           text primary key,   -- football-data.org team id
  name         text not null,
  tla          text,
  flag         text,               -- emoji
  crest        text,               -- crest image url
  fifa_ranking integer,            -- seeding hint shown during the draft
  in_play      boolean default true,        -- included in the sweepstake?
  tier         integer,            -- draft ROUND the team was picked in (null until drafted)
  player_id    uuid references players(id) on delete set null  -- owner (null until drafted)
);

-- Draft log. Because players pick for themselves, the picker is the owner.
create table if not exists draft_picks (
  id           bigint generated always as identity primary key,
  round        integer,            -- = tier
  pick_in_round integer,
  overall_pick integer,
  player_id    uuid references players(id) on delete cascade,  -- who picked / owns it
  team_id      text references teams(id) on delete cascade,
  picked_at    timestamptz default now()
);

-- Match results. Stored in the engine's canonical shape so the browser can score
-- directly via js/engine.js (the single source of truth for points). The GitHub
-- Action sync upserts rows here; the admin panel can override them.
create table if not exists matches (
  id            text primary key,  -- football-data.org match id
  home_team_id  text references teams(id),
  away_team_id  text references teams(id),
  home_score    integer,           -- in-play score (90 or 120 min); never shootout
  away_score    integer,
  match_type    text check (match_type in ('REGULAR','EXTRA_TIME','PENALTIES')),
  winner        text check (winner in ('HOME','AWAY','DRAW')),
  pen_home      integer,           -- shootout score (PENALTIES only)
  pen_away      integer,
  stage         text,              -- GROUP_STAGE, LAST_32, LAST_16, QUARTER_FINALS, SEMI_FINALS, THIRD_PLACE, FINAL
  status        text,              -- SCHEDULED / TIMED / IN_PLAY / FINISHED ...
  matchday      integer,
  utc_date      timestamptz,
  is_overridden boolean default false,
  last_synced   timestamptz default now()
);

-- ---------------------------------------------------------------------------
-- Row-Level Security: open to the anon key (see security note above)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['config','players','teams','draft_picks','matches'] loop
    execute format('alter table %I enable row level security;', t);
    execute format('drop policy if exists anon_all on %I;', t);
    execute format(
      'create policy anon_all on %I for all to anon, authenticated using (true) with check (true);', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Seed default configuration (only if not already set)
-- ---------------------------------------------------------------------------
insert into config (key, value) values
  ('n_players',    '6'::jsonb),
  ('n_teams',      '48'::jsonb),
  ('n_rounds',     '8'::jsonb),
  ('stake',        '50'::jsonb),
  ('draft_status', '"setup"'::jsonb),   -- setup | open | paused | closed
  ('pick_rule',    '"self"'::jsonb)     -- self | others
on conflict (key) do nothing;
