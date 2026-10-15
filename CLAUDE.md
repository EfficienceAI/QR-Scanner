# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A mobile-first loyalty points scanner for La Bottega Milanese. Staff scan a
customer's QR code (a PassKit member pass, which encodes the member id), then
add stamps or redeem a free drink. The redeem cost is a server setting
(`LOYALTY_REDEEM_COST`, default 9) — never a client constant.

Deployed on Vercel as a static page plus Node functions. There is no framework
and no bundler. There are three runtime dependencies and one dev dependency:

| Package | Why |
|---|---|
| `@vercel/functions` | the `waitUntil` that keeps after-reply work alive (`lib/after.js`, which falls back to the platform's request-context symbol if the package is missing from the bundle) |
| `passkit-generator` | signs the `.pkpass` |
| `qrcode` | the SVG QR on the signup page's desktop view |
| `node-forge` (dev) | the throwaway self-signed certificate the pass tests and the dev server sign with |

`passkit-generator` brings three high-severity advisories (`joi` and
`node-forge`) whose only offered remedy is a breaking downgrade.
`scripts/audit-check.mjs`, which `npm run verify` ends with, holds the
reachability trace for each one and a review date; it fails on any advisory
not assessed there, so a new one surfaces by itself.

One external service beyond PassKit, Supabase and Google Wallet: **Resend**,
called over `fetch` (no npm package) to email a recovery code when someone
has lost their pass. Without `RESEND_API_KEY` and `RESEND_FROM` the recovery
path simply turns itself off and the signup page says to ask a member of
staff, so nothing else breaks.

`npm install` is required before the tests run: `test/pass.test.js` signs a
real pass. The scanner itself ran with no dependencies at all until the native
pass system arrived, and a new one on the scan hot path still needs a reason
as good as `@vercel/functions` has.

Three systems hold data:

- **PassKit** owns the balance of every member who still carries a PassKit
  pass. Every balance shown or changed for them comes from a PassKit call.
- **Supabase** holds our own scan ledger (`scan_events`), which is the source
  of truth for "how many scans" and the foundation for moving off PassKit
  later. It is analytics, never a balance.
- **Supabase `members`** holds *native* members (joined on `/join`, holding a
  pass we signed) and owns their points. The scanner reads it: a `LBM:<uuid>`
  QR is served from here and never touches PassKit, and the `LBM:` prefix is
  what stops the two kinds ever being confused with a PassKit id.

## Layout

| Path | What it is |
|---|---|
| `public/index.html` | The whole client: markup, CSS and JS in one file |
| `public/vendor/jsQR-1.4.0.min.js` | Vendored QR decoder (not a CDN — see the comment on the script tag) |
| `api/loyalty.js` | `lookup_customer`, `add_points`, `remove_points`, `redeem_points` |
| `api/stats.js` | Counters and the time series behind the chart |
| `api/admin/backfill.js` | One-off import of PassKit's event log (the Make.com era) |
| `api/admin/import.js` | Brings PassKit members into the `members` table ahead of the switch-over |
| `api/admin/points.js` | Staff correction of a native member's balance (atomic RPC) |
| `api/admin/member.js` | Looks a native member up for staff, including their pass link |
| `api/admin/refresh.js` | Re-pushes passes after an artwork or theme change |
| `api/gwallet/[serial].js` | The Google Wallet "save" link for a member |
| `lib/passkit.js` | PassKit Membership REST client (JWT signed per request) |
| `lib/ledger.js` | PostgREST calls against `scan_events` with the service key |
| `lib/time.js` | Timezone helpers, so buckets follow the shop's clock through DST |
| `lib/after.js` | `after()`: registers post-response work with the platform so Vercel cannot freeze the function before it finishes |
| `lib/auth.js` | The admin secret gate for the backfill |
| `public/join/index.html` | The signup page for native members (replaces the Carrd page) |
| `api/join.js` | Creates a native member and answers with the pass download link |
| `api/pass/[serial].js` | The signed `.pkpass` (and an SVG QR of its link, `?qr=1`) |
| `api/wallet/v1/**` | Apple's pass web service: device registration, "what changed", latest pass, logs |
| `lib/db.js` | General PostgREST client (service key) for the members tables |
| `lib/members.js` | Native members: validation, tokens, QR message `LBM:<uuid>`, points RPC, Wallet registrations, `readAmount` |
| `lib/native-scan.js` | The `LBM:` scan path: lookup, add, remove, redeem, and the PassKit mirror both ways |
| `lib/gwallet.js` | Google Wallet: the loyalty class and object, and the JWT for the save link |
| `lib/recovery.js` | Lost-pass recovery: a six-digit code emailed via Resend, hashed at rest, with a resend throttle and an attempt cap |
| `api/recover.js` | Trades a valid recovery code for the pass link |
| `lib/pass.js` | Builds `pass.json` from a member and signs the `.pkpass` (passkit-generator) |
| `lib/apns.js` | Tells Wallet a pass changed (HTTP/2 push with the Pass Type ID certificate) |
| `lib/wallet.js` | Shared helpers for the web service routes (ApplePass auth) |
| `pass-template/` | Pass artwork, generated from `pass-art/` by `scripts/build-pass-art.py` |
| `scripts/import-passkit.mjs` | Feeds `api/admin/import.js` from PassKit's CSV export |
| `scripts/audit-check.mjs` | `npm audit` against the assessed advisories, with the reason and review date for each |
| `scripts/selfsigned-cert.js` | A throwaway certificate, so the pass suite and the dev server can sign without the real one |
| `certs/AppleWWDRCAG4.pem` | Apple's public WWDR intermediate, needed to sign passes |
| `docs/NATIVE-PASSES.md` | Setup guide and the list of placeholders for the native pass system |
| `supabase/migrations/*.sql` | Table, indexes, RLS and the two RPCs the stats read |
| `test/*.test.js` | `node --test`, no test framework |
| `vercel.json` | `outputDirectory: public`, an **empty** `buildCommand` (which also suppresses framework detection), 60s `maxDuration` for the backfill, the import and the scanner, `includeFiles` so the pass routes get the template and the certificates, and the host-scoped redirect of `/` to `/join/` |

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
- **Work that happens after the response must go through `after()`.** Vercel
  can freeze a function the moment `res.end()` flushes, so a bare floating
  promise is simply lost — that is how scans went uncounted. `after()`
  registers it with the platform's `waitUntil`. Two things matter and both are
  covered by tests that fail if you undo them: register **before** `send()`
  (otherwise the guarantee rests on nobody adding an `await` between the two
  lines), and keep returning the promise (the dev server and the tests await
  it, because locally there is no `waitUntil`).
- **The API is deliberately open.** `/api/loyalty` and `/api/stats` take no
  application-level authentication: the scanner has to work the instant a
  staff member picks the device up. Access control is the deployment's job
  (Vercel Deployment Protection, or simply who has the URL), so do not add a
  passcode here without being asked. `/api/admin/*` is the exception: every
  one of those endpoints is gated on `ADMIN_SECRET` through
  `lib/auth.js`'s `requireAdmin`, which also throttles guesses. They move
  balances and expose pass links, so keep them that way.
- **The native pass path is live.** `api/loyalty.js` routes a `LBM:<uuid>` QR
  to `lib/native-scan.js`, which answers from the `members` table and never
  calls PassKit. Both systems run at once during the overlap and mirror in
  both directions: a PassKit scan of someone we imported updates their native
  row (`mirrorLegacy`), and a native scan of someone linked to a PassKit
  record sends the same earn or burn on to PassKit (`writeBack`). Neither
  mirror may fail a scan, and neither may invent a balance.
- **A balance that cannot be read must never be written.** This is the "null,
  not 0" rule in the one place it can destroy something. `members.syncPoints`
  and `/api/admin/import` write points as an *absolute* value rather than a
  delta, so an unreadable amount coerced to `0` wipes a customer, and the
  ledger holds the action's delta rather than the overwrite, so the old
  balance cannot be recovered afterwards. Use `members.readAmount`, which
  answers `null` for everything `Number()` quietly turns into `0` (`null`,
  `''`, `[]`, `false`, `'n/a'`). A real `0` is a balance; "we could not read
  it" is not.

  The import endpoint cannot enforce that on its own, because a `0` that
  arrives as a readable number is indistinguishable from a customer who has
  nothing. PassKit's export writes no `"0"` at all -- a member on nothing has
  a blank cell, 1,657 of 5,271 on the switch-day export -- so
  `scripts/import-passkit.mjs` has to decide what a blank means, and it reads
  one as zero *only when the points column carries a value somewhere*. A
  column that is present but empty throughout is treated as unreadable, the
  same as a renamed one. Behind that, `/api/admin/import` refuses any batch
  that would write more than half of its existing non-zero balances down to
  zero, and reports `would_zero` either way. Both guards are deliberately
  loose: the first version of the unreadable check refused the real
  switch-day import, and blocking a legitimate import is worse than letting
  an odd small batch through.
- **`/api/join` must not hand back an existing member.** It is public, and
  neither an email address nor a mobile number is a secret. An email *or*
  number already on a card gets `{ ok: true, existing: true }` and nothing
  else: no `member.id` (which *is* the QR payload), no `passUrl` (whose token
  downloads their signed pass and with it their Apple credential), no name,
  no balance. One person, one card.

  To get a card back, `lib/recovery.js` emails a six-digit code to the address
  *on the card* and `/api/recover` trades it for the link — so control of the
  inbox is the proof, rather than knowledge of the address. Where
  `RESEND_API_KEY`/`RESEND_FROM` are unset the customer is sent to the
  counter, where staff have `GET /api/admin/member`.
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
npm install      # required: the pass tests sign a real .pkpass
npm run verify   # unit tests, then end-to-end against a mock backend
npm run dev      # the whole app on localhost:3000, nothing real is touched
npm test         # unit tests alone (node --test, no test framework)
npm run audit    # npm audit against the advisories we have assessed
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
