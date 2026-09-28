-- Two fixes to the reporting functions.
--
-- 1. points_added was the gross sum of 'add' rows, but the name reads like a
--    net figure: removals and redemptions were not subtracted, so a day of
--    corrections looked like a day of trade. Renamed to points_stamped, which
--    is what it has always measured, and points_burned is returned alongside it
--    so a caller that wants the net can work it out.
--
-- 2. scan_is_scan(action, source) was called inside the aggregate filters. The
--    planner cannot use an index through it, so every call read the whole
--    table -- fine at a few thousand rows, not at a few hundred thousand. The
--    predicate is now written out where it is used, and a partial index matches
--    it exactly. The helper is dropped rather than left to drift out of step
--    with the three copies below.
--
-- Note on null points: an unknown amount (see 002) is ignored by sum(), so it
-- does not count as zero. The row still counts as a stamp in `adds`.

drop function if exists public.scan_series(text, timestamptz, timestamptz, text);
drop function if exists public.scan_totals(text);
drop function if exists public.scan_is_scan(text, text);

create index if not exists scan_events_scan_idx
  on public.scan_events (occurred_at desc)
  where action = 'lookup' or (source = 'passkit-backfill' and action in ('add', 'redeem'));

-- "A scan" is one customer scan. Live rows record the lookup itself; the
-- PassKit backfill has no lookups, so there each stamp or redemption counts as
-- one. Keep this predicate identical in all three places below and in the index.
create or replace function public.scan_series(bucket text, from_ts timestamptz, to_ts timestamptz, tz text default 'Europe/London')
returns table (bucket_start timestamptz, scans bigint, adds bigint, redeems bigint, points_stamped bigint, points_burned bigint)
language plpgsql stable as $$
begin
  if bucket not in ('hour', 'day', 'week', 'month') then
    raise exception 'bucket must be hour, day, week or month';
  end if;
  return query
    select
      (date_trunc(bucket, e.occurred_at at time zone tz) at time zone tz) as bucket_start,
      count(*) filter (
        where e.action = 'lookup'
           or (e.source = 'passkit-backfill' and e.action in ('add', 'redeem'))
      ) as scans,
      count(*) filter (where e.action = 'add') as adds,
      count(*) filter (where e.action = 'redeem') as redeems,
      coalesce(sum(e.points) filter (where e.action = 'add'), 0)::bigint as points_stamped,
      coalesce(sum(e.points) filter (where e.action in ('remove', 'redeem')), 0)::bigint as points_burned
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
    count(*) filter (
      where (action = 'lookup' or (source = 'passkit-backfill' and action in ('add', 'redeem')))
        and occurred_at >= (date_trunc('day', now() at time zone tz) at time zone tz)
    ) as today,
    count(*) filter (
      where action = 'lookup' or (source = 'passkit-backfill' and action in ('add', 'redeem'))
    ) as total,
    min(occurred_at) as first_at,
    min(occurred_at) filter (where source = 'scanner') as live_since
  from public.scan_events
$$;
