-- Native loyalty members and Apple Wallet passes (the PassKit replacement).
--
-- members: one row per customer who joined through our own signup page (or,
-- later, was imported from PassKit). Points live here for these members.
-- pass_registrations: which devices hold which pass, for Wallet's update
-- notifications (Apple's pass web service, see lib/apns.js).
--
-- Service role only: RLS on, no policies, anon revoked.

create extension if not exists pgcrypto;

create table if not exists public.members (
  id                uuid primary key default gen_random_uuid(),
  full_name         text not null,
  email             text,
  email_norm        text generated always as (lower(btrim(email))) stored,
  phone             text,                      -- E.164 as the API normalised it
  points            integer not null default 0 check (points >= 0),
  status            text not null default 'active' check (status in ('active', 'disabled')),
  source            text not null default 'join' check (source in ('join', 'passkit-import', 'staff')),
  passkit_member_id text unique,               -- set when imported from PassKit
  pass_serial       text not null unique,      -- Apple pass serialNumber
  pass_auth_token   text not null,             -- Apple authenticationToken (web service)
  download_token    text not null,             -- gates the .pkpass link on the signup page
  pass_updated_at   timestamptz not null default now(),
  consent_marketing boolean not null default false,
  last_visit_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists members_email_norm_idx on public.members (email_norm) where email_norm is not null;
create index if not exists members_phone_idx on public.members (phone) where phone is not null;
create index if not exists members_pass_updated_idx on public.members (pass_updated_at desc);

create table if not exists public.pass_registrations (
  device_library_id text not null,
  pass_serial       text not null references public.members (pass_serial) on delete cascade,
  push_token        text not null,
  created_at        timestamptz not null default now(),
  primary key (device_library_id, pass_serial)
);
create index if not exists pass_registrations_serial_idx on public.pass_registrations (pass_serial);

alter table public.members enable row level security;
alter table public.pass_registrations enable row level security;
revoke all on public.members from anon, authenticated;
revoke all on public.pass_registrations from anon, authenticated;

-- Atomic balance change. Raises 'insufficient_points' rather than going below zero.
create or replace function public.adjust_member_points(p_member uuid, p_delta integer)
returns table (points integer)
language plpgsql as $$
declare v_points integer;
begin
  update public.members m
     set points = m.points + p_delta,
         updated_at = now(),
         pass_updated_at = now(),
         last_visit_at = case when p_delta > 0 then now() else m.last_visit_at end
   where m.id = p_member and m.status = 'active' and m.points + p_delta >= 0
   returning m.points into v_points;
  if v_points is null then
    if exists (select 1 from public.members where id = p_member and status = 'active') then
      raise exception 'insufficient_points' using errcode = 'P0001';
    end if;
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  return query select v_points;
end
$$;
revoke all on function public.adjust_member_points(uuid, integer) from public, anon, authenticated;

-- Serials on a device whose pass changed after p_since (Wallet's "what's new" call).
create or replace function public.pass_updated_serials(p_device text, p_since timestamptz)
returns table (serial text, updated_at timestamptz)
language sql stable as $$
  select m.pass_serial, m.pass_updated_at
    from public.pass_registrations r
    join public.members m on m.pass_serial = r.pass_serial
   where r.device_library_id = p_device
     and (p_since is null or m.pass_updated_at > p_since)
   order by m.pass_updated_at
$$;
revoke all on function public.pass_updated_serials(text, timestamptz) from public, anon, authenticated;
