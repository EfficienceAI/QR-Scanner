# Native loyalty passes (the PassKit replacement)

This is the system that lets a customer join on our own page and add a pass
we signed ourselves to Apple Wallet, with no PassKit, no Make.com, no SMS and
no email in the loop. It is a separate, self-contained set of files; the
scanner (`api/loyalty.js`) still talks to PassKit and is not wired to it yet.

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
| `PASS_THEME` | `default`, `christmas`, or `auto` (Christmas 1 Dec to 2 Jan) | after changing it, `POST /api/admin/refresh { all: true }` so every phone re-downloads |
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
So by default (`PASS_STAMP_STYLE=text`) the nine stamps are a text row of
filled and empty circles on the row under the photo, next to the name, and
the photo stays clean. With `PASS_STAMP_STYLE=strip` the stamps are drawn
as beans across the bottom of the photo instead:

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
- `POST /api/admin/refresh { serial } | { all: true, offset }` re-pushes passes without touching balances, for artwork or theme changes.

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

- **The scanner is not wired to native members.** Scanning one of these
  passes today gives "member not found" because `api/loyalty.js` still asks
  PassKit. The integration is a later, separate change: detect the `LBM:`
  prefix, read and adjust points in `members`, then call
  `pushPassUpdate(serial)` so the pass refreshes.
- **Google Wallet.** PassKit issues Android passes too; this phase is Apple
  only. The signup page tells Android visitors it is coming.
- **Importing existing PassKit members** into `members` (keeping their old
  pass working through the legacy path until they re-join).
