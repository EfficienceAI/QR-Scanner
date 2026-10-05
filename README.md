# Loyalty Scanner (La Bottega Milanese)

Staff-facing QR scanner for the La Bottega Milanese loyalty programme.
Customers hold a PassKit membership pass in Apple/Google Wallet; staff scan
the pass, add drink points, or redeem a free drink.

## How it works

```
Scanner page (public/index.html)
        |  POST /api/loyalty  { action, qr_data, points | points_to_remove }
        v
api/loyalty.js  (Vercel serverless function)
        |  lib/passkit.js  (HS256 JWT auth, retries)
        v
PassKit Members API  (api.pub1.passkit.io)
```

Until this branch, the page posted the same payloads to a Make.com webhook
and Make talked to PassKit. The function replaces Make one-for-one. The page
has since grown the scan counter and the chart, so it is no longer the old
page with a new URL.

The QR decoder is vendored at `public/vendor/jsQR-1.4.0.min.js` rather than
loaded from a CDN: a page that moves customer balances should not execute a
script a third party can change, and jsDelivr minifies on demand, which rules
out an integrity hash.

### API contract

| action            | request fields                      | 200 response                                  |
| ----------------- | ----------------------------------- | --------------------------------------------- |
| `lookup_customer` | `qr_data`                           | `{ ok, points, member, history, settings }` (see below) |
| `add_points`      | `qr_data`, `points` (1–99)          | `{ ok, added, points }`                        |
| `remove_points`   | `qr_data`, `points` (1–99)          | `{ ok, removed, points }` (staff correction; 409 if the balance is lower) |
| `redeem_points`   | `qr_data`, `points_to_remove`       | `{ ok, redeemed, points }`                     |

`member` carries `id`, `name`, `tier`, `tierName`, `status`, `points`,
`joined` (enrolment date) and `photo` (URL, only if the programme collects
one). `history` comes from PassKit's member event log:

| field          | meaning                                                              |
| -------------- | -------------------------------------------------------------------- |
| `recorded`     | false if the event log could not be read (the scan still works)      |
| `visits`       | number of points-earned events. Not shown on the page: staff do not scan every visit, so it undercounts |
| `lastVisit`    | date of the most recent earn, or null                                |
| `firstVisitOn` | date of the earliest earn, or null                                   |
| `redemptions`  | number of points-burned events                                       |
| `lastRedeem`   | date of the most recent burn, or null                                |
| `firstVisit`   | true only when there are no earn events **and** the balance is 0     |

A member with points but no events joined before the event log has data;
the page shows "No record" rather than calling them new.

The event list uses the programme-level `POST /members/program/list/events/{programId}`
with a `member.id` filter (undocumented field name, verified in production)
and 1000-per-page paging. The per-member route `POST /members/member/list/events/{id}`
is only a fallback: it has no paging and returns PassKit's default first
page of 25 events, oldest first. Both stream one JSON line per event.

`points` is always the balance **after** the action. Errors return
`{ ok: false, error, message }` with codes `member_not_found` (404),
`insufficient_points` (409), `invalid_points` (400), `passkit_auth` (502),
`not_configured` (500).

The redemption cost is decided server-side (`LOYALTY_REDEEM_COST`, default 9);
the client's `points_to_remove` is logged but not trusted. `lookup_customer`
returns `settings: { redeemCost, maxPointsPerScan }` purely so the page can
label its own buttons; nothing about enforcement lives in the client.

Every action may carry a `request_id`. It is used as an idempotency key for
our ledger, so a staff retry after a lost response records the visit once
instead of twice. The same id must be reused for a retry of the same action
and a new one generated for a new action, which is what the page does.

Every earn/burn is written to PassKit's member event log with
`externalServiceId = loyalty-scanner`, so the audit trail Make used to give
you now lives in PassKit. Each request also logs one JSON line to the Vercel
function logs.

## Scan counter and chart (our own ledger)

Every scanner action is written to **our own Supabase table** `scan_events`
(see `supabase/migrations/001_scan_events.sql`): the lookup when a customer
is scanned, each stamp, each redemption. This is independent of PassKit on
purpose, so the numbers survive the PassKit phase-out and the table can grow
into the balance store for non-legacy customers later.

