# Remold go-live: independent verification

Date: 2026-10-02 03:35Z to 03:50Z. Verifier: Claude Fable 5.1 (claude-fable-5-1), a session that did not build the cutover. Mode: strictly read-only. No production writes, no deploys, no settings or account changes, no clicks that create, edit, delete, approve or send.

Claim under test: `evidence/2026-09-29-go-live/report.html` (builder: Claude Opus 5.5, 2026-09-29).

## Verdicts

| # | Check | Verdict |
|---|-------|---------|
| 1 | Live site serves a non-Clerk build targeting nautical-viper-899 | PASS |
| 2 | Production data: workspace with claimed counts, user linked to WorkOS | PASS |
| 3 | Import claim: old vs new export, 0 unexplained mismatches | PASS (6 differences, all explained by the builder's own post-import actions) |
| 4 | Signed-in view: workspace, 3 companies, 4 people, Today and a record load | PASS |
| 5 | Risks noticed | See list below; none blocks the go-live, items 1 and 2 deserve attention |

## 1. Live bundle (PASS)

- `curl https://app.remoldcrm.com` returns 200 with `<script src="/assets/index-rIzLqg-9.js">` (the claimed build; the old Clerk build was `index-BdUsyEab.js`).
- Bundle sha256 `3cb73426f521e1b148814c7fb1b8470f3a9467252ea257953e2f18da2b8ece77`, 666,997 bytes.
- Convex hosts in the bundle: `nautical-viper-899.convex.cloud` (ConvexReactClient constructor) and `nautical-viper-899.convex.site` (agent REST base shown in Settings). `happy-otter-123.convex.cloud` appears only inside Convex's own library error message. `gallant-pika-581` does not appear anywhere.
- Clerk: the only occurrence is the string "ConvexProviderWithClerk" inside a Convex library error message. No Clerk SDK, publishable key, or `clerk.accounts.dev` host.
- Auth: WorkOS AuthKit (`api.workos.com`), client id `client_01M3AAH3...` (a public client id, not a secret). The bundle enables `devMode` (browser-stored session) when `mode === "staging-live"` on hostname `app.remoldcrm.com`, exactly the interim the builder disclosed.
- Secret scan of the bundle: no `sk_`, deploy keys, JWTs, AWS keys, or `VITE_*` names. Nothing secret exposed.
- Apex and www 301 to `https://app.remoldcrm.com/`; `/callback` serves 200 (SPA route).

## 2. Production data (PASS)

Read with `pnpm exec convex data --prod` (42 tables listed). Output redacted; no secrets or env values printed.

- `users`: 1 row, `shakur@codemyvibe.com`, `tokenIdentifier` prefix `https://api.workos.com/user_management/client_01M3AAH3...` (104 chars), `imageUrl` on `workoscdn.com`. The pre-switch export had a Clerk prefix (`organic-adder-8470.clerk.accounts.dev`, img.clerk.com). Relink confirmed; full id not printed.
- `orgs`: 1 row, `Codemyvibe`, id `kh74gfj79fms7mk2x7w3fx56ts8ewy52`, `authorityFrozenAt` set with 7 frozen object keys.
- `members`: 1 row, owner = that user.
- `records`: 16 rows (Company 3, Person 4, Opportunity 3, Task 3, Note 2, Project 1). Titles are all fictional seed data ("Fictional Plumbing Co East", "Example Electric LLC", "Atlas Imaginary Works", "Casey Fiction", "Ben Sample", "Drew Placeholder", "Ava Example", ...). The workspace holds no real client data yet.
- `agents`: 3 rows: fable-mac (active, authorityVersion 1), astra-verifier (active, v1), go-live-test (state `fired`, `revokedAt` set).
- `suggestions`: 4, all dismissed. `invites`, `opsAlerts`, `opsNotices`: empty.
- `authorityAudit`: 4 rows (authorityFrozen, 2x legacyAuthorityExpanded by migration, legacyGrantsFrozen for go-live-test).
- The production rows match today's export `nautical-viper-899-20261002T0329Z.zip` row for row on every table I pulled. That also ties `--prod` to nautical-viper-899: the CLI does not print the deployment name, but the revoked go-live-test agent exists only in this deployment and never in gallant-pika-581.

## 3. Import claim (PASS, 0 unexplained)

Both archives verified against `SHA256SUMS` (OK, OK). The old export sha256 `664e87a4...` matches the hash the builder's report cites. Compared with a Python script on `_id`, counts, and full canonical JSON per document.

| Table | Old | New | Identical docs | Differences |
|---|---|---|---|---|
| events | 27 | 27 | 27/27 | none |
| fields | 38 | 38 | 38/38 | none |
| records | 16 | 16 | 16/16 | none |
| objects | 7 | 7 | 7/7 | none |
| links | 1 | 1 | 1/1 | none |
| members | 1 | 1 | 1/1 | none |
| agentInbox, apiLimits, invites, opsEvents, recordValues, slotRecords, valueRecords | 0 | 0 | | none |
| users | 1 | 1 | 0/1 | `tokenIdentifier`, `imageUrl` changed: Clerk to WorkOS relink (claimed) |
| orgs | 1 | 1 | 0/1 | `authorityFrozenAt`, `authorityFrozenKeys` added: authority freeze (claimed) |
| agents | 2 | 3 | 0/2 | fable-mac and astra-verifier gained `authorityVersion`, `authorityEpoch`, `origin`, `readObjectIds`, `sharedInbox`, `state` (v1 migration, claimed); go-live-test added then revoked (claimed) |
| suggestions | 3 | 4 | 3/3 | 1 added, dismissed, from go-live-test (claimed agent test) |

25 new-only tables: 21 empty; `authorityAudit` 4 rows (the migration above), `opsAlertFunctions` 2 rows (both `failures: 0`, `lastFailed: false`), `opsAlertScan` 1 row, `opsProbes` 66 rows (all `result: unconfigured`, see risk 3).

Every one of the 6 row-level differences is an action the builder's report describes. The 17 original tables carry no lost or altered CRM rows. Nothing else changed between the 2026-09-29 import and today's export beyond ops/telemetry housekeeping tables.

## 4. Signed-in view (PASS)

Owned Chrome driver (web-automate), profile already signed in; no password or 2FA was needed and I did not sign in or out. Only `nav`, `screenshot`, and read-only `eval` were used. Nothing was clicked, typed, or saved.

- `https://app.remoldcrm.com/` landed on `/o/kh74gfj79fms7mk2x7w3fx56ts8ewy52/today`, header "Codemyvibe", footer `shakur@codemyvibe.com`. Screenshot `01-today.png`. Follow-ups: "Nothing due this week".
- Companies list: 3 rows (Fictional Plumbing Co East, Example Electric LLC, Atlas Imaginary Works). `02-companies.png`.
- People list: 4 rows (Drew Placeholder, Casey Fiction, Ben Sample, Ava Example) with company links. `03-people.png`.
- Record page `company/k97bayerzgv07m3dg5snvam8vx8ew04v` (Example Electric LLC): City "Demo Bay", timeline "Shakur Abdullah created this Sep 22". Confirms the agent-test suggestion was not applied. `04-record-example-electric.png`.
- Settings: Members shows one owner; Agents lists fable-mac, astra-verifier (proposes only) and go-live-test struck through as revoked. `05-settings.png`.
- Page resource hosts: app.remoldcrm.com, api.workos.com, static.cloudflareinsights.com (Convex uses a WebSocket, which does not appear in resource timing; backend identity is proven by the bundle and by the revoked go-live-test agent being visible).

Screenshots are of the Remold app only.

## 5. Risks noticed

1. Any signed-in WorkOS identity can create a workspace. `convex/orgs.ts` `create` only requires `getPrincipal`, and `convex/users.ts` `store` inserts a user row for any valid WorkOS identity. Since the staging client allows Google sign-in, anyone with a Google account who finds app.remoldcrm.com can get an account and create their own workspace (seeded with the standard objects). They cannot see Codemyvibe data (membership-scoped), but it is open sign-up on a production domain. The approved plan (M0 "workspace creation limited to owner+invitees") already targets this; it is not in place yet.
2. Interim auth is still the WorkOS staging environment with a browser-stored session (`devMode` on app.remoldcrm.com in the bundle). Disclosed by the builder; same level as the old Clerk dev mode. M1 covers it.
3. Telemetry probe runs every minute and records `unconfigured` (66 rows): `REMOLD_METRICS_PROBE_SECRET` is not set on production, so REST health probing is off. Not an error, but the alert path that would catch REST outages is inactive. Both tracked background functions show 0 failures; no open alerts or notices.
4. No security response headers on app.remoldcrm.com (no CSP, HSTS, X-Frame-Options, X-Content-Type-Options). Minor hardening item.
5. Live workspace contains only seed demo data, as the 2026-10-01 plan already notes. Nothing of value would be lost by a rollback today, but a rollback to the old Worker would also revert sign-in to Clerk dev.
6. `.env.local` key names still include `VITE_CLERK_PUBLISHABLE_KEY`, and per the 2026-10-01 plan entry `CONVEX_DEPLOYMENT` points at the old dev deployment; a careless deploy from this checkout could target the wrong backend. Values were not read.

## What I could not check

- Cloudflare Worker version id (bedaee45) and the rollback target: would need wrangler or the Cloudflare dashboard, outside the allowed tool set. The served asset names are the observable proof instead.
- The WorkOS staging redirect/CORS entries: I did not open WorkOS. The bundle, the working signed-in session, and the `/callback` 200 are the observable proof.

## Evidence files

- `01-today.png`, `02-companies.png`, `03-people.png`, `04-record-example-electric.png`, `05-settings.png` (this folder)
- Backups: `~/Documents/CodeMyVibe/Backups/remold/` (SHA256SUMS verified)
- Live bundle sha256 `3cb73426f521e1b148814c7fb1b8470f3a9467252ea257953e2f18da2b8ece77`
