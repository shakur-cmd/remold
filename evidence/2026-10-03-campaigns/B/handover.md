# Job B handover: booking pages and paid bookings

- Branch: `campaigns/booking`, based on `c5e2e6b` (Job A merged with Job C).
- Commits: `fb7ba89` (backend), `7043926` (UI and MCP), `4d6abbb` (harness, screenshots, mutants, spec), then `0e60dd8` (this handover), then one commit that only records these hashes. Final commit: `git log -1 campaigns/booking`.
- Builder: Claude Opus 5.5. Nothing here is independently verified yet. Levels: SIM (convex-test, Resend and Stripe faked) and SERVICE (local Convex backend + Vite + headless Chromium, signed Stripe webhook sent to the local HTTP router). Nothing LIVE: no deploy, no email sent, no call to stripe.com or resend.com.

## What changed

Backend
- `convex/lib/standard.ts`: standard object `bookingPage` (Booking page / Booking pages): name, description (unindexed), minutes, hours, timezone, noticeHours, daysAhead, price, paymentLink (unindexed), campaign (lookup), live. Reaches existing orgs through `seed:ensureStandard`.
- `convex/schema.ts`: additive only. Tables `bookings` and `paymentSecrets`.
- `convex/lib/bookingTime.ts` (new, pure): hours syntax, IANA zones, local time to instant (DST gaps skipped), open times, Stripe signature check, money, calendar link, Payment Link URL.
- `convex/lib/booking.ts` (new): page validation (`pageRules`), bookable page, busy times across the org, person match/create, timeline Activities, confirm, a campaign's pages, `{{bookingLink}}` approval check, campaign booking counts.
- `convex/bookings.ts` (new): public `page` and `book`; cron `expire`; `stripeWebhook` (HTTP), `secretFor`, `paid`; `mailFor` + `notify` (emails through A's `sendTransactional`); owner `forPage`, `cancel`, `paymentSettings`, `savePaymentSecret`.
- `convex/lib/applyChange.ts`: calls `pageRules` after a write.
- `convex/authority/agentGuards.ts`: agents cannot set a booking page's `live` to true.
- `convex/lib/campaignText.ts`: merge tags take an argument (`{{bookingLink:<code>}}`); `bookingLink` tag; `appUrl`, `bookingUrl`; `sameText` exported.
- `convex/lib/emailRules.ts`: approval fails if `{{bookingLink}}` has no matching page on the campaign.
- `convex/lib/campaign.ts`: report gains `bookings` and per recipient `booked`/`paid`; preview renders booking links; problem line when `REMOLD_APP_URL` is missing and an email uses a booking link.
- `convex/campaignSend.ts`: the sender passes the campaign's pages to the renderer.
- `convex/lib/intake.ts`: `matches` exported (reused for person matching).
- `convex/rateLimit.ts`: `bookingLimiter` (per page, per address).
- `convex/agentApi.ts`, `convex/http.ts`: `GET /api/v1/bookings?page=&from=&to=`; `POST /webhooks/stripe/<orgId>`.
- `convex/crons.ts`: "Expire booking holds" every minute.
- `convex/_generated/api.d.ts`: new modules registered by hand (codegen needs a deployment).

App
- `src/routes/BookingPage.tsx` (new): public `/book/<pageId>`: name, description, length, price, day picker, times in the visitor's zone (named), name/email/note, honeypot, redirect to Stripe for paid pages.
- `src/App.tsx`: `/book/...` renders outside the sign-in gate.
- `src/components/Bookings.tsx` (new): Settings "Payments" card; Bookings section on a booking page record (link, status, owner notice, list upcoming first, cancel with optional email).
- `src/routes/Settings.tsx`, `src/routes/RecordPage.tsx`: mount those.
- `src/components/CampaignEmails.tsx`: funnel page shows Bookings, Paid, Revenue (when there are bookings) and Booked/Paid per recipient.

Agents
- `packages/mcp/src/client.ts`, `index.ts`: `remold_bookings`, and a booking page recipe in the server instructions.
- `docs/spec/agents-v1.md`: booking pages amendment (hours syntax, guard, REST, report fields).

Tests and proof
- `convex/bookings.test.ts` (new, 25 tests). `convex/identity.test.ts`: standard list now ends with `bookingPage`. `packages/mcp/src/client.test.ts`: one new test.
- `ops/authority/inventory.json` (15 rows, via `inventory-rows.mjs`), `ops/authority/inventory.test.ts` (new cron name).
- Evidence here: `baseline.txt`, `fail-before.txt`, `pass-after.txt`, `after.txt`, `flake.txt`, `mutants.mjs` + `mutants.txt`, `inventory-rows.mjs`, `ui-harness.mjs` + `service-run.json`, screenshots.

## Decisions and why

1. **Status values.** `held | confirmed | cancelled` as the brief says, plus `cancelReason` (`expired` or `cancelled`) so a lapsed hold and an owner cancel are told apart. A free booking is inserted and confirmed in the same transaction.
2. **Slot recheck = full recompute.** `book` recomputes open times for that instant inside the mutation, so hours, notice, horizon and every busy source apply again; Convex serializes the transaction, so a race has one winner (tested in convex-test and against the real local backend: 3 racers, 1 confirmed).
3. **Busy sources** are org-wide: confirmed bookings, holds whose `holdUntil` is in the future (a lapsed hold frees its time at once, before the cron runs), and Activities of type meeting with a timed `when`, taken to last the page's length. Meetings that a booking wrote itself (`source: booking`) are skipped because the booking row already covers them; otherwise a cancelled booking would keep blocking its time. All-day meetings (date only, no time) do not block; there is no honest length for them.
4. **Time zones** use `Intl` in the Convex runtime. Confirmed working in the real local runtime (SERVICE check: 290+ slots all inside New York hours). A local time that does not exist (spring forward) is never offered; one that happens twice (fall back) is the first.
5. **"Link to the campaign"** is the booking's `campaignRecordId` (from the send token, else the page's campaign), shown in the report. I did not add the person to the campaign's People: that would make them a recipient of future campaign emails without consent.
6. **Person matching** reuses intake's exact email match; an existing Person is never changed (tested by comparing the whole record before/after). A new Person is created as the owner with actor `automation: Booking page`.
7. **Honeypot** (`website` field): returns `{ status: "confirmed" }` and writes nothing, so bots learn nothing.
8. **Rate limits**: 20 bookings a minute per page, 3 an hour per address per org, and the org daily cap `REMOLD_BOOKING_DAILY_CAP` (plain digits only; missing, 0 or `1e3` means 0, and then every page shows "This page is not taking bookings.").
9. **Public query** returns exactly `open, name, description, minutes, price, paid, slots`; a closed page returns only `{ open: false, message }`. Any other record id, garbage, a deleted, non-live or read-only page all look the same. Signed-in members of the org also get `notice` when email sending is not set up; visitors never do.
10. **Emails** go through A's `sendTransactional` (its gates, daily counts, bounce refusal). A's helper has no attachments, so the booker gets a Google Calendar add link, not an .ics. Time is in the booker's zone (sent by the page; falls back to the page zone). The owner notice goes to the org reply-to address, else the owner's email.
11. **Stripe**: secret per workspace in `paymentSecrets`, read only by an internal query; `paymentSettings` returns only `{ webhookUrl, secretSet }`. Must start `whsec_`; empty removes it. No secret or unknown org: 503. Bad, missing or stale signature (>300 s), or another org's secret: 400, nothing written. Only `checkout.session.completed` with `payment_status: paid`, a string `client_reference_id` and integer `amount_total` reaches the database. Unknown token or a token from another org: 200 and nothing written (Stripe would retry a non-2xx forever). Dedupe by `webhookEvents` (`stripe`, `<orgId>:<eventId>`), plus a booking that already has `paidAt` ignores a second event id for the same payment.
12. **Paid after the hold lapsed**: if the time is still free it is confirmed; if it was taken (or the owner had cancelled), the booking stays `cancelled`, keeps `paidAt`/amount, gets `attention`, and an agent inbox item (audience org, source `booking`) asks the owner to rebook or refund. It shows in the app inbox (tested).
13. **Payment Link URL** adds `client_reference_id=<token>&prefilled_email=<email>` with `URL.searchParams`, so links that already have a query string stay valid.
14. **Validation** runs in `applyChange` for every path (app, agent, adopted suggestion) but only on fields that changed, so an old page with a now-invalid value can still be edited elsewhere. A live page needs hours and a timezone. Minutes 5..480, notice 0..720 h, days ahead 1..365, price ≥ 0.
15. **`{{bookingLink}}`**: the campaign's oldest page; `{{bookingLink:<code or id>}}` a named one. Approval fails if no such page is on the campaign. If `REMOLD_APP_URL` is unset the email gets a waiting problem instead of sending broken links.
16. **Agents** use the generic record tools for pages. An agent's proposal to set `live` true is refused at proposal time, the same as posts and emails. `GET /api/v1/bookings` lists bookings on pages the key can read; person, name and email are null unless the key can read the person and that field. No default time window (all bookings, max 500, by start).
17. **Cancel** (owner) marks cancelled, writes an "Cancelled: ..." Activity (type other), and optionally emails the booker. It does not refund anything.
18. Not added: a `scheduled bookings:notify` row in the authority inventory. That list is hard-coded to existing targets and A did not add its own either; the notify action has an ordinary inventory row.

