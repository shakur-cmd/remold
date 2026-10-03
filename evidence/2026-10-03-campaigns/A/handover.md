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

## Left undone or uncertain

- No live test against Resend. The API shapes used (`POST /emails` with `Idempotency-Key`, `tags`, `headers`, `reply_to`; `GET /emails/receiving/<id>` returning `text`; webhook `data.tags` as an object or array, `data.click.link`, `data.bounce.type`) come from the brief and Resend's documented formats, not from a live call.
- If Resend answers 409 for a reused idempotency key with a changed body (a person edited the email between a crash and its retry), that send is marked failed although the first attempt may have gone out.
- Gmail-detected replies are only checked when a follow-up comes due, not continuously, so the report can show "not replied" until then.
- `webhookEvents` and `emailCaps` grow without cleanup (small rows; a purge can be added to an existing cron later).
- A campaign with zero people never marks its first email sent (it waits for people).
- Codegen was done by hand in `convex/_generated/api.d.ts`; the next `convex dev` will regenerate it.
- The pre-existing `proof:authority` failures above.