- `GET /api/stats?range=today|week|month|year|custom&from=YYYY-MM-DD&to=YYYY-MM-DD`
  returns `today`, `total`, a zero-filled `series` (hourly for today, daily
  for week/month/short custom ranges, monthly for year/long ranges) and a
  `summary`. Buckets follow the shop's clock (`SHOP_TIMEZONE`, default
  Europe/London, DST-aware). Cached 20 s (today) / 2 min in the function, as a
  50-entry LRU. Each bucket carries `scans`, `adds`, `redeems`, `points`
  (gross stamps) and `pointsBurned`.
- A custom range longer than 120 days is widened to whole months, so asking
  for 15 Jan to 20 Aug measures 1 Jan to 31 Aug. The chart footer states the
  window actually measured. A date that does not exist (`2026-02-31`) is a
  400, not a chart of zeros.
- The page shows Today / All time top right and a line chart at the bottom
  with Today, Week, Month, Year and Custom views, a crosshair tooltip and a
  table view.
- A "scan" is one customer scan (the lookup). For the one-off PassKit
  backfill, where no lookups exist, each stamp or redemption counts as one.
  Scanning the same customer twice is two scans: the counter measures scans,
  not distinct customers, and the top-right figure is a live increment that
  re-syncs with the server every ten minutes and whenever the tab is
  refocused.

### Backfilling the Make.com era

`POST /api/admin/backfill` with header `x-admin-secret` (env `ADMIN_SECRET`)
copies PassKit's programme event log into the ledger, only for events
**before** the ledger's first live row, keyed on the PassKit event id so it
can be re-run safely.

Query parameters: `offset` (default 0), `pages` (default 3, max 10, at 1000
events each), `dryRun=1`.

**Run the dry run first.** The amount of each historical stamp is read out of
free text that Make.com wrote, and nobody here has seen that format:

```bash
curl -sS -X POST -H "x-admin-secret: $ADMIN_SECRET"   "https://<deployment>/api/admin/backfill?dryRun=1&pages=1" | jq
```

Nothing is written. Check `samples`: each entry shows an event's `notes` and
the amount we read from it (`read`). If `read` is `null` where the note
clearly states an amount, fix `pointsFromEvent` in
`api/admin/backfill.js` before importing — an unreadable amount is stored as
`null`, which is honest but leaves `points_stamped` short.

Then run for real, following `nextOffset` until `done: true`:

```bash
curl -sS -X POST -H "x-admin-secret: $ADMIN_SECRET"   "https://<deployment>/api/admin/backfill?offset=0&pages=10" | jq
```

Ten pages is 10,000 events per invocation against a 60 s `maxDuration`
(`vercel.json`); drop `pages` if a run times out.

What to expect in the response:

| field                | what it means                                                            |
| -------------------- | ------------------------------------------------------------------------ |
| `seen`               | events read from PassKit this invocation                                  |
| `sent`               | rows offered to the ledger                                               |
| `imported`           | rows the ledger actually **stored**. Duplicates are ignored, so a second run over the same events reports `sent: 1000, imported: 0` — that is success, not failure |
| `skippedAfterCutoff` | events at or after the ledger's first live row: already counted           |
| `skippedOther`       | not a stamp or a redemption (enrolments, tier changes), or undated        |
| `unknownPoints`      | rows stored with `points: null` because the amount could not be read      |
| `repeated`, `order`  | paging health, see below                                                 |
| `nextOffset`, `done` | where to resume; `done: true` means the last page was short              |

Afterwards, `select count(*), source from scan_events group by source;`
should show one `passkit-backfill` row per importable historical event, and
`select count(*) from scan_events where points is null;` should match the
total `unknownPoints` reported across the runs.

**If the response carries a `warning`:** paging is by offset over a log that
is still being written, so if the log shifts mid-run an event can be stepped
over. The run reports `order` (`oldest-first` is the stable case — new events
land at the end) and `repeated` (events served on two pages). If either says
the window moved, re-run from `offset=0`; it costs nothing, since anything
already stored is ignored, and a clean re-run reports `imported: 0`.

