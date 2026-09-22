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
and Make talked to PassKit. The function replaces Make one-for-one; the page
is unchanged apart from the URL it posts to.

### API contract

| action            | request fields                      | 200 response                                  |
| ----------------- | ----------------------------------- | --------------------------------------------- |
| `lookup_customer` | `qr_data`                           | `{ ok, points, member, history }` (see below)   |
| `add_points`      | `qr_data`, `points` (1–99)          | `{ ok, added, points }`                        |
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
the client's `points_to_remove` is logged but not trusted.

Every earn/burn is written to PassKit's member event log with
`externalServiceId = loyalty-scanner`, so the audit trail Make used to give
you now lives in PassKit. Each request also logs one JSON line to the Vercel
function logs.

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

See `.env.example`.

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
   and redeploy the preview (or push an empty commit).
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