## New environment variables (Convex deployment)

| Name | Meaning | Missing |
|---|---|---|
| `REMOLD_BOOKING_DAILY_CAP` | bookings per workspace per UTC day, plain digits | 0: every page shows "This page is not taking bookings." |
| `REMOLD_APP_URL` | already existed (reminders); app origin for `/book/<id>` links in emails | `{{bookingLink}}` emails wait with a problem line |
| `CONVEX_SITE_URL` | built in; used for the Stripe webhook URL shown in Settings | |

Email confirmations use A's variables (`RESEND_API_KEY`, `REMOLD_SENDER_DOMAINS`, `REMOLD_CAMPAIGN_DAILY_CAP`, `RESEND_WEBHOOK_SECRET`). The Stripe signing secret is not an env var; each admin pastes their own in Settings.

## Fail before, pass after

All 25 booking tests were written first and run on the base code: 25/25 failed (`fail-before.txt`; a throwing stub stood in for the not-yet-written pure module so each test reported on its own). The MCP test failed with `client.bookings is not a function`. After: 25/25 and 6/6 pass (`pass-after.txt`). Done-when coverage by test name (`convex/bookings.test.ts`):

- Hours, zone, notice, horizon: "follow the page's hours in its own zone, after the notice and within the horizon".
- DST change week: "keep 09:00 local across the end of daylight saving time" (13:00Z Friday EDT, 14:00Z Monday EST; spring-forward gap never offered).
- Existing bookings, holds on any page in the org, meeting Activities: "leave out confirmed bookings and live holds on any page in the workspace, and timed meetings".
- Held booking expires and frees the slot: "a payment hold frees its time after 30 minutes, and the cron marks it expired".
- Two concurrent bookings, exactly one: "two people racing for one time: exactly one gets it" (also SERVICE, 3 racers).
- Non-live page and missing cap refuse (also deleted, read-only, zero and `1e3` cap): "a page that is not live, deleted, in a read-only workspace, or without a daily cap takes no bookings"; daily cap reached: "stops at the workspace's daily cap"; times outside the rules: "refuses a time that is not open".
- Existing Person never modified: "links an existing person by email without changing them, and creates a new one otherwise".
- Stripe bad signature, stale timestamp, other org's secret, unknown client_reference_id, unpaid, no secret (503): "a webhook with no secret, a bad signature, a stale time or another workspace's secret writes nothing".
- Valid paid event confirms once even if delivered twice: "a paid event confirms the booking once, with the amount from the event, even when delivered twice".
- Paid after expiry with the slot taken: "paid after the hold ran out and the time was taken: stays paid and asks the owner"; slot free: "paid after the hold ran out with the time still free: confirmed".
- Public queries expose nothing beyond the page: "the public page shows only what the visitor needs".
- Agents cannot set live: "agents draft and edit pages and may take one down, but only a person publishes".
- bookingLink attribution into the campaign report (REST and app): "{{bookingLink}} carries the send, and the booking and payment show up in the campaign report"; named page and refusal: "{{bookingLink:<ref>}} picks one of several pages; a link with no page refuses approval".
- seedStandard idempotent: "new workspaces get Booking pages, and the migration adds them to an older workspace once".
- Also: page validation, honeypot, confirmation emails (booker time in their zone, calendar link, owner notice), owner-only notice, write-only secret and admin-only card, owner list and cancel, agent REST listing with read scopes.

