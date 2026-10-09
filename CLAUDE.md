# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A mobile-first loyalty points scanner for La Bottega Milanese. Staff scan a
customer's QR code (a PassKit member pass, which encodes the member id), then
add stamps or redeem a free drink. The redeem cost is a server setting
(`LOYALTY_REDEEM_COST`, default 9) — never a client constant.

Deployed on Vercel as a static page plus Node functions. There is no
framework, no bundler and no runtime dependencies.

Three systems hold data (the third is new and not yet wired to the scanner):

- **PassKit** owns members and balances. Every balance shown or changed comes
  from a PassKit call.
- **Supabase** holds our own scan ledger (`scan_events`), which is the source
  of truth for "how many scans" and the foundation for moving off PassKit
  later. It is analytics, never a balance.
- **Supabase `members`** holds *native* members (joined on `/join`, holding a
  pass we signed). Their points live here. The scanner does not read it yet;
  the QR on those passes is `LBM:<uuid>` so the two kinds can never be
  confused with a PassKit id.

## Layout

| Path | What it is |
|---|---|
| `public/index.html` | The whole client: markup, CSS and JS in one file |
| `public/vendor/jsQR-1.4.0.min.js` | Vendored QR decoder (not a CDN — see the comment on the script tag) |
| `api/loyalty.js` | `lookup_customer`, `add_points`, `remove_points`, `redeem_points` |
| `api/stats.js` | Counters and the time series behind the chart |
| `api/admin/backfill.js` | One-off import of PassKit's event log (the Make.com era) |
| `lib/passkit.js` | PassKit Membership REST client (JWT signed per request) |
| `lib/ledger.js` | PostgREST calls against `scan_events` with the service key |
| `lib/time.js` | Timezone helpers, so buckets follow the shop's clock through DST |
| `lib/auth.js` | The admin secret gate for the backfill |
| `public/join/index.html` | The signup page for native members (replaces the Carrd page) |
| `api/join.js` | Creates a native member and answers with the pass download link |
| `api/pass/[serial].js` | The signed `.pkpass` (and an SVG QR of its link, `?qr=1`) |
| `api/wallet/v1/**` | Apple's pass web service: device registration, "what changed", latest pass, logs |
| `lib/db.js` | General PostgREST client (service key) for the members tables |
| `lib/members.js` | Native members: validation, tokens, QR message `LBM:<uuid>`, points RPC, Wallet registrations |
| `lib/pass.js` | Builds `pass.json` from a member and signs the `.pkpass` (passkit-generator) |
| `lib/apns.js` | Tells Wallet a pass changed (HTTP/2 push with the Pass Type ID certificate) |
| `lib/wallet.js` | Shared helpers for the web service routes (ApplePass auth) |
| `pass-template/` | Pass artwork; the files there are labelled placeholders |
| `certs/AppleWWDRCAG4.pem` | Apple's public WWDR intermediate, needed to sign passes |
| `docs/NATIVE-PASSES.md` | Setup guide and the list of placeholders for the native pass system |
| `supabase/migrations/*.sql` | Table, indexes, RLS and the two RPCs the stats read |
| `test/*.test.js` | `node --test`, no test framework |
| `vercel.json` | `outputDirectory: public`, an **empty** `buildCommand` (which also suppresses framework detection), and 60s `maxDuration` for the backfill |

## Rules that are easy to break

- **The client is not trusted.** The server decides the redeem cost; the
  client's `points_to_remove` is only logged. Keep it that way.
- **The QR string is never the balance.** An early version ran a number
  parser over the raw scanned text, so member id `4829175` displayed as
  4,829,175 points and unlocked a free drink. Only the server's `points`
  field is authoritative.
- **The ledger must never delay or break a scan.** `recordEvent` never
  throws, and handlers respond *before* they record (`respondThenRecord` in
  `api/loyalty.js`). Do not move a ledger call in front of a response.
- **The API is deliberately open.** `/api/loyalty` and `/api/stats` take no
  application-level authentication: the scanner has to work the instant a
  staff member picks the device up. Access control is the deployment's job
  (Vercel Deployment Protection, or simply who has the URL), so do not add a
  passcode here without being asked. `/api/admin/backfill` is the exception
  and keeps its `ADMIN_SECRET`.
- **The native pass system is not integrated with the scanner yet** (by
  decision). Do not route `LBM:` QR codes in `api/loyalty.js` until asked.
- **`SUPABASE_SERVICE_KEY` is server-side only.** It bypasses RLS; the page
  must never see it.
- **Amounts that cannot be read are `null`, not `0`.** The backfill parses
  free text written by a system we no longer run; a zero would look like a
  real visit worth nothing.

## Key functions (public/index.html)

| Function | Purpose |
|---|---|
| `startScanner()` / `stopScanner()` | Camera lifecycle |
| `tick()` | rAF loop that feeds frames to jsQR |
| `handleScan(data)` | Processes a decoded QR and triggers the lookup |
| `lookupCustomer(qrData)` | POSTs `lookup_customer`, returns points/member/history |
| `refreshCustomerPoints(qrData)` | Applies a lookup, dropping stale answers |
| `setPointsDisplay(points, message)` | Balance, copy, and whether Redeem is armed |
| `sendPoints()` / `sendRedeem()` | Mutations; both capture state before awaiting |
| `Counter` / `Chart` | The scan counter and the SVG chart, from `/api/stats` |
| `SelfUpdate` | Hashes its own source hourly and reloads when idle |

## Development

```sh
npm run verify   # unit tests, then end-to-end against a mock backend
npm run dev      # the whole app on localhost:3000, nothing real is touched
npm test         # unit tests alone (node --test, no framework, no install step)
```

`npm run dev` runs `scripts/dev-server.mjs`, which serves `public/` and
dispatches `/api/*` to the same handlers Vercel runs. Its `--mock` backend
stubs PassKit and Supabase in memory, so no credentials are needed and no real
balance moves. The mock reimplements the two reporting RPCs in JavaScript, so
it proves the page and the API but **not** the SQL in the migrations.

Alternatively edit `public/index.html` and open it directly, or deploy to
Vercel (push to deploy). The camera needs a secure context: an `https://`
address, or `http://localhost`, which browsers already treat as secure — a
LAN IP will not work.

Environment variables are listed with their purpose in `.env.example`.
`SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are required for the scan counter
and the chart; without them the scanner still works and only those are
unavailable.

Run migrations in order against the Supabase project before deploying a
change that depends on them.
