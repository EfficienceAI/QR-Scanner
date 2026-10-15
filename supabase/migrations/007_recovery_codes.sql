-- Pass recovery: a short-lived emailed code proves the person owns the
-- email on a card before the card's link is handed out again.
alter table public.members add column if not exists recovery_code_hash text;
alter table public.members add column if not exists recovery_expires_at timestamptz;
alter table public.members add column if not exists recovery_attempts integer not null default 0;
alter table public.members add column if not exists recovery_sent_at timestamptz;