Can the tests fail? `mutants.mjs` breaks 20 rules one at a time (notice, horizon, zone, busy, expired holds, meetings, recheck, live, cap, read-only, person untouched, signature, stale time, other org, unpaid, paid-when-taken, agent publish, send attribution, public leak, honeypot). 20/20 caught (`mutants.txt`).

## Full suites (`after.txt`; baseline in `baseline.txt`)

- `pnpm test`: 412 tests (baseline 387; +25). With default workers two older tests time out under load: gmailSync "newest past activity" (5 s limit) and "follows a page that is not done ... without resubscribing" (15 s). Base code `c5e2e6b` fails the same two the same way (`flake.txt`), and the gmailSync test takes the same ~2.4 s alone on base and on this branch. `pnpm exec vitest run --maxWorkers=3`: 52 files, 412 passed.
- `pnpm typecheck`: exit 0
- `pnpm test:authority`: 17 files, 101 passed
- `pnpm verify:release`: 37/37 pass
- `pnpm build`: built
- `pnpm --dir packages/mcp test`: 6 passed

## SERVICE run and screenshots

`ui-harness.mjs` (scratch copy, anonymous local Convex backend, Vite, headless Chromium; sign-in replaced by a self-signed JWT, and a "visitor" browser context has no sign-in). `RESEND_API_KEY` unset, so nothing can send. All 14 checks passed (`service-run.json`): public page keys, open times inside New York hours in the real runtime, notice, 3-way race, paid hold redirect, webhook 503 before a secret, 400 for a wrong key and a stale time, 200 for a signed paid event and its replay, booking confirmed with $5.00, report counts, visitor sees no owner notice, card never shows the secret.

