-- Say out loud who may not touch the ledger.
--
-- Today nothing is exposed: RLS is on with no policies, so anon and
-- authenticated read nothing back from scan_events, and the two reporting
-- functions are not SECURITY DEFINER, so calling them through the anon key
-- returns empty. That is safe by accident rather than on purpose -- a future
-- policy added for some other reason would silently open both.
--
-- The API reaches the ledger with the service key, which is unaffected by all
-- of this.

revoke all on table public.scan_events from anon, authenticated;

revoke execute on function
  public.scan_series(text, timestamptz, timestamptz, text),
  public.scan_totals(text)
from anon, authenticated;

-- New tables and functions in `public` are granted to anon and authenticated by
-- default, so state the intent for anything added later too.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
