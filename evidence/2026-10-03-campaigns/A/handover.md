# Job A handover: campaign email (send, track, reply, follow up)

- Branch: `campaigns/email`, based on `cc9ed1c` (code identical to `371a62c`; the worktree started at 371a62c and was moved to cc9ed1c, which only adds the briefs).
- Commits: `feb6036` (all code, tests and evidence), then one commit that only records this hash here. Final commit: `git log -1 campaigns/email`.
- Builder: Claude Opus 5.5. Nothing here is independently verified yet. Level: SIM (convex-test with Resend mocked) and SERVICE (local Convex backend for screenshots and the authority sweep). Nothing LIVE: no deploy, no real email, no calls to resend.com.

## What changed

Backend
- `convex/lib/standard.ts`: new standard object `email` (subject, body, campaign, followsUp, waitDays, sendTo, sendAt, status). Indexed: subject, campaign, followsUp, waitDays, sendAt, status. Unindexed: body, sendTo.
- `convex/schema.ts`: additive only. `orgs.emailSettings` (optional), tables `emailRuns`, `emailSends`, `emailCaps`, `webhookEvents`.
- `convex/lib/emailRules.ts` (new): the approval check, called from `applyChange` for Email records on every path (app, adopted suggestion, API).
- `convex/lib/applyChange.ts`: two calls to `emailRules` (after write, and after delete).
- `convex/authority/agentGuards.ts`: agents cannot approve an email, change an approved/sending/sent one, or set a campaign to active. They may always set an email to stopped.
- `convex/lib/campaignText.ts` (new, pure): merge tags (extensible registry), rendering, HTML, footer, env checks and checklist, Svix verification, reply extraction, the Resend POST.
- `convex/lib/campaign.ts` (new): recipients and exclusions, gate problems, daily counters, timeline Activities and Notes, consent suppression, mark replied, report and preview (with read scopes).
- `convex/campaignSend.ts` (new): the sender (cron tick, claim, begin, finish), webhook, inbound replies, unsubscribe pages, and the one-off send seam for Job B.
- `convex/campaigns.ts` (new): app functions `settings`, `saveSettings`, `report`, `preview`, `approve`, `markReplied`.
- `convex/agentApi.ts`, `convex/http.ts`: `GET /api/v1/campaigns/<idOrRef>/report`, `GET /api/v1/emails/<idOrRef>/preview?person=`, `POST /api/v1/sends/<id>/replied`; `POST /webhooks/resend`; `GET|POST /u/<token>`.
- `convex/crons.ts`: "Campaign email" every minute.
- `convex/fields.ts`: Email body, campaign, followsUp and status cannot be retired.
- `convex/_generated/api.d.ts`: new modules registered by hand (codegen needs a deployment).

App
- `src/components/CampaignEmails.tsx` (new): the funnel page Emails section, Start campaign / Pause, New email, New follow-up, Approve dialog, Stop, per-recipient table with Mark replied.
- `src/routes/RecordPage.tsx`: shows that section on campaign pages; the generic "Emails" related panel is hidden there.
- `src/routes/Settings.tsx`: "Email sending" card (admins only) with the five settings and a live checklist.

Agents
- `packages/mcp/src/client.ts`, `index.ts`: `remold_campaign_report`, `remold_email_preview`, `remold_mark_replied`, and a short campaign recipe in the server instructions.
- `docs/spec/agents-v1.md`: campaign email amendment.

Tests and proof tooling
- `convex/campaigns.test.ts` (new, 38 tests). `convex/identity.test.ts`: the standard object list now ends with `email`. `packages/mcp/src/client.test.ts`: one new test.
- `ops/authority/inventory.json` (26 new rows), `ops/authority/inventory.test.ts` (new cron name), `ops/authority/service-sweeps.mjs` (readonly and mask sweep calls for the new functions and route, plus the pre-existing missing `reminders:set` call).
- Evidence in this folder: `baseline.txt`, `fail-before.txt`, `pass-after.txt`, `after.txt`, `mutants.mjs` + `mutants.txt`, `inventory-rows.mjs`, `ui-harness.mjs`, `proof-authority-2.log`, `proof-authority-sweeps.log`, four screenshots.

