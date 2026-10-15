-- Google Wallet: one loyalty object per member who asked for the Android card.
-- Null until their save link is first generated; after that every balance
-- change is also written to Google.
alter table public.members add column if not exists gwallet_object_id text unique;
alter table public.members add column if not exists gwallet_updated_at timestamptz;
