# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A mobile-first loyalty points scanner for La Bottega Milanese. Staff scan a
customer's QR code (a PassKit member pass, which encodes the member id), then
add stamps or redeem a free drink. The redeem cost is a server setting
(`LOYALTY_REDEEM_COST`, default 9) — never a client constant.

Deployed on Vercel as a static page plus Node functions. There is no
framework, no bundler and no runtime dependencies.

Two systems hold data:

- **PassKit** owns members and balances. Every balance shown or changed comes
  from a PassKit call.
- **Supabase** holds our own scan ledger (`scan_events`), which is the source
  of truth for "how many scans" and the foundation for moving off PassKit
  later. It is analytics, never a balance.

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
| `lib/auth.js` | The staff passcode / admin secret gate |
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
- **Every API call carries the staff passcode.** `/api/loyalty` and
  `/api/stats` refuse anonymous callers, and fail closed if
  `STAFF_PASSCODE` is unset. The page asks once per device and stores it in
  `localStorage`.
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
| `apiFetch(url, init)` | `fetch` for our API: adds the passcode, re-asks on 401 |
| `lookupCustomer(qrData)` | POSTs `lookup_customer`, returns points/member/history |
| `refreshCustomerPoints(qrData)` | Applies a lookup, dropping stale answers |
| `setPointsDisplay(points, message)` | Balance, copy, and whether Redeem is armed |
| `sendPoints()` / `sendRedeem()` | Mutations; both capture state before awaiting |
| `Counter` / `Chart` | The scan counter and the SVG chart, from `/api/stats` |
| `SelfUpdate` | Hashes its own source hourly and reloads when idle |

## Development

```sh
npm test        # node --test — no framework, no install step
```

Edit `public/index.html` directly and open it in a browser, or deploy to
Vercel (push to deploy). The camera needs a secure context: an `https://`
address, or `http://localhost`, which browsers already treat as secure — a
LAN IP will not work.

Environment variables are listed with their purpose in `.env.example`.
`STAFF_PASSCODE`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are required for
the app to function at all.

Run migrations in order against the Supabase project before deploying a
change that depends on them.