## Decisions and why

1. **Approval needs an admin and a confirmation.** Any path that sets an email to approved runs the same check in `applyChange` (subject, body, merge tags, campaign, follow-up in the same campaign, no loops) and must be an admin. Sending also needs the "Everyone on this list agreed..." box, which only `campaigns.approve` records (`emailRuns.confirmed`). Approving through the plain status field is valid but leaves the email waiting with the problem "Not approved on the campaign page with the list confirmed". Reason: the brief makes the checkbox required; making it a server gate is the honest version.
2. **The webhook secret is a send gate**, not only a checklist item. Without it bounces and complaints never come back, so bad addresses would keep getting mail.
3. **Agents cannot start a campaign** (set status active). Pausing is allowed. Brief: "ask a person to approve and start the campaign".
4. **Sending and Sent are set only by the sender** (automation actor). A person picking them in the status field gets a validation error.
5. **Settings live on `orgs.emailSettings`** (optional object), saved with patch semantics; an empty string clears a value. Daily limit missing = 0.
6. **Caps** are two counters per UTC day in `emailCaps` (`<day>:<orgId>` and `<day>:all`), reserved inside the claim mutation and released when a send fails, is requeued, or is stopped before sending. Convex serializes the writes, so concurrent ticks cannot overshoot (tested with three ticks at once).
7. **Crash safety**: a claimed row gets a 5-minute lease and its attempt number; an expired lease puts it back in the queue and the retry uses the same `Idempotency-Key` (the row id), so Resend answers with the first send. A late finish from the crashed attempt is ignored. Three attempts at most.
8. **Who is excluded, org-wide**: no email, invalid, duplicate address (first person wins), a suppressed `consent` row (reason from its source: bounced, complained, unsubscribed), or any earlier send to that address in the org that was replied, bounced, complained or unsubscribed. Re-checked just before each send.
9. **Follow-ups** go per recipient once `sentAt + waitDays` has passed (default 3 days, default sendTo notReplied), so they do not wait for the whole first email to finish. Everyone who got the earlier email gets a row: queued, or skipped with the reason (opened, clicked, replied, unsubscribed...). A follow-up becomes sent when its earlier email is sent and every such person is decided.
10. **Replies without an inbound domain**: an Activity of type email whose title contains "received" (Gmail sync writes "Email received") about the person, dated after the send, counts as a reply. It is checked when a follow-up comes due and stored on the earlier send. Not checked continuously, to keep each tick small.
11. **Forwarded replies skip the daily caps** (they go to the org's own address) but need the API key and an allowed from domain. The reply still counts and is kept as a Note if forwarding is not possible.
12. **Temporary bounces are not recorded at all**; only `Permanent` sets `bouncedAt`, suppresses and adds a timeline entry. Complaints suppress but add no Activity (the brief lists Activities for sent, first click, reply, bounce, unsubscribe).
13. **Unsubscribe GET touches nothing** and returns the same page for any token; POST returns the same "You are unsubscribed" page for known and unknown tokens. Opting out works even in a read-only workspace; timeline entries are skipped there.
14. **Activities and Notes** are written through `applyChange` as the workspace owner with actor `{ kind: "automation", id: "Campaign email" }`; "Mark replied" uses the caller as actor.
15. **Report**: an unreadable campaign is 404; emails the caller cannot read are left out; a recipient appears only if the caller can read the person, and the address only if they can read the person's Email field. Counts stay whole.
16. **Seam for Job B**: `sendTransactional(ctx, { orgId, to, subject, text, replyTo?, idempotencyKey? })` in `convex/campaignSend.ts` (also `internal.campaignSend.transactional`) uses the same settings gates and daily counters, adds the postal address, refuses bounced or complaining addresses, and returns `sent | blocked | limited | failed`. Merge tags are a registry: add `mergeTags.bookingLink = (r) => ...` in `convex/lib/campaignText.ts`; `r.token` is the send token for attribution, and `badTags` accepts any registered tag.
17. Did not use the integrationOps/adapter framework, per the brief.

## New environment variables (Convex deployment)

| Name | Meaning | Missing |
|---|---|---|
| `RESEND_API_KEY` | already existed; used for campaign sends | nothing sends |
| `REMOLD_SENDER_DOMAINS` | comma list of allowed from-address domains | nothing sends |
| `REMOLD_CAMPAIGN_DAILY_CAP` | sends per UTC day for the whole deployment, plain digits | 0, nothing sends |
| `RESEND_WEBHOOK_SECRET` | `whsec_...` from the Resend webhook | webhook answers 503, nothing sends |
| `REMOLD_INBOUND_DOMAIN` | optional; replies go to `r-<token>@<domain>` | replies go to the org reply-to address |
| `CONVEX_SITE_URL` | built in on Convex; used for unsubscribe links | |

## Fail before, pass after

All new behaviour tests were written first and run on the base code: 36/36 failed (`fail-before.txt`; later additions also captured there: the retire guard and the MCP client test). After: 38/38 pass (`pass-after.txt`). Done-when coverage, by test name in `convex/campaigns.test.ts`:

- One test per gate: "sends nothing unless ..." for the API key, sender domains, from domain, webhook secret, postal address, org daily limit, deployment cap missing, deployment cap unparseable (`1e3`), campaign active, email approved, person approval with confirmation, send time. Control: "sends an approved email once to each person ...".
- Caps across concurrent ticks: "never goes past the org's daily limit, even with ticks running at once ...", "never goes past the deployment's daily cap across workspaces".
- Follow-up notOpened after waitDays, never to repliers/unsubscribed: "a follow-up for people who did not open goes after its wait, never to anyone who replied, unsubscribed or wrote back".
- Pause mid-batch: "stops the rest of a batch when the campaign is paused mid-batch ..."; stop: "an email stopped mid-batch sends nothing more".
- Crashed claim: "a claim whose sender crashed is retried with the same idempotency key after its lease, so nobody gets it twice".
- Webhook refusals and replay: "refuses a missing secret, a bad or foreign signature and a stale timestamp, writing nothing, and counts a replayed event once".
- Bounces and complaints: "a permanent bounce and a complaint suppress the address; a temporary bounce does not".
- Unsubscribe: "the unsubscribe link asks first; only the button unsubscribes, once, and an unknown link looks the same".
- Inbound reply: "a reply to the inbound address marks the send replied, keeps the reply as a note and forwards it to the org".
- Agent limits: "an agent drafts emails and may stop one, but cannot approve, start a campaign or touch an approved email".
- Merge tag validation: "checks subject, body, merge tags, campaign and the email it follows on every approval path".
- Report read scopes: "the report shows each email's numbers and gate problems, and recipients only as far as the key may read".
- seedStandard idempotent: "new workspaces get Email steps, and the migration adds them to an older workspace once".
- Also: retries, preview endpoint, mark replied endpoint, settings admin-only and secret-free checklist, reply-to without inbound domain, the one-off send seam, cron registration, retire guard.

Can the tests fail? `mutants.mjs` breaks 20 rules one at a time; 19 are caught (`mutants.txt`). The survivor makes the "deployment cap" checklist item always ok; the reserve step still refuses with a zero cap, so behaviour does not change (two independent guards). Mutation proof of that test needs both removed.

## Full suites (`after.txt`; baseline in `baseline.txt`)

- `pnpm test`: 50 files, 367 passed (baseline 329; +38)
- `pnpm typecheck`: exit 0
- `pnpm test:authority`: 17 files, 101 passed (it failed 1/101 before the inventory rows were added)
- `pnpm verify:release`: 37/37 pass
- `pnpm build`: built
- `pnpm --dir packages/mcp test`: 3 passed (not part of `pnpm test`)

`pnpm proof:authority` (optional, local backend): the full run stops at failures that are not from this job: once at `Agent inactive` vs `Stale claim` in service-agents (a run that same morning on base code, `~/scratch/c-base-service.log`, fails identically), once at `spawnSync unzip ENOBUFS` (`proof-authority-2.log`, 50 PASS before it). Run with `I1_SUITES=sweeps`: "Readonly workspace refuses every public human write and every agent REST write" now PASSES with the new campaign writes and the new REST route; the mask sweep then stops on 11 public queries that already lacked sweep calls before this job (`events:timeline`, `records:inRange`, `today:posts`, `invoices:*`, `reminders:mine`, ...). I added sweep calls for my three new public queries but did not fill the older gaps.

## Screenshots (SERVICE, local backend, SIM send data)

Taken by `ui-harness.mjs`: scratch copy, anonymous local Convex backend, Vite, Chrome headless, sign-in replaced by a self-signed JWT. `RESEND_API_KEY` and the deployment cap were unset, so the cron could not send. Send rows on the first email are a fixture.
- `settings-email-card.png`: the Email sending card with the checklist (API key and cap missing, shown as such).
- `campaign-emails.png`: Emails section with numbers and the per-recipient table.
- `campaign-page.png`: the whole funnel page.
- `approve-dialog.png`: Approve dialog: count, left out with reason, preview for one person, what still blocks sending, the required checkbox.
The browser logged two 403 and one 404 resource loads during the run; I did not track down which requests they were. The pages rendered and worked.

## Rollback compatibility

Schema changes are additive (one optional field on `orgs`, four new tables), so this release runs on data written by the previous one.

The other direction is not free, and I did not exercise it: the previous code (cc9ed1c) itself never reads the new data, and the `email` object and its records are ordinary metadata rows it shows as a normal object. But its **schema** does not declare `orgs.emailSettings` or the four new tables. As I understand Convex, pushing that schema fails while documents exist that it does not allow. So once any org has saved email settings or any send exists, a rollback needs one of:
- a rollback build that is cc9ed1c plus these schema declarations (schema only, no code), or
- clearing `orgs.emailSettings` and the four tables first (this loses campaign history; check with Shakur first).
Before any campaign data exists, a plain rollback to cc9ed1c is fine.

## Owner setup to go live (none of this was done)

1. Resend: verify a sending domain (for example `mail.codemyvibe.com`), create an API key, and add a webhook to `https://<deployment>.convex.site/webhooks/resend` with events delivered, opened, clicked, bounced, complained, failed and received. Turn on open and click tracking for the domain.
2. Convex env: `RESEND_API_KEY`, `REMOLD_SENDER_DOMAINS`, `REMOLD_CAMPAIGN_DAILY_CAP`, `RESEND_WEBHOOK_SECRET`; optional `REMOLD_INBOUND_DOMAIN` with Resend inbound receiving set up for that domain.
3. In Remold Settings: from name, from address, postal address, daily limit; reply-to if not the approving admin.
4. Deploy only with `pnpm deploy:prod`; existing orgs get the Email object via `seed:ensureStandard`.
5. Send a first campaign to yourself only (one person linked) and check the footer, unsubscribe, reply and webhook numbers.
6. Before the first list larger than a few hundred people: one SERVICE check on a local Convex backend (as `ui-harness.mjs` does). Link about 4,000 people to a campaign, approve one email from its preview, and record that the approval commits and that one tick then claims a batch. This is the read and write limit that convex-test cannot measure (round 2, "What I disagree with").

## Left undone or uncertain

- No live test against Resend. The API shapes used (`POST /emails` with `Idempotency-Key`, `tags`, `headers`, `reply_to`; `GET /emails/receiving/<id>` returning `text`; webhook `data.tags` as an object or array, `data.click.link`, `data.bounce.type`) come from the brief and Resend's documented formats, not from a live call.
- If Resend answers 409 for a reused idempotency key with a changed body (a person edited the email between a crash and its retry), that send is marked failed although the first attempt may have gone out.
- Gmail-detected replies are only checked when a follow-up comes due, not continuously, so the report can show "not replied" until then.
- `webhookEvents` and `emailCaps` grow without cleanup (small rows; a purge can be added to an existing cron later).
- A campaign with zero people never marks its first email sent (it waits for people).
- Codegen was done by hand in `convex/_generated/api.d.ts`; the next `convex dev` will regenerate it.
- The pre-existing `proof:authority` failures above.

---

# Round 2 (after REVISE from Fable, plus Sol's review F1, F2, F4, F5, F6, F7, F15)

Where this section and round 1 disagree, this section is current. Builder: Opus 5.5. Not yet re-verified.

## What changed, by finding

| Finding | What it does now | Proving test (`convex/campaigns.test.ts`) |
|---|---|---|
| B2 audience snapshot | `campaigns.approve` turns the campaign's People into queued rows (skipped rows carry the reason). The sender only sends rows; it no longer reads the People list. People linked later get nothing; the report gives `added` and the campaign page says "N people added to the campaign since approval will not get this email" with **Approve again** (admin, same attestation dialog), which adds only them. Follow-ups: a row per person the earlier email was actually sent to, created at approval and as each earlier send succeeds, due at `sentAt + waitDays`. Up to 4,000 people per approval (`SNAPSHOT_LIMIT`); more need another approval. | "people linked after approval get nothing until an admin approves again, whoever linked them" |
| S1 + F2 edits | Any change to subject, body, campaign, followsUp, waitDays, sendTo or sendAt on an approved/sending email (any path) sets it back to draft through a second `applyChange` with an event "Changed after approval, so it needs approving again", deletes its run (confirmation gone) and its queued rows. Stop still works. Sender settings (from name/address, reply-to, postal address) are also bound: changing them blocks sending ("The email or the sending settings changed since approval") until approved again. | "any change to what goes out after approval sends it back to draft ...", "without an inbound domain, replies go to the org's reply-to address" (settings change blocks until re-approved) |
| F2 version | The preview returns `version` (fingerprint of content, schedule, follow-up rules, sender settings and the exact people with addresses and skip reasons). `approve` requires it and refuses with CONFLICT if anything changed. The run stores `contentVersion`; `claim` and `begin` both compare it. A caller who cannot read every contributing field gets `version: null` and cannot approve from that preview. | "approval is refused if the email, its settings or its people changed after the preview" |
| S2 + F7 replies | Deduplicated by svix id and by Resend `email_id`. Every reply is still marked and kept as a Note (5,000 chars max). Only the first 3 per send are forwarded. A forward is a durable `emailForwards` row. The tick sends it through the settings gates and the org/deployment daily counts, holds it while the workspace is read-only, and retries up to 5 times with one idempotency key (`forward-<svix id>`). | "a reply is counted once per Resend email, at most three are forwarded per send, and forwards use the daily limit", "a forward that fails is retried until Resend takes it, exactly once, and a read-only workspace holds it" |
| Product call: replied | A reply excludes a person only from later emails of the same campaign. Unsubscribe, bounce and complaint stay org-wide. | "a reply leaves a person out of that campaign's later emails only, not other campaigns" |
| Crash edge | A send still unknown 23 h after its first attempt is failed: "Outcome unknown: the send was interrupted and Resend no longer remembers it". This covers both a lease that ran out and a lost answer whose retry waited, for example on a paused campaign. Never retried. | "a send still unknown after 23 hours ...", "a send whose answer was lost and then sat paused for 23 hours ..." |
| F5 unknown outcome | No answer from Resend (network/timeout), or a lease that ran out, is "unknown", not a plain retry. The row keeps its daily count and retries the same bytes with the same key without taking a new count. A Resend webhook about it (tag `send`) settles it as sent. A definite 429/5xx still releases the count, unless an earlier try was unknown. | "when Resend's answer is lost the send keeps its daily count, so the next person waits, and the retry sends nothing new", "a webhook about a send whose answer was lost settles it as sent" |
| F6 exact bytes | The composed request body is stored on the row at first claim. Retries send that string byte for byte. | "a retry sends exactly the bytes of the first try, even if the person was renamed in between" |
| F15 starvation | Runs are visited least recently checked first (`by_live_checked`, 20 per tick, each stamped). | "blocked emails cannot starve an eligible one behind them" (101 blocked runs; the eligible one sends within 7 ticks) |
| S4 scale | Per tick the sender reads only due queued rows via `by_email_due` (at most 4 x batch per email), with no person scan. Follow-up rows are created at approval and on each send, not rescanned each tick. | "one tick stays small with 3,000 people on a campaign: it reads and claims one batch" |
| S5 + F1 masking | The preview masks the subject and body if hidden. Person name, person company and company name go through field checks and `visibleTitle`, both in the rendered text and in the listed rows. | "hides the email subject / email body / person name / person company / company name and anything rendered from it" (each hides one field and asserts neither the value nor its rendered form appears) |
| F4 before write | `emailCheck` (admin-only approval, Sending/Sent reserved, content checks) runs in `applyChange` before any record or event write; `emailRules` (run and queue bookkeeping) runs after. | "a CSV row the email rules refuse writes no record, event or approval" |
| S3 gates | New tests: member approving through the status field, read-only workspace, earlier unsubscribe/bounce/complaint on a send without a consent row, late finish from a crashed attempt, reply to a send that never went out, confirmation withdrawn mid-batch, truncated signature. | "a plain member cannot approve ...", "a read-only workspace sends nothing", "an earlier unsubscribe, bounce or complaint ...", "a late finish ...", "a reply to a send that never went out is ignored", "a confirmation withdrawn mid-batch stops the rest", webhook test (prefix signature) |
| S6 UI | An approved-but-unconfirmed (or changed) email shows **Confirm**, which opens the attestation dialog. Subjects show merge tags as plain placeholders ("first name"). The Approve button stays off until the preview has a version. | screenshots `campaign-emails.png`, `approve-dialog.png` (rerun) |

Which of Sol's findings the coordinator's decisions already covered: F2 (content and audience) was mostly covered by S1 and B2. Not covered and added here: the preview `version`, binding sender settings, and the dispatch-time check. F1 was mostly covered by S5; added here: subject/body masking and company-name `visibleTitle`. F7's read-only and caps parts were covered by S2; added here: durable retry and the 5-attempt bound. F4, F5, F6 and F15 were new.

## Evidence

- `round2-fail-before.txt`: the 64-test file run against round 1 code (1cf77cb, in a scratch checkout, with an approve helper that omits `version` there): 22 fail, 42 pass.
  - The 22 failures are every new behaviour above, plus three round-1 tests whose expectations changed: edits withdraw approval, settings changes need re-approval, and `version` is now a required argument.
  - New tests that pass on round 1 guard behaviour round 1 already had but nothing tested: S3's member approval, read-only, past exclusions, late finish, reply to an unsent send, and the status-field confirm. They are proven by mutants instead.
- `pass-after.txt`: 64/64.
- `mutants.mjs` + `mutants.txt`: **52/52 caught**. That is round 1's 19 (one rewritten for the moved code), all 13 of the verifier's from `~/scratch/iv-A-mutants.mjs` with test names fixed to match, and 20 for round 2. Round 1's equivalent "deployment cap checklist" mutant is replaced by the verifier's global-cap mutant. Five survived on the first run, and I closed each with a test:
  - two settings gates, which were also tripping the version check;
  - the confirmation problem, which also had a claim-time guard;
  - the signature length check (prefix signature);
  - the paused-unknown 23 h rule.
- Suites (`after.txt`): `pnpm test` 50 files, 393 passed; `pnpm typecheck` exit 0; `pnpm test:authority` 17 files, 101 passed (2 new inventory rows); `pnpm verify:release` 37/37; `pnpm build` built; MCP 3/3.
- Screenshots rerun (local backend, SIM send data), now showing "added since approval" with Approve again, marked subject placeholders, and the Approve dialog.

## B1: schema the expand commit needs

Apply exactly `expand-schema.diff` (in this folder, `git diff cc9ed1c -- convex/schema.ts` on this branch) to the live code, and nothing else:
- two constants `emailSettings` and `sendStatus`;
- tables `emailRuns`, `emailForwards`, `emailSends`, `emailCaps` and `webhookEvents`, with all their indexes;
- `orgs.emailSettings: v.optional(emailSettings)`.

All fields are new tables or optional, so the expand commit accepts today's data, and rolling back to it keeps any campaign data. Exclude the `email` standard object, cron, code and `_generated` changes. The diff includes the round-2 fields (`notBefore`, `previousSendId`, `firstAttemptAt`, `uncertain`, `forwards`, `payload`, the `emailForwards` table, the run's `version`/`contentVersion`/`checkedAt`, indexes `by_email_due` and `by_live_checked`). If the expand commit ships before a later round adds fields, the code commit's schema would differ again.