### Environment

| name                   | notes                                                 |
| ---------------------- | ----------------------------------------------------- |
| `SUPABASE_URL`         | the La Bottega Supabase project URL                   |
| `SUPABASE_SERVICE_KEY` | service role key (server only; the table has no anon policies) |
| `ADMIN_SECRET`         | only needed to run the backfill                       |
| `SHOP_TIMEZONE`        | optional, default `Europe/London`                     |
| `LEDGER_TIMEOUT_MS`    | optional, default 4000                                |

If the ledger variables are missing the scanner still works; only the counter
and chart show as unavailable. A slow or unhealthy ledger is never felt at the
counter either: the API sends its response first and writes afterwards, so a
Supabase outage costs a scan nothing.

Run the migrations in `supabase/migrations` in filename order. 002 onwards
matter: 002 lets an unknown backfill amount be stored as `null` rather than 0,
003 renames `points_added` to `points_stamped` and rewrites the reporting
functions so the indexes are usable, and 004 states the anon revokes.

## Self-update on the shop device

The scanner page stays open for days, so `public/index.html` checks for a
new deployment itself: it hashes its own source at load, re-fetches it once
an hour and whenever the tab becomes visible, and reloads when the hash
changes. It never reloads mid-customer: with a customer panel open it waits
for 90 seconds without a tap, with the camera running it waits 10 minutes,
and with nothing on screen it still waits 30 seconds. Scrolling counts as
activity, so reading the chart does not get interrupted. The status bar shows
"Updating scanner..." just before the reload.
Devices still running a build from before this feature need one manual
refresh.

## Environment variables

Set these in Vercel (Project → Settings → Environment Variables). For testing
on this branch, set them for the **Preview** environment only.

| name                          | required | notes                                                        |
| ----------------------------- | -------- | ------------------------------------------------------------ |
| `PASSKIT_API_KEY`             | yes      | app.passkit.com → Developer Tools → REST Credentials         |
| `PASSKIT_API_SECRET`          | yes      | same place                                                   |
| `PASSKIT_API_BASE`            | no       | default `https://api.pub1.passkit.io` (EU). USA: `pub2`      |
| `PASSKIT_AUTH_SCHEME`         | no       | leave unset. Set `Bearer` only if PassKit returns 401         |
| `PASSKIT_ID_MODE`             | no       | `id` (default) or `externalId`                               |
| `PASSKIT_PROGRAM_ID`          | no       | only with `PASSKIT_ID_MODE=externalId`                       |
| `LOYALTY_REDEEM_COST`         | no       | default 9                                                    |
| `LOYALTY_MAX_POINTS_PER_SCAN` | no       | default 99                                                   |
| `SUPABASE_URL`                | yes      | scan counter, chart and backfill                             |
| `SUPABASE_SERVICE_KEY`        | yes      | service role key, server-side only                           |
| `ADMIN_SECRET`                | no       | only to run the backfill                                     |
| `SHOP_TIMEZONE`               | no       | default `Europe/London`                                      |
| `LEDGER_TIMEOUT_MS`           | no       | default 4000                                                 |

See `.env.example`.

## Running and testing it locally

```sh
npm run verify     # everything: unit tests, then end-to-end against a mock backend
npm run dev        # the whole app at http://localhost:3000, mock backend
```

`npm run verify` is the one command to run before pushing. It runs the unit
suite (`node --test`) and then starts the dev server with a stubbed PassKit and
Supabase and drives it over HTTP, checking the behaviour each fix was about. It
exits non-zero if anything regresses, so it works in CI as-is.

`npm run dev` serves `public/` and dispatches `/api/*` to the same handler files
Vercel runs, with no build step and no Vercel CLI. The mock backend means no
credentials are needed and **no real customer balance moves**. `http://localhost`
is a secure context, so the camera works there.

Scan any QR code at all: an id the mock does not recognise becomes a member with
a balance derived from the string. For the specific cases, put one of these in a
QR code:

