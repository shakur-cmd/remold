# Job A: campaign email (send, track, reply, follow up)
Branch: `campaigns/email`. Job id: A. Base: 371a62c. Read COMMON.md first.

## Why
Shakur watched a video (Chris Koerner, "I Tried to Make $10K/Month on Autopilot With AI"): Claude, connected over MCP to an email tool, uploaded a small list and sent one email offering $5 five-minute calls (TidyCal booking + Stripe). A week later he read opens, clicks, replies, bookings and $80 revenue, and stressed that follow-ups matter. Remold must do this natively and an agent must be able to run it end to end, while a person approves what gets sent. (Booking pages and payments are Job B, which builds on this branch: leave a clean seam, described below.)

## Read first
convex/lib/standard.ts (Campaign is a funnel; Post shows the "agents draft, only a person approves" pattern), convex/authority/agentGuards.ts, convex/lib/applyChange.ts, convex/lib/email.ts, convex/reminders.ts (cron + claim pattern), convex/http.ts, convex/agentApi.ts, convex/integrations/tables.ts (the `consent` table: reuse it for suppression), convex/crons.ts, convex/rateLimit.ts, packages/mcp/src/*, src/routes/RecordPage.tsx (funnel page), src/routes/Settings.tsx, ops/gmail-sync/ (how sent/received email Activities are recorded).

Do NOT use the integrationOps/adapter framework (convex/integrations/commands.ts etc.). It is built for outside adapter workers and vault secrets that do not exist. Campaign sending is a Convex action calling Resend directly, like lib/email.ts.

## Build

### 1. Email steps are records
Add a standard object `email` (label Email / Emails) to the standard set:
- `subject` text, required, title.
- `body` text, not indexed. Plain text. Merge tags allowed: `{{firstName}}`, `{{name}}`, `{{company}}` (company name via the person's company lookup). First name = first word of name; when empty use the fallback written as `{{firstName|there}}`. Any other `{{...}}` is invalid.
- `campaign` lookup to campaign.
- `followsUp` lookup to email (empty = first email of the campaign).
- `waitDays` number (follow-ups: days after the recipient got the previous email; default 3 when empty).
- `sendTo` select: `everyone`, `notOpened`, `notClicked`, `notReplied` (follow-ups; default notReplied). Replied, unsubscribed, bounced and complained people are always excluded from every email.
- `sendAt` date withTime (first email: not before this time; empty = as soon as approved).
- `status` select: `draft`, `approved`, `sending`, `sent`, `stopped`.
Reaches existing orgs through seedStandard. Use the slots wisely (index status and campaign; body unindexed).

Guard (agentGuards.ts, same style as Post): agents may create and edit draft emails, but only a person sets `approved`; agents cannot edit an email once it is approved/sending/sent; agents may set `stopped` (stopping is always safe). Approving must also validate: subject and body present, merge tags valid, campaign set, and for a follow-up the previous email in the same campaign. Approval through any path (UI, agent apply, suggestion applied by a person) must hit the same validation; put it where applyChange-level checks for the email object can run (find the right seam, e.g. a validator called for the email object in applyChange or before it).

### 2. Who receives
Recipients of the first email = the campaign's `people` links that have an email (dedupe by lowercased trimmed address, first person wins). Excluded, with a reason recorded: no email, invalid address, suppressed in `consent` (channel `email`, purpose `marketing`, suppressed true), already replied/bounced/complained/unsubscribed in this org. A follow-up's recipients = people who were sent the previous email, filtered by `sendTo` at the moment it is due, minus the same exclusions.

### 3. Sending (gates first)
Org settings (admin only, new optional `emailSettings` on orgs or a small `orgEmailSettings` table, your call): from name, from address, reply-to address (default: the approving admin's email), postal address (required by CAN-SPAM), daily limit (integer; missing = 0 = nothing sends).
Nothing is sent unless ALL hold: RESEND_API_KEY set; from address domain is in env `REMOLD_SENDER_DOMAINS` (comma list; missing = none); org postal address set; org daily limit and env `REMOLD_CAMPAIGN_DAILY_CAP` (deployment-wide per UTC day, missing or unparseable = 0) both have room; the campaign's `status` is `active`; the email is `approved` (or `sending`); a person approved it. Pausing the campaign or stopping an email halts sending at the next step, including mid-batch.
Engine: a cron every minute runs an internal action. It claims a bounded batch (e.g. 25) in a mutation that creates `emailSends` rows and reserves cap, then sends each through Resend `POST https://api.resend.com/emails` with header `Idempotency-Key: <sendId>`, `tags: [{name:"send", value:<sendId>}]`, both `text` and a minimal HTML version (escaped text, URLs turned into links, line breaks), headers `List-Unsubscribe: <{site}/u/{token}>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Footer on every email: org postal address and an unsubscribe link. Site URL = `process.env.CONVEX_SITE_URL`. A send is marked sent with Resend's id, or failed with a short reason; 429/5xx/network errors go back to the queue up to 3 attempts. A claimed send that never completed (action crashed) must not be sent twice and must not stay stuck: use a lease and the idempotency key. An email becomes `sent` when every eligible recipient has an outcome and (for follow-ups) its previous email is `sent` and every previous recipient has been decided.
`emailSends` table (one row per email x person): orgId, emailRecordId, campaignRecordId, personRecordId, to, token (random, unguessable, for unsubscribe/reply), status (queued|sending|sent|failed|skipped), skipReason, providerId, attempts, lease, sentAt, deliveredAt, openedAt, opens, clickedAt, clicks, lastLink, repliedAt, bouncedAt, complainedAt, unsubscribedAt. Index what you query.
Timeline: on sent, write an Activity about the person (type email, title `Sent: <subject>`, source `campaign`) via applyChange with an `automation` actor. Also Activities on first click, reply, bounce and unsubscribe. Not on opens (too noisy).

### 4. Tracking webhook
`POST /webhooks/resend` (Convex http router, not under /api/v1). Verify the Svix signature exactly: secret env `RESEND_WEBHOOK_SECRET` (`whsec_<base64>`), signed content `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256, base64, compare in constant time against any `v1,<sig>` in `svix-signature`, reject timestamps more than 5 minutes off. Missing secret = 503, bad signature = 401, nothing written. Deduplicate by svix-id. Match the send by the `send` tag, falling back to providerId. Handle `email.delivered`, `email.opened`, `email.clicked` (count, first time, last link), `email.bounced` (only `Permanent` suppresses), `email.complained` (suppress), `email.failed`, `email.received` (below). Suppression writes the consent table (purpose marketing, channel email, suppressed true, source `bounce`/`complaint`/`unsubscribe`).

### 5. Replies
If env `REMOLD_INBOUND_DOMAIN` is set, Reply-To = `r-<token>@<that domain>`; otherwise Reply-To = the org reply-to address. On `email.received` addressed to `r-<token>@<domain>`: fetch `GET https://api.resend.com/emails/receiving/<email_id>` for the text, keep the reply part (drop quoted lines and everything from an `On ... wrote:` line), mark the send replied, add an Activity `Replied: <subject>` and a Note with the reply text about the person, and forward the reply to the org reply-to address (from the org from address, Reply-To the replier's address, subject `Re: <subject>`) so the person sees it in their own inbox. Without an inbound domain, a reply is detected when an email-type Activity about the person whose title marks it as received (match what ops/gmail-sync writes) appears after the send; also a "Mark replied" action in the UI and API.

### 6. Unsubscribe
`GET /u/<token>`: a tiny HTML page with one "Unsubscribe" button (link scanners must not unsubscribe people by fetching the link). `POST /u/<token>`: unsubscribes (also serves RFC 8058 one-click), idempotent, shows "You are unsubscribed". Unknown token: same neutral page, no info leak.

### 7. App UI (taste matters, keep it calm and plain)
- Settings: "Email sending" card (admin): the five settings, plus a live checklist of what is still missing before anything can send (API key, sender domain allowed, postal address, daily limit, webhook secret, inbound domain optional). Never show secret values.
- Funnel (campaign) page: an "Emails" section listing the campaign's emails in order with status and numbers: recipients, sent, delivered, opened %, clicked %, replied, bounced, unsubscribed. "New email" and "New follow-up" create draft Email records. Approve (admin) opens a dialog: who will receive it (count, plus excluded count with reasons), a rendered preview for the first recipient, the checklist of gates, and a required checkbox "Everyone on this list agreed to hear from me or already works with me." Stop button. A per-recipient table: person, email, status, opened, clicked, replied, with "Mark replied".
- The campaign's own `status` select is the go switch: show a clear "Start campaign" / "Pause" control on the funnel page.

### 8. Agents (REST + MCP)
Agents draft with the existing record tools (create email records, link people to the campaign). Add:
- `GET /api/v1/campaigns/<idOrRef>/report`: per email: status, gate problems, counts and rates; per recipient: person ref/name, address, status, opened, clicked, replied, skip reason. Respect read permissions exactly like other agent reads.
- `GET /api/v1/emails/<idOrRef>/preview?person=<idOrRef>`: rendered subject/body for one person, plus who would receive it now and who is excluded and why.
- `POST /api/v1/sends/<id>/replied`: mark replied (stops follow-ups; allowed for any agent that can read the campaign).
- MCP tools `remold_campaign_report`, `remold_email_preview`, `remold_mark_replied`, and update the MCP server instructions with a short recipe: create a campaign, link people (CSV import exists), draft emails and follow-ups, ask a person to approve and start the campaign, read the report, write follow-ups for non-repliers.

### 9. Seam for Job B
Job B adds booking pages. Export a small helper to send one transactional email through the same gates and caps (to a single recipient, no campaign), and make the merge-tag renderer extensible so B can add `{{bookingLink}}` that carries the send token for attribution.

## Done when
Tests (convex-test, fetch mocked) prove at least: nothing sends when any single gate is missing (one test per gate); the org and global daily caps are never exceeded across concurrent ticks; a follow-up with notOpened goes only to non-openers after waitDays, never to repliers/unsubscribed; pausing a campaign mid-batch stops the rest; a crashed claim is not sent twice; webhook with bad signature, wrong secret, stale timestamp is refused and writes nothing, a replayed svix-id is counted once; permanent bounce and complaint suppress, temporary bounce does not; unsubscribe GET does not unsubscribe, POST does, idempotently; inbound reply marks replied, records the Note and forwards; agent cannot approve or edit an approved email but can draft and stop; approval validation rejects unknown merge tags; agent report respects read scopes; seedStandard idempotent. Full suites + build pass. Screenshots of Settings email card and the funnel Emails section if you get a local backend.
