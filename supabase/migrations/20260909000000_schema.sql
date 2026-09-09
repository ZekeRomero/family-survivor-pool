-- See README. All access goes through the "survivor" edge function (service role); RLS has no policies on purpose.
create table if not exists public.survivor_settings (
  id int primary key default 1 check (id = 1),
  name text not null default 'Family Survivor Pool',
  season int not null default 2026,
  commissioner text not null default '',
  contact text not null default '',
  buy_in numeric not null default 0,
  rules jsonb not null default '{"tie":"loss","missed_pick":"loss","all_out_reset":true,"strikes":1}'::jsonb,
  admin_pin_hash text,
  updated_at timestamptz not null default now()
);
create table if not exists public.survivor_players (
  id serial primary key, name text not null unique, pin_hash text,
  paid boolean not null default false, created_at timestamptz not null default now()
);
create table if not exists public.survivor_picks (
  player_id int not null references public.survivor_players(id) on delete cascade,
  week int not null check (week between 1 and 18), team text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (player_id, week)
);
create table if not exists public.survivor_games (
  week int not null check (week between 1 and 18), away text not null, home text not null,
  kickoff timestamptz not null, away_score int not null default 0, home_score int not null default 0,
  status text not null default 'scheduled' check (status in ('scheduled','live','final')),
  detail text not null default '', updated_at timestamptz not null default now(),
  primary key (week, away, home)
);
create table if not exists public.survivor_log (id bigserial primary key, at timestamptz not null default now(), who text, action text not null, detail jsonb);
alter table public.survivor_settings enable row level security;
alter table public.survivor_players enable row level security;
alter table public.survivor_picks enable row level security;
alter table public.survivor_games enable row level security;
alter table public.survivor_log enable row level security;
insert into public.survivor_settings (id) values (1) on conflict do nothing;