## What I disagree with or could not do

- **S4 read limits are argued, not measured.** convex-test does not enforce Convex's per-transaction read limits, so the 3,000-person test proves the claim touches one batch, not a read count. By construction:
  - Per tick: about 6 reads per row scanned. Up to 100 rows are scanned per email (4 x batch), plus about 10 per email for state.
  - Approval: about 2 reads and 1 write per person, so 4,000 people is about 8,000 reads and 4,000 writes. That is under Convex's limits as I understand them (16,384 reads, 8,192 writes), but untested on a real backend.
- **Settings changes block rather than send back to draft.** The coordinator's S1 list covers email fields only. I also bound sender settings (F2), but a settings change cannot sensibly flip every email to draft, so those emails wait with a visible problem and Confirm instead. I think that is right; say if you want drafts.
- **Company name hidden still returns a version.** Masking works (tested), but a company's title field is per company record, so I did not tie `version` to it. Approval is admin-only anyway.
- **Forwards share the org's daily limit with campaign sends.** That follows the S2 decision. A burst of replies can use up the day's count meant for the campaign. 3 per send keeps that small.
- **F15's 20-run scan is a policy choice.** With many blocked runs, an eligible one can wait up to (runs / 20) minutes.
- **Read-only workspaces.** A read-only workspace still records replies (Note writes are skipped there) and suppressions, and holds forwards until the hold lifts.
- **Mid-flight drafts.** Rows already leased when an email goes back to draft are skipped as "approval withdrawn" at their final check, not deleted.