- `booking-page-desktop.png` (visitor, Chicago), `booking-page-form.png`, `booking-page-booked.png`
- `booking-page-phone.png` (390 px, Los Angeles, paid page), `booking-page-closed-phone.png` (page turned off)
- `settings-payments-card.png`
- `booking-page-record.png` (owner: notice, paid and waiting bookings), `booking-page-owner-notice.png` (public page seen by a member)
- `campaign-funnel-bookings.png` (Bookings 4, Paid 1, Revenue $5.00)

The browser logged six 403 resource loads (A's run logged the same kind); I did not track which requests they were. Pages rendered and worked. On desktop the day row scrolls sideways, so the last visible day is cut at the edge.

## Rollback compatibility

Additive: two new tables, one new standard object through metadata. This release runs on data written by the previous one.

The previous release (`c5e2e6b`) does not declare `bookings` or `paymentSecrets`. As with Job A, pushing its schema should fail once either table has rows. Rollback then needs either `c5e2e6b` plus these two table declarations (schema only), or emptying both tables first (loses bookings and the saved secret; check with Shakur). Booking page records are ordinary records and the old code shows them as a normal object. Not exercised.

## Owner setup to go live (none of this was done)

1. Convex env: `REMOLD_BOOKING_DAILY_CAP` (for example 20) and `REMOLD_APP_URL=https://app.remoldcrm.com`. Deploy only with `pnpm deploy:prod`; existing orgs get Booking pages via `seed:ensureStandard`.
2. For confirmation emails: Job A's Resend setup and the Email sending settings.
3. Create a booking page: hours, timezone, length; for paid, a Stripe Payment Link (in Stripe, one link per price; no redirect change needed). Turn Live on.
4. Stripe: Developers > Webhooks > add endpoint at the URL in Settings > Payments, event `checkout.session.completed`; paste its signing secret in the card.
5. Book yourself once (free), then once paid with a Stripe test-mode link, and check the timeline, both emails and the campaign report.

## Left undone or uncertain

- No live Stripe event. The event shape (`data.object.client_reference_id`, `payment_status`, `amount_total`, `currency`) and the signature scheme come from Stripe's documented format, checked against my own signer, not a real delivery.
- No .ics attachment (A's helper sends text only); Google Calendar link instead.
- The public `page` query uses `Date.now()`; Convex caches queries, so an open tab can show a time that has since passed its notice. Booking re-checks and answers "taken".
- `webhookEvents` grows without cleanup (same as A).
- Refunds are manual in Stripe; Remold never moves money.
- A booking's Activity is written once; editing a page's name later does not rename past Activities.
- Codegen in `convex/_generated/api.d.ts` was done by hand.
- The two pre-existing load timeouts above.

## Round 2 (after independent verification REVISE on c1bea0d)

Verifier: Claude Fable 5.1 (`~/work/briefs-1003/iv-B-verdict.md`). Builder: Claude Opus 5.5. Not re-verified yet. Levels: SIM (convex-test) and SERVICE (local backend, 18/18 checks). Nothing LIVE.

Commits: `118e729` merges `origin/integ/campaigns` (ab5d59b), then `f7c56c9` (round 2 fixes and this section), then one commit recording these hashes. Final: `git log -1 campaigns/booking`.

### Merge with integ/campaigns (ab5d59b)

- Conflicts resolved in `convex/agentApi.ts`, `convex/campaignSend.ts`, `convex/lib/applyChange.ts`, `convex/lib/campaign.ts`, `convex/lib/emailRules.ts`, `ops/authority/inventory.json` and the three MCP files. Their side won wherever it changed the email flow. My additions went back in on top.
- `{{bookingLink}}` renders inside the payload composed once at claim (`campaignSend.ts`, `pages` from `linksOf`). Uncertain retries reuse the stored bytes as before.
- `contentVersion` is now async and also covers the page each `{{bookingLink}}` names (`linksOf` in `lib/campaign.ts`, `linkedPages` in `lib/booking.ts`). Pointing a link at another page after approval shows "The email or the sending settings changed since approval" (test "pointing the link at a different page after approval needs approval again").
- `pageRules` still runs after the event insert in `applyChange`, after their withdraw step.
- `ops/authority/inventory.json`: their file plus my rows via `inventory-rows.mjs`. A check against both parents finds no lost id (270 ours, 258 theirs, 273 merged), and 275 after round 2 adds two rows.
- After the merge, before any fix: `--maxWorkers=3` 54 files / 480 tests pass; authority 101/101 (one run had two 5 s timeouts at load 12; three reruns pass); my 20 mutants 20/20 (`mutants-after-merge.txt`). My two attribution tests now approve with the preview `version`, like campaigns.test.ts.

### Fixes (coordinator decisions)

1. **Underpay and currency.** New page field `currency` (select, empty = usd). When a visitor is held, the booking stores `expectedMinor` (price in minor units; zero-decimal currencies such as jpy and krw are whole units) and `expectedCurrency`. A paid event confirms only in that currency and for at least that amount. Otherwise the booking keeps `paidAt` and the real amount, is cancelled with `cancelReason: "underpaid"`, and gets an `attention` line such as "Paid $1.00, but the page asks for $100.00" plus an inbox item, and the time opens up again. `checkout.session.async_payment_succeeded` is handled like a paid `completed` event. `async_payment_failed` ends the hold (`cancelReason: "payment failed"`). `livemode` is stored. The owner's list marks test payments "(test)", and the Payments card says to use the live mode secret.
2. **Stale booking link.** `stateOf` adds a problem when a `{{bookingLink}}` names no page on the campaign ("... names no booking page on this campaign") or a page that is not live ("The booking page for {{bookingLink}} is not live"). Sending waits and the problem shows on the campaign page. Approval still needs only that the page exists, so an email can be approved before its page goes live.
3. **Spam.** Every `book` call takes the per-page token before `isOpen`, so probing closed times costs a token too. The daily cap counts confirmed bookings only: a free booking takes from it when confirmed, a paid hold only checks it (`limiter.check`), and the Stripe confirmation takes from it. At most 3 unpaid holds per page and 1 per address in the workspace (new indexes `by_page_hold`, `by_email_hold`), answered with `limited` and the seconds until the oldest of those holds runs out. The webhook takes a token per path org id (60 a minute, 429 beyond) before any lookup.
4. **openSlots.** It uses a Set. A day with no clock change uses one offset for all its times, so the time zone is looked up twice a day instead of three times a slot. `isOpen` computes only the days around the chosen time. The largest legal page (5 minutes, 24/7, 365 days, New York) took 10.8 s before and about 0.3 s after (test bound 1 s).
5. **Honeypot.** The input is named `x_hp7` with no label, `autocomplete="off"`, password-manager ignore attributes, `tabIndex -1`, inside an `aria-hidden` box off screen. A filled honeypot now gets the neutral error "We could not book this time. Please try again." and nothing is written. The mutation argument is now `hp`. The SERVICE harness checks the rendered attributes.
6. **The verifier's four surviving mutants now fail tests:** cross-org send token (verifier's test adopted), line breaks in the name, an invalid visitor zone, and a payment for an owner-cancelled booking. Also adopted: the verifier's Sydney, Kolkata, Adelaide and Lord Howe tests, the Stripe signature edge cases, and the cross-org campaign lookup check. Their UNDERPAY, holds-eat-the-cap, probing and stale-link tests are inverted, since those are now fixed.
7. **Notes.** `instantOf` now tries the offsets a day either side and returns the earliest match, so a repeated local time is its first instant east and west of UTC (Sydney 5 Apr 02:30 = 15:30Z). The comment says so. `money()` handles zero-decimal currencies (¥500, ₩1,050).

### Decision that departs from the instruction: person lookup

The coordinator asked that `matches()` use the email index. `matches()` is website intake's function, and intake has a verified test that matches a person stored as `"Shakur@X.com "` (other case, trailing space). It also matches phones written different ways. Slot indexes hold values exactly as typed, so no index can answer those lookups. So:
- **Booking** (`personFor`) now looks the address up through the Email field's slot index, lowercased and as typed: no scan. A person stored with the same address in other letter case is not matched, so a second Person is made and the old one is untouched. A test states this.
- **Intake** keeps its scan, unchanged.
If exact case-insensitive matching at scale matters, the next step is a normalized key kept on write (for example a small `contactKeys` table filled through applyChange, plus a backfill). I did not build it.

### Fail before, pass after

- `round2-fail-before.txt`: 13 of the new or changed tests fail on `118e729`: honeypot, seed field count (currency), first-instant, the largest-page bound (10838 ms), underpay, other currency, jpy, async payments, probing, cap counts holds, holds per page/address, webhook rate limit, person case.
- Six round 2 tests already passed there: the gate came with the merge, and the four guards existed but had no test. Their proof is the mutant run: switching each rule off fails them (cross-org token, line breaks, visitor zone, paid-after-cancel, stale link gate, pages in the content version).
- `round2-pass-after.txt`: 45/45.
- Mutants (`mutants.txt`, `mutants.mjs`): 40/40 caught. That is the 20 from round 1 (five updated to the rewritten code) and 20 new: the 4 verifier survivors plus 16 round 2 rules.

### Suites (`round2-after.txt`)

- `pnpm exec vitest run --maxWorkers=3`: 54 files, 500 passed.
- `pnpm test` with default workers, load 7 to 9: 495/500. All 5 failures are timeouts in older tests: gmailSync "last contact", record paging "follows a page ... without resubscribing", and three posts/calendar paging tests. None are in the booking or campaign files. The same kind failed on base before (`flake.txt`). Use `--maxWorkers=3` or a quiet machine.
- `pnpm typecheck`: exit 0. `pnpm test:authority`: 101/101. `pnpm verify:release`: 37/37. `pnpm build`: built. `pnpm --dir packages/mcp test`: 9/9.

### SERVICE (`service-run.json`, 18/18)

The round 1 checks plus: public keys now include `currency`; an underpaid signed event ($1.00 on a $5 page) is kept as paid, not confirmed, with attention; another hold is untouched; the report counts 4 booked, 2 paid, $6.00 (an underpaid booking counts as booked and paid, since money came in and needs a decision); the honeypot's rendered attributes. Screenshots were refreshed. `booking-page-record.png` shows the underpaid row and "(test)" payments. The browser again logged six 403 resource loads I did not trace.

### Rollback

Still additive: optional booking fields (`livemode`, `expectedMinor`, `expectedCurrency`), two new indexes, a `currency` field added through `seed:ensureStandard`. Same rollback note as round 1, now against the merged base.

### Left undone or uncertain (round 2)

- No real Stripe delivery. The `async_payment_*` shapes and `livemode` follow Stripe's documented events; I did not observe them live.
- The public `page` query still computes open times on every load and cannot be rate limited (queries cannot write). It is now about 0.3 s for the worst legal page and much less for normal ones.
- `busy.some` is still linear per slot. A page with thousands of bookings and meetings in its horizon would be slow; I did not measure that.
- An underpaid booking cannot be "topped up". The owner refunds or rebooks by hand.
- Booking does not match a person stored with a differently cased email (see the departure above).

## Round 3 (after independent verification round 2, REVISE on 7d90bbd)

Verifier: Claude Fable 5.1 (`~/work/briefs-1003/iv-B2-verdict.md`). Builder: Claude Opus 5.5. Not re-verified yet. Levels: SIM (convex-test) and SERVICE (local backend, 21/21 checks). Nothing LIVE.

Commits: `c40182f` merges `origin/integ/campaigns` (f94e828: views, automations, shape lifecycle), then `82de93a` (round 3 fixes and this section), then one commit recording hashes. Final: `git log -1 campaigns/booking`.

### Merge with integ/campaigns (f94e828)

- 14 conflicted files, all resolved by keeping both sides. Standard objects now end `email, automation, bookingPage`.
- Re-checked after the merge: both agent guards sit side by side in `agentGuards.ts` (`live` true refused for agents; their automation `on` refused). `pageRules` runs after the event insert and before their `automationAfter`, so a bad page write is refused before any automation fires. The booking guard tests and mutants pass.
- Campaign report: their `visibleTitle` shape, with `bookings` and per-recipient `booked`/`paid` added on top.
- `ops/authority/inventory.json`: their file plus my rows. A check against both parents finds no lost id (275 ours, 290 theirs, 307 merged), and 308 after adding `bookings:resolve`.
- **Pre-existing defect on their side, fixed here:** `packages/mcp/src/index.ts` at f94e828 does not compile. The automation recipe puts unescaped `"` inside the double-quoted instructions string; `tsc` fails at column ~2009 in a clean base worktree. The MCP server could not start. I made that one string a template literal, with no wording change. `pnpm --dir packages/mcp build` now exits 0. Their MCP tests passed before because vitest does not type-check `index.ts`.

### Fixes (coordinator decisions)

1. **Currency (blocker).** A `paymentLink` without a `currency` is refused when a page is created and whenever either field changes: 400 "Choose the currency your Stripe Payment Link charges in". This holds in the app and for agents, since both go through `pageRules` in `applyChange`. Pages saved earlier with no currency keep working. Their holds store `expectedPrice` (major units), and payment is checked in the event's currency and minor units (€5.00 confirms; ¥499 on a ¥500 page needs a decision). Pages with a currency store `expectedMinor` and `expectedCurrency` as in round 2. The MCP recipe now says the currency is required with a link.
2. **Automations.** The automation definition check refuses any write of `bookingPage.live` (true or false, by `updateTrigger` or `createRecord`) with "automations cannot publish or take down a booking page; a person does that". Booking statuses live in the `bookings` table, which automations cannot address: an `updateTrigger` on `status` is "unknown field" and a `createRecord` on `bookings` is refused. Both are tested.
3. **Rebooking.** An address with an unexpired hold (one not waiting on a decision) gets that hold back. Choosing a time moves the hold there: same token and payment link, page and price updated, 30 minutes renewed, the old time freed. Choosing the same time just renews it. They are never locked out by their own hold, and an address still never holds two times. The round 2 test "1 per address" now expects the move instead of `limited`, by decision.
4. **Attention keeps the time.** A short or wrong-currency payment, including a promotion code, keeps the booking `held` with no expiry (`holdUntil` max) and `attention`, so nobody books over it. A payment whose time was lost or whose booking the owner cancelled stays `cancelled` with `attention`. Admins see **Confirm anyway** and **Release** on the booking page; members see neither, and the server refuses them.
   - Confirm anyway needs the time free ("That time is taken now. Release it and rebook them.") and counts toward the daily cap.
   - Release frees the time and says to refund in Stripe.
   - Each decision writes a timeline Activity in the admin's name: "Confirmed anyway by …: <reason>" or "Released by …, refund in Stripe: <reason>".
   - The inbox text now reads "On the booking page, confirm it anyway, or release it and rebook or refund them."
5. **Promotion codes.** The Payments card says that discounted payments wait on the booking page and the owner confirms them with Confirm anyway. Agent spec Round 3 note too. Tested end to end.
6. **Webhook.** `hookToken` normalizes the id and checks the org exists before touching the limiter. Unknown, malformed or other-table ids answer 503 and write nothing; 130 such requests never reach 429.

Also: the verifier's machine-dependent mutant ("no steady-day fast path") is now caught by a check that counts time zone lookups (under 5000 for the largest legal page), alongside the 1 s bound. The early return for "same time again" turned out redundant (its mutant survived because the move path gives the same answer), so I deleted it.

### Fail before, pass after

- `round3-fail-before.txt`: 9 new tests, 9 failing on `c40182f`.
- `round3-pass-after.txt`: 54/54.
- `mutants.txt`: 53/53 caught (run in three foreground slices at low load). My earlier background run was cut off by a session limit and left `bookingTime.ts` mutated (`[...out].includes`). I found it by checking every mutant's text against the sources, restored it (the file is identical to the committed version), and re-ran everything. Seven round 2 mutant targets were updated to the round 3 code. "No limit on holds per address" was dropped, because a second hold per address no longer exists; "another time adds a second hold" covers it.

### Suites (`round3-after.txt`)

- `pnpm test` (default workers, load 4 at start): 616/620. `--maxWorkers=3`: 617/620. Every failure is a timeout in files this job does not touch (gmailSync, automations, posts paging, Calendar drag), and which tests fail changes from run to run. Those files alone with one worker: base f94e828 and this branch both pass (54/54 and 31/31). At load 11 to 15, base failed the same automations and gmailSync tests. My branch was somewhat slower on the automations caps test then (7.2 vs 6.6 s, 7.9 vs 5.3 s), probably because every new workspace now also seeds the Booking page object and its 12 fields.
- `pnpm typecheck`: exit 0. `pnpm test:authority`: 101/101. `pnpm verify:release`: 37/37. `pnpm build`: exit 0. `pnpm --dir packages/mcp build`: exit 0. `pnpm --dir packages/mcp test`: 10/10.

### SERVICE (`service-run.json`, 21/21)

New checks: an underpaid booking keeps its time; the same address picking its own time again gets its payment link back; an admin sees Confirm anyway and Release. `booking-page-record.png` shows "Needs your decision" with both buttons and the Currency field. The six 403 resource loads are still untraced.

### Rollback

Still additive: optional `expectedPrice` on bookings, nothing else in the schema. Same caveat as before about the previous release's schema and the new tables.

### Left undone or uncertain (round 3)

- No real Stripe delivery.
- An attention hold never expires on its own. If nobody decides, the time stays blocked; the inbox item is the only nudge.
- Rebooking moves a hold even across pages and renews its 30 minutes. Each move costs a per-page token and a per-address token (3 an hour), which bounds how long one address can keep a time.
- Underpaid bookings still count as "booked" in the campaign report (money arrived).
- The full suite on a busy machine times out in older tests; run it on a quiet machine or per file.

## Round 4 (after independent verification round 3, REVISE narrow on ccb7af5)

Verifier: Claude Fable 5.1 (`~/work/briefs-1003/iv-B3-verdict.md`). Builder: Claude Opus 5.5. Not re-verified yet. Levels: SIM (convex-test) and SERVICE (local backend, 21/21). Nothing LIVE.

Commits: `95ce56a` merges `origin/integ/campaigns` (907d000: work queue, onboarding map, blueprints), then `5b86c51` (round 4 fixes and this section), then one commit recording hashes. Final: `git log -1 campaigns/booking`.

### Merge with integ/campaigns (907d000)

- Four conflicts: `standard.ts` and `Settings.tsx` imports (kept both), `packages/mcp/src/index.ts` (their template-literal instructions with my booking recipe sentence appended), and `ops/authority/inventory.json`. The inventory is their file plus my rows; a check against both parents finds no lost id (308 ours, 310 theirs, 328 merged).
- **One of their tests changed by the merge:** `convex/agentMap.test.ts` "lists the standard features that exist and the agent can read" asserted `not.toContain("bookingPages")`. That was true on integ, where booking pages did not exist yet. After the merge it fails on behavior, not a timeout (330 ms): the map's own `FEATURES` already names `bookingPage`, so the feature now correctly appears. The test now expects it, and also checks that a key that cannot read Booking pages does not see it.

### Fixes (coordinator decisions)

1. **No renewing.** A moved or renewed hold keeps its original `holdUntil`; moving changes page, time and price but never the expiry. The verifier's squatting probe is adopted: renewing every 25 minutes still lets the hold run out 30 minutes after it was made, and over six hours of renewals no hold lives longer than 30 minutes.
2. **One question at a time.** An address with a hold waiting on the owner's decision cannot open another hold: "Your earlier payment is waiting for the owner to look at it. They will be in touch."
3. **No legacy fallback.** Booking pages are new in this release, so the no-currency path is gone (`expectedPrice` removed from the schema; it was never released). A page with a payment link always has a currency (`pageRules` on create and change, including clearing it). A page that somehow has a link but no currency takes no bookings. The payment's currency must match.
4. **Release leaves revenue.** The campaign report's `bookings` is now `{ booked, paid, revenue, released, refundDue }`. A released payment is not booked, paid or revenue; it counts in `released`, and its amount in `refundDue`. The payment fields on the booking and the "Paid …" and "Released by …, refund in Stripe" timeline entries stay. The funnel page shows "Refund due" when there is one.

### Fail before, pass after

- `round4-fail-before.txt`: 6 failing on `95ce56a` (the four round 4 tests, the no-currency page test, and the report shape in the attribution test). The clearing-currency check already passed: round 3's rule covers currency changes.
- `round4-pass-after.txt`: 58/58.
- `mutants.txt`: 56/56 caught (foreground, four slices, load ~1). That includes five new round 4 mutants and the updated currency targets; the two legacy-path mutants are gone with the path. "No steady-day fast path" is caught here (1 failing, via the time zone lookup count). The verifier saw it survive on their machine at ccb7af5, and I cannot explain the difference.

### Suites (`round4-after.txt`)

- `pnpm test` (default workers, load ~3.5): 714/718. Three are the usual timeouts in files this job does not touch (gmailSync, records and posts paging). The fourth was the agentMap assertion above.
- After updating it, `pnpm exec vitest run --maxWorkers=3`: 66 files, 718/718.
- `pnpm typecheck`: exit 0. `pnpm test:authority`: 101/101. `pnpm verify:release`: 37/37. `pnpm build`: exit 0. `pnpm --dir packages/mcp build`: exit 0. `pnpm --dir packages/mcp test`: 12/12.
- SERVICE `service-run.json`: 21/21. The six 403 resource loads are still untraced.

### Left undone or uncertain (round 4)

- Confirm anyway has no "time already passed" check, so an admin could confirm a past slot (verifier note; not decided, not changed).
- Attention holds still never expire on their own.
- No real Stripe delivery.

## Round 4 (registry merge)

`cf00702` merges `origin/integ/campaigns` (3b9f8a8: hosted `/mcp` and one shared tool registry in `packages/mcp/src/tools.ts`; `RemoldClient` removed). Builder: Claude Opus 5.5. Not re-verified yet.

- Conflicts: `convex/http.ts` (both imports kept), and the three MCP files, where integ's side wins. My client method and old client test are gone with `RemoldClient`.
- Ported into `tools.ts`: `remold_bookings` (optional `page`, `from`, `to` strings; `GET /bookings`), the booking pages sentence at the end of `instructions`, and the campaign report description now names its booking fields (bookings, paid bookings, revenue, refunds due, per-recipient booked and paid). Both stdio and hosted `/mcp` serve them from the registry.
- Tests, failing first (`round4-registry-fail-before.txt`):
  - `packages/mcp/src/client.test.ts`: the stdio route through `callTool` and `httpSend`, plus a bad argument type refused, plus the report description.
  - `convex/mcp.test.ts`: a real booking in convex-test, then `remold_bookings` over hosted Streamable HTTP and over the stdio server (in-memory), with the same result for four argument sets (all, page with day range, empty future, invalid date as a tool error).
- Inventory: no conflict. A check against both parents finds no lost id (328 ours, 311 theirs, 329 merged, no duplicates).
- Suites (`round4-registry-after.txt`): `pnpm test` default workers 730/734 (load timeouts in gmailSync, automations caps and posts paging, plus the flake below). `--maxWorkers=3` 733/734 (gmailSync timeout only). `pnpm typecheck` exit 0, `test:authority` 101/101, `verify:release` 37/37, `pnpm build` exit 0, `pnpm --dir packages/mcp build` exit 0, `pnpm --dir packages/mcp test` 15/15, `convex/mcp.test.ts` 15/15, `convex/bookings.test.ts` 58/58.
- **Pre-existing flake in integ's test:** `convex/mcp.test.ts` "shares the REST write rate limit with the agent's key" fails when run alone (`-t`), 3 of 3 times on this branch and 3 of 3 on base 3b9f8a8, and passes as part of its file on both. It takes 120 tokens from a real-clock 120-a-minute bucket, which refills during a slow cold run. I did not change it.