| id | state | what to look for |
| --- | --- | --- |
| `M1000` | 4 points | no Redeem button at all |
| `M2000` | 18 points | redeem once, then the button must go dead reading "Redeemed" |
| `M3000` | 0 points, no history | the "First visit" pill |

No camera to hand? Drive the API directly:

```sh
curl -s -X POST localhost:3000/api/loyalty -H "content-type: application/json" \
  -d '{"action":"lookup_customer","qr_data":"M2000"}'
curl -s "localhost:3000/api/stats?range=week"
curl -s -X POST -H "x-admin-secret: mock-admin-secret" \
  "localhost:3000/api/admin/backfill?dryRun=1"
```

Use `npm run dev:live` to run against the real PassKit and Supabase instead;
it needs the environment variables below, and it moves real balances.

**What local testing cannot cover:** the SQL. The mock reimplements the two
reporting functions in JavaScript so the chart has something to draw, which
means a mistake in a migration cannot show up here. Run the migrations against
a Supabase branch and compare `select * from scan_totals('Europe/London');`
with a hand count before merging. `test/sql-contract.test.js` only catches
naming drift between the SQL and the code that calls it.

## Testing this branch without touching production

Preview deployments on this project sit behind **Vercel Authentication**
(Settings → Deployment Protection). On a phone, open the preview URL and log
in to Vercel when redirected. For the smoke script, either generate a
*Protection Bypass for Automation* secret in the same settings page and run
it with `VERCEL_BYPASS=<secret>`, or temporarily switch protection off for
Preview deployments. Production is not affected either way.

1. Push the branch. Vercel builds a **Preview** deployment with its own URL
   (`https://qr-scanner-git-<branch>-efficeicnais-projects.vercel.app`).
   Production keeps running the Make.com flow.
2. Add `PASSKIT_API_KEY` and `PASSKIT_API_SECRET` to the Preview environment
   (plus `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` if you want the counter and
   chart), then redeploy the preview (or push an empty commit).
3. Create a **test member** in PassKit so no real customer balance changes.
4. Run the smoke script against the preview with the test member's id:

   ```bash
   node scripts/smoke.mjs https://<preview-url> <member-id> --add 1
   ```

   Expect `lookup_customer -> HTTP 200` with the balance, then `add_points`
   returning the balance plus one. Add `--redeem` once the balance is 9+.
5. Open the preview URL on a phone and scan the test pass. The balance should
   load, Add Points should update it, and the wallet pass should refresh.

## Cutover (when you are happy)

1. Add the same PassKit variables to the **Production** environment.
2. Merge the PR. Check the Vercel production branch first (see below).
3. Scan once in the shop; confirm the pass updates.
4. Turn the Make.com scenario off (do not delete it for a week or two).

Rollback: redeploy the previous production deployment from the Vercel
dashboard, or change `WEBHOOK_URL` in `public/index.html` back to the Make
URL and turn the scenario on again.

### Branch drift, please read

Production is currently a manual promotion of the `master` branch
(`4436f7e`, "pull points"). The Vercel project's *Production Branch* setting
is `main`, which is one commit behind and does **not** have pull points.
A push to `main` would silently deploy the old scanner. Before cutover,
either fast-forward `main` to `master` or point Vercel's production branch at
`master`.

## Phasing PassKit out later

`lib/passkit.js` is the only file that knows about PassKit. It exposes three
calls: `getMember`, `earnPoints`, `burnPoints`. To move balances in-house,
add a provider with the same three calls backed by a Supabase table and
switch `api/loyalty.js` to it. The pass in the customer's wallet is the
larger job: PassKit also issues and refreshes the Apple/Google Wallet pass,
so replacing it means generating and signing passes ourselves.


## Native passes (the PassKit replacement, not yet wired to the scanner)

A separate set of files lets a customer join on our own page
(`/join`), get a pass **we** sign for Apple Wallet with the QR built in, and
have it kept up to date through Apple's pass web service. See
`docs/NATIVE-PASSES.md` for the architecture, every placeholder you need to
fill in (Apple Team ID, Pass Type ID, certificate, artwork, domain), and how
to test it. `npm run dev` runs the whole flow locally with a throwaway
certificate.
