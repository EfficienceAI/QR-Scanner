# Native loyalty passes (the PassKit replacement)

This is the system that lets a customer join on our own page and add a pass
we signed ourselves to Apple Wallet, with no PassKit, no Make.com, no SMS and
no email in the loop. The scanner (`api/loyalty.js`) serves both kinds of
pass: a QR that starts with `LBM:` is one of ours and is answered from the
`members` table (`lib/native-scan.js`); anything else is a PassKit pass and
takes the unchanged PassKit path. Nothing here is deployed to the live
scanner project; it runs on the separate `lbm-loyalty` deployment.

```
/join (public/join/index.html)
   |  POST /api/join { full_name, email, phone, consent }
   v
members table (Supabase)  <-- points for native members live here
   |  passUrl = /api/pass/<serial>?t=<download token>
   v
Add to Apple Wallet  -> GET /api/pass/<serial>  -> signed .pkpass (lib/pass.js)
                                                   QR on the pass = "LBM:<member id>"

Wallet keeps the pass fresh through Apple's pass web service:
   POST   /api/wallet/v1/devices/{device}/registrations/{passType}/{serial}   register (ApplePass token)
   DELETE /api/wallet/v1/devices/{device}/registrations/{passType}/{serial}   unregister
   GET    /api/wallet/v1/devices/{device}/registrations/{passType}?passesUpdatedSince=  what changed
   GET    /api/wallet/v1/passes/{passType}/{serial}                           latest pass (304 if unchanged)
   POST   /api/wallet/v1/log                                                  Wallet's error reports
and we push "something changed" to the registered devices via APNs (lib/apns.js)
whenever a member's points change.
```

## What you need to fill in (placeholders)

