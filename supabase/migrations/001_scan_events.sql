-- La Bottega Milanese loyalty: our own scan ledger.
-- One row per scanner action. Balances still live in PassKit for now; this
-- table is the source of truth for "how many scans", and the foundation for
-- moving members and balances off PassKit later.

create table if not exists public.scan_events (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),
  action       text not null check (action in ('lookup', 'add', 'remove', 'redeem')),
  points       integer not null default 0,
  member_id    text,
  source       text not null default 'scanner',   -- 'scanner' | 'passkit-backfill'
  external_id  text unique,                         -- PassKit event id for backfilled rows
  created_at   timestamptz not null default now()
);

create index if not exists scan_events_occurred_at_idx on public.scan_events (occurred_at desc);
create index if not exists scan_events_action_idx on public.scan_events (action, occurred_at desc);
create index if not exists scan_events_member_idx on public.scan_events (member_id, occurred_at desc);

-- Service role only. No policies on purpose: the anon key can do nothing here.
alter table public.scan_events enable row level security;

-- "A scan" is one customer scan. Live rows record the lookup itself; the
-- PassKit backfill has no lookups, so there each stamp or redemption counts as one.
create or replace function public.scan_is_scan(p_action text, p_source text)
returns boolean language sql immutable as $$
  select p_action = 'lookup' or (p_source = 'passkit-backfill' and p_action in ('add', 'redeem'))
$$;

create or replace function public.scan_series(bucket text, from_ts timestamptz, to_ts timestamptz, tz text default 'Europe/London')
returns table (bucket_start timestamptz, scans bigint, adds bigint, redeems bigint, points_added bigint)
language plpgsql stable as $$
begin
  if bucket not in ('hour', 'day', 'week', 'month') then
    raise exception 'bucket must be hour, day, week or month';
  end if;
  return query
    select
      (date_trunc(bucket, e.occurred_at at time zone tz) at time zone tz) as bucket_start,
      count(*) filter (where public.scan_is_scan(e.action, e.source)) as scans,
      count(*) filter (where e.action = 'add') as adds,
      count(*) filter (where e.action = 'redeem') as redeems,
      coalesce(sum(e.points) filter (where e.action = 'add'), 0)::bigint as points_added
    from public.scan_events e
    where e.occurred_at >= from_ts and e.occurred_at < to_ts
    group by 1
    order by 1;
end
$$;

create or replace function public.scan_totals(tz text default 'Europe/London')
returns table (today bigint, total bigint, first_at timestamptz, live_since timestamptz)
language sql stable as $$
  select
    count(*) filter (where public.scan_is_scan(action, source)
                       and occurred_at >= (date_trunc('day', now() at time zone tz) at time zone tz)) as today,
    count(*) filter (where public.scan_is_scan(action, source)) as total,
    min(occurred_at) as first_at,
    min(occurred_at) filter (where source = 'scanner') as live_since
  from public.scan_events
$$;