---

# Round 3 (after Fable round 2: REVISE for B3, plus S7 and S8)

Builder: Opus 5.5. Not yet re-verified. The schema is unchanged since round 2, so `expand-schema.diff` still holds.

| Finding | Fix | Test (fails on 3f65b3d, passes now) |
|---|---|---|
| B3: stored payload outlived its approval | `claimFor` reuses the stored bytes only when the row is `uncertain` (outcome unknown). A row requeued after a definite 429/5xx, a pause, a stop and re-approval, or a settings Confirm is composed again from what is approved now. The Idempotency-Key is `<sendId>:<fingerprint of the bytes>`: an uncertain retry repeats both bytes and key, and a recomposed message gets a new key, so it can never collide with a key Resend saw with other bytes. | "a row requeued after a refusal is composed again from what was last approved, under a new key" (verifier N1), "stop, edit, approve again: a row tried before the stop goes out with the new words" (N2). Guard that already held: "an uncertain retry keeps both its bytes and its key". |
| S7 | "Changed since approval" is checked only for approved/sending emails. The Confirm button shows only for those states; Approve again covers sent emails with people added later. | "a sent email never shows as changed since approval" (N3) |
| S8 | A forward whose lease ran out (its action died) is marked `uncertain` before it is claimed again. A later definite failure then keeps its daily count. | "a forward whose action died is uncertain: a later definite failure keeps its count" (N6) |