| Where | What | Notes |
| --- | --- | --- |
| `APPLE_TEAM_ID` | your Apple Developer Team ID | Membership page in the developer account |
| `PASS_TYPE_ID` | the Pass Type ID you created, e.g. `pass.com.labottegamilanese.loyalty` | Certificates, Identifiers & Profiles → Identifiers → Pass Type IDs |
| `PASS_CERT_PEM_B64` | the Pass Type ID **certificate**, PEM, base64-encoded | see "Exporting the certificate" |
| `PASS_KEY_PEM_B64` | its **private key**, PEM, base64-encoded | same |
| `PASS_KEY_PASSPHRASE` | the key's passphrase, if you set one | optional |
| `PUBLIC_BASE_URL` | the public https origin the passes will call back to | e.g. `https://loyalty.labottegamilanese.com`. Must be publicly reachable: Wallet calls it from the customer's phone with no cookies, so a Vercel preview behind Deployment Protection will **not** work for the update service. |
| `PASS_ORG_NAME`, `PASS_DESCRIPTION`, `PASS_LOGO_TEXT` | wording on the pass | defaults are La Bottega Milanese |
| `PASS_BACKGROUND_COLOR`, `PASS_FOREGROUND_COLOR`, `PASS_LABEL_COLOR` | pass colours as `rgb(r, g, b)` | defaults: near-black, white, grey |
| `pass-art/*.png` | the source artwork: `strip-default.png`, `strip-christmas.png` (1125×432, PassKit's size), `logo-white.png`, `logo-on-black.png`, `bean.png` | `python3 scripts/build-pass-art.py` regenerates everything in `pass-template/` from these |
| `PASS_THEME` | `default`, `christmas`, or `auto` (Christmas 1 to 31 December) | after changing it, `POST /api/admin/refresh { all: true }` so every phone re-downloads |
| `public/join/index.html` | terms and privacy links, the official Apple "Add to Apple Wallet" badge | marked `PLACEHOLDER` in the file |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | the La Bottega Supabase project | run `supabase/migrations/005_members_and_passes.sql` |

Apple's WWDR G4 intermediate certificate is public and bundled at
`certs/AppleWWDRCAG4.pem` (valid to 2030); `PASS_WWDR_PEM_B64` only needs
setting if Apple ever rotates it.

### Exporting the certificate

In Keychain Access, export the "Pass Type ID: ..." certificate **with its
private key** as a `.p12`, then:

```bash
openssl pkcs12 -in pass.p12 -clcerts -nokeys -out pass-cert.pem
openssl pkcs12 -in pass.p12 -nocerts -nodes -out pass-key.pem     # or keep a passphrase and set PASS_KEY_PASSPHRASE
base64 -i pass-cert.pem | tr -d '\n'    # -> PASS_CERT_PEM_B64
base64 -i pass-key.pem  | tr -d '\n'    # -> PASS_KEY_PEM_B64
```

The same certificate and key are used for the APNs push that tells Wallet a
pass changed (Apple requires the Pass Type ID certificate for that; no
separate push key is needed).

## The stamp row

Apple's store card layout only has image slots for the logo, the icon and
the strip across the top; nothing can be drawn between the name and the QR.
By default (`PASS_STAMP_STYLE=strip`) the nine stamps are drawn on the
photo as a five-over-four grid: empty stamps are a barely visible outline,
and a bean appears in each as points are earned. With
`PASS_STAMP_STYLE=text` the stamps are instead a text row of filled and
empty circles on the row under the photo, next to the name:

The strip across the card is then one of ten pre-rendered images per theme,
`strip-0` to `strip-9`, with that many beans filled. The pass picks the one
matching the balance capped at the reward cost, so a balance of 10 or 100
shows all nine beans until a redemption brings it down. Changing a stamp
therefore changes the picture, delivered through the same refresh path as
the number.

`scripts/build-pass-art.py` (Python, Pillow) draws the row over the source
photo: a soft dark band so it reads over any image, nine circles, filled ones
in cream with the bean. It also makes the logo (crest + wordmark, white) and
the icon (the crest alone on black) at every size Apple wants.

## Admin endpoints (header `x-admin-secret`)

- `POST /api/admin/points { serial | email, delta }` adjusts a native member's balance and refreshes their pass.
- `POST /api/admin/refresh { serial } | { all: true, after } | { class: true }` re-pushes passes
  without touching balances, for artwork or theme changes. `all` walks the members
  table by serial: call it again with the `nextAfter` it returns until that comes
  back `null`. The first page also pushes the Google Wallet card design (the class),
  which is the only thing that can change an Android card's appearance or re-submit
  a class stuck `UNDER_REVIEW`; `{ class: true }` does just that and touches no passes.
- `POST /api/admin/import { members: [...], dry_run }` brings PassKit members into `members`
  (up to 500 a call). Keyed on the PassKit member id, so re-running updates points and never
  duplicates; someone who already joined natively with the same email is linked, not duplicated.
  `scripts/import-passkit.mjs` feeds it from PassKit's CSV export.

  Points are written as an **absolute** value, so a re-run can lower a balance as easily as
  raise it, and two guards sit in front of that. An amount that cannot be read is never
  written, and past 10% of the rows the batch is refused (`unreadable_points`). A batch that
  would write more than half of its existing non-zero balances down to zero is refused too
  (`would_zero`, `error: mass_zeroing`) -- that is the one a dead points column trips, since
  every value in it reads as a perfectly valid `0`. Both counts are reported on a dry run as
  well, which matters because a dry run otherwise shows counts and not values: `updated: 5000`
  reads the same whether balances went up or to zero.

## The scanner and the overlap period

- **Native scan** (`LBM:<member uuid>`): balance read and changed atomically in
  `members` (`adjust_member_points`), visit history from our own `scan_events`
  rows, and after a change the phone is told to re-fetch the pass over APNs.
  Same discipline as the PassKit path: reply first, record and push after.
- **PassKit scan of an imported member**: PassKit still answers, and then the
  imported row is set to the balance PassKit reported (`mirrorLegacy`), so the
  pass they later upgrade to already shows the right stamps. Skipped silently
  where the members database is not configured (the live scanner project).
- **In-place upgrade**: PassKit's passes use the member id as the pass serial
  (checked on a real pass: `serialNumber` = `members.member.id`, same Pass
  Type ID as ours). Imported members keep that id as `pass_serial`, so when
  they open their personal link Wallet replaces the PassKit card rather than
  adding a second one. An imported member's history keeps their PassKit-era
  rows because `listMemberEvents` is asked for both ids.

## Lost your pass (recovery codes)

An email or mobile number that is already on a card never gets the card's
link straight back from the join page: anyone who knew a friend's number
could collect their points. `POST /api/join` with a known email or number
answers `existing: true, recovery: true` and sends a six-digit code to the
email on the card through Resend (`RESEND_API_KEY`, `RESEND_FROM`);
`POST /api/recover { email | phone, code }` trades the code for the links
and rotates the download token so older links die. Codes live ten minutes,
allow five tries, one send a minute; the first call answers the same way
for an unknown email, so the endpoint cannot be used to look people up.
Without Resend configured the page says to ask staff.

## Google Wallet (Android)

`lib/gwallet.js` talks to the Wallet Objects API as the issuer's service
account (`GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SA_JSON_B64`). One loyalty
class is the card design (issuer name La Bottega Milanese, black card, the
crest as logo); each member who asks for the Android card gets one loyalty
object: balance, free drinks, the stamp photo for their balance (served from
`public/join/stamps/<theme>/strip-N.png`) and the same `LBM:` QR as the Apple
pass. `GET /api/gwallet/:serial?t=…` creates or refreshes the object, remembers
its id on the member (`gwallet_object_id`) and redirects to Google's signed
"save" link; the join page shows it to Android visitors, and an Android phone
opening the Apple pass link is redirected to it. Every balance change (scanner,
admin points, PassKit mirror) also patches the object, so Google updates the
phones. Until Google approves publishing, only test accounts listed in the
console can add the card. There is no in-place upgrade from a PassKit Android
card: that card belongs to PassKit's issuer, so the customer adds ours and
removes the old one.

## How a pass is built

`lib/pass.js` assembles `pass.json` from the member row: a store card with
STAMPS in the header, the member's name, "N more stamps" or "Free drink
ready", member since, and back-of-pass copy; a QR barcode whose message is
`LBM:<member uuid>`; `webServiceURL` and a per-member `authenticationToken`
so Wallet can register for updates. `passkit-generator` adds the manifest,
signs it with the certificate and zips the lot.

Run `npm run dev` and open `http://localhost:3000/join/` to try the whole
flow with a throwaway certificate (nothing real is touched; Wallet will
refuse the file, which is expected).

## Testing on a real iPhone

1. Deploy with the variables above set for that environment.
2. Open `<PUBLIC_BASE_URL>/join/` on the iPhone, fill the form, tap Add to
   Apple Wallet. The Wallet sheet should appear with your pass.
3. In Supabase, change that member's points (or call the adjust RPC) and
   touch `pass_updated_at`; within a few seconds the pass on the phone should
   refresh. If it does not, check the function logs for `wallet-service`
   events: a `register` line proves the phone reached the web service; a
   `apns_push_failed` warning points at the certificate or the topic.

## What is deliberately not done yet

- **Nothing is on the live scanner project.** `qr-scanner` (production) has
  no Supabase variables and no native code; `lbm-loyalty` has no PassKit
  keys. The switch-over is the moment one deployment gets both sets.
- **No customer has been imported or contacted.** The import is run
  deliberately, by hand, per batch; the "tap to upgrade" message goes out
  through PassKit only when the switch is on.
- **Google Wallet.** PassKit issues Android passes too; this phase is Apple
  only. The signup page tells Android visitors it is coming.
- **Native changes are not written back to PassKit.** Once a member has
  upgraded, their PassKit record goes stale; PassKit is being retired, so
  that is accepted.
