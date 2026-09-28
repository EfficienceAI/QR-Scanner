-- Backfilled rows do not always know how many points an event moved: the
-- Make.com-era notes are free text written by a system that is gone. null
-- means "we could not tell", which is the truth and stays visible in a
-- query; 0 was a silent lie that averaged away thousands of real stamps.
alter table public.scan_events alter column points drop not null;