Changed expectation: round 2's "a retry sends exactly the bytes of the first try, even if the person was renamed" was about a definite 503. B3 makes that case recompose, so the test is now "a retry after a definite refusal is composed again, so it says what is true now, under a new key". The exact-bytes guarantee now applies only to uncertain retries (tested above, and in "when Resend's answer is lost ...").

Go-live step 6 was added: one SERVICE check of a ~4,000-person approval before the first large send.

Note from the verifier, accepted: `fingerprint` is cyrb53 (53-bit, not cryptographic). It only detects that what is approved or sent differs from what was shown. An admin approves, and nobody can realistically craft a collision against a version an admin previewed.

## Evidence

- `round3-fail-before.txt`: the 5 new tests on 3f65b3d: 4 fail (N1, N2, N3, N6), 1 passes (the uncertain-retry guard).
- `pass-after.txt`: 69/69.
- `mutants.txt`: 56/56 caught. Round 3 adds 5 mutants: always reuse the stored payload, never reuse it, the key without the bytes, "changed since approval" on sent emails, and no uncertain mark on an expired forward lease. The round-2 "exact bytes" mutant now targets the uncertain retry.
- Suites (`after.txt`): `pnpm test` 50 files, 398 passed; `pnpm typecheck` exit 0; `pnpm test:authority` 17 files, 101 passed; `pnpm verify:release` 37/37; `pnpm build` built; MCP 3/3.
