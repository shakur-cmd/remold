# PLAN

# Remold to production on remoldcrm.com, Mautic for marketing

Revision: r3, 2026-09-24. Author: Fable (claude-fable-5). Challenger: Astra (gpt-6-astra); r1 REVISE, r2 REVISE, all findings accepted. Brief: `mautic/BRIEF.md`. Extends `crm-evaluation/PLAN.md` r3.

## 1. Decisions for Shakur

1. **Mautic host: one DigitalOcean 2 GB droplet, Docker Compose, ~USD 12 to 14 per month (driver verifies price).** One box is enough for one org's volume; email leaves through the provider below, not the box's IP.
2. **Email sending provider: Amazon SES.** ~USD 0.10 per 1,000 sends versus Postmark at USD 15+ per month; SES speaks the SMTP interface Mautic needs. Costs a one-time production-access request to AWS.
3. **Sending subdomain: `mail.codemyvibe.com`.** Marketing mail is CodeMyVibe's voice and this keeps campaign reputation away from your personal mail. Your brand, your call.
4. **App at `app.remoldcrm.com`, rehearsal at `staging.remoldcrm.com`, root redirects to app for now.** Clerk production wants subdomains on the domain anyway.
5. **Close sign-up for the freeze window (recommended: yes).** Clerk's restricted sign-up mode on both instances for the few hours of cut-over removes the who-joined-mid-migration problem entirely; a Convex flag cannot stop Clerk sign-up. Reopened the same evening, after cut-over commits.
6. **Convex: stay on Free, move to Pro (USD 25 per month) only if production approaches limits.** Flagging the money call now.
7. **Native reply detection (M7): attempt it only if we can point Mautic at an IMAP mailbox we already have or can add at zero marginal cost; do not buy one for it.** Mautic documents restrictions on Google-hosted monitored inboxes and its reply parser is fragile; if no suitable mailbox exists, M7 is skipped, Step 10 stays in the roadmap, and Step 9 is the fallback reply detector. Recommend: skip unless a cheap IMAP option turns up.

Everything else below is design, decided and reported.

## 2. Goal

**User:** Shakur, his team, and their agents, live in Remold today on dev infrastructure; soon strangers who sign up.

**Problem:** Remold runs on a dev Clerk instance (100-user cap, dev banner), a dev Convex deployment near Free limits, and a workers.dev URL. It has no bulk email, campaigns, forms, or landing pages.

**Observable end result:** Remold serves at app.remoldcrm.com on production Clerk and Convex with every existing user still in their org and every record intact, proven by an export-to-export comparison. A Mautic instance CodeMyVibe controls sends authenticated bulk email that lands in Gmail inboxes; contacts, consent, and engagement flow between Remold and Mautic without loss or loops. Agents drive it through the existing MCP and REST surface.

**Locked constraints (sources):**
- Remold is the system of record for people, companies, deals; Mautic owns bulk email, campaigns, segments, forms, landing pages, tracking (brief, adopted).
- Connector config is generic (org admin enters URL and credentials) but v1 binds one Mautic instance to exactly one Remold org (Astra r1 finding 7).
- Nothing live breaks; cut-over preserves every membership and record with tested rollback and mechanical zero-loss proof (Shakur's words).
- All record writes via `applyChange` with events; agents via keys, suggestions, grants; no LLM key server-side (grill-ledger 2, PLAN r3).
- Convex limits 32k documents scanned / 16 MiB read per function (PLAN r3).
- Mautic needs PHP, MySQL, cron on a VPS (brief).
- Clerk states development users cannot be migrated to production; relinking is our own mechanism (clerk.com migration docs).

**Exclusions:** multi-tenant Mautic hosting; two Remold orgs on one Mautic (v1); rebuilding Mautic features inside Remold; native mobile; everything PLAN r3 excludes, except forms and landing pages, which Mautic now provides from outside.

**Roadmap effect:**
- **Step 8 (automation) shrinks:** marketing branches live in Mautic; Remold keeps CRM-internal automations plus a webhook action.
- **Step 10 (sequences) is retired only if M7 runs and passes its original reply/no-reply outcome, plain-text reply included.** Otherwise Step 10 stays, with Step 9 as the fallback reply detector.
- **Step 9 stays.** One-to-one email belongs on the record, never in Mautic.
- The forms and landing pages exclusion is lifted via Mautic with zero Remold UI build.

## 3. Verification roles

As PLAN r3: the builder records evidence and never certifies. IV is a fresh Fable or Astra session working from this plan text alone. Shakur only where his accounts or judgment are needed. All checks **PENDING**.

## 4. Steps

M4 is independent of M1 to M3 and may run in parallel from day one. M5 onward needs both tracks done.

### Step M0: remoldcrm.com serves the app, observed state first

**Outcome:** The URL people learn is final, today; dev backend and banner remain.

**Build:** Astra may already have attached app.remoldcrm.com to the existing Worker (driver note; the working tree contains the route). First observe: `dig` app and root, curl both, read `wrangler.jsonc`. Complete whatever is missing: app.remoldcrm.com on the existing Worker, root remoldcrm.com redirecting to app, Clerk dev origins updated if needed.

**Prove it:** Start: the observed state, recorded verbatim in the evidence file before any change. Action: complete missing pieces; load app.remoldcrm.com in a fresh browser, sign in, edit a record; load the old workers.dev URL; load root. Expected: app and workers.dev serve the same build; the edit on the new domain appears on the old URL's session within 2 seconds; root returns a redirect to app. Pass: all four. Fail: sign-in broken on the new domain, either URL down, or root unhandled. Recovery: remove the custom-domain route; workers.dev is untouched throughout.

**Evidence and verifier:** recorded starting state, dig and curl output, screenshots of both signed-in sessions. IV repeats the cross-URL edit and the root redirect. **PENDING**.

### Step M1: Migration rehearsal with a frozen artifact comparison

**Outcome:** We can copy the entire dev dataset to the production Convex deployment and prove zero loss by comparing two static artifacts, not a moving database.

**Build:** Deploy the backend to the production deployment first (`convex deploy`), with prod env vars and an `auth.config.ts` that lists **only** the production Clerk issuer (placeholder until M2). Then: `convex export` on dev produces `source.zip`; `convex import --prod` into the empty production deployment; immediately `convex export` on prod produces `prod.zip`, before anything touches it. `scripts/verify-migration.ts` compares the two ZIPs table by table: row counts and sha256 over rows sorted by `_id`, canonical JSON including `_id` and `_creationTime` (snapshot import preserves both per Convex import docs; the comparison confirms it). Both ZIPs and the diff output are preserved for IV. Only after the comparison passes do probes run: an existing agent key against prod's `convex.site/api/v1/me` and a record list.

**Prove it:** Start: prod deployment empty, backend deployed. Action: export, import, export, compare, then probe. Expected: empty diff on every table; `/me` returns the agent; a records query returns known records with their original `_id`s. Pass: empty diff and both probes. Fail: any table differs, or `_id`s not preserved, which invalidates the approach; the plan stops for redesign rather than proceeding. Recovery: prod serves no one; wipe and rerun.

**Evidence and verifier:** `source.zip`, `prod.zip`, verify output, probe responses. IV reruns `verify-migration` over the preserved ZIPs from a fresh clone and spot-reads three records on prod by `_id`. **PENDING**.

### Step M2: Production Clerk, relinking from an authoritative inventory, and a user-facing recovery path

**Outcome:** A user who existed on dev signs in on production Clerk at a real HTTPS origin and lands in their org with their history. Zero-match sign-ins behave one way, always; anyone whose situation the map cannot resolve has a recovery path that does not require org membership or an operator to notice them.

**Build:**
- **Shakur (one line each):** create the Clerk production instance for remoldcrm.com, add its DNS records, create Google OAuth production credentials, enable the Convex integration on the prod instance.
- **Inventory:** a script using Clerk's Backend API against the **dev** instance exports every user: subject, primary email, verification status. Joined against the Convex `users` table by tokenIdentifier it produces `migration-map.json`: dev tokenIdentifier, users row `_id`, verified email or NONE. Rows with no verified email are the known manual set. The map is regenerated at cut-over (M3); this build proves the machinery.
- **Relink, server-side only:** on prod, first sign-in calls a Convex action that fetches the caller's verified primary email from Clerk's **prod** Backend API (never from browser-sent `profile`; profile data stays display-only). Exactly one map match: re-key the existing row to the prod tokenIdentifier, old identifier kept in `previousTokenIdentifiers`. **Zero or multiple matches: uniformly create a fresh row with no membership and no automatic exception; the map cannot tell a new user from a returning one with a changed email, so it does not guess.**
- **Recovery, user-facing and org-independent:** the app's empty state (signed in, no org) shows "Had data here before? Recover your account", which asks for the old email address and writes a `migrationExceptions` row: prod identity, claimed old email, status. **Ownership proof before any relink:** the user adds the claimed old email to their prod Clerk account and completes Clerk's verification of it; the operator CLI `users:relinkAs` (internal-only) checks via the prod Backend API that the claimed address is verified on that account and matches the map entry, then re-keys. Shakur's judgment substitutes only for the no-verified-email manual set he personally knows. **Temp-row reconciliation:** if the fresh row created at first sign-in has no memberships and no records, relink deletes it; otherwise both rows are kept and the exception is marked for manual merge, never automatic.
- **No dev tokens on prod, ever:** prod `auth.config.ts` lists only the prod issuer, so an old dev session cannot reach prod at all. Relink lookups also check `previousTokenIdentifiers` defensively.
- **Rehearsal origin:** `staging.remoldcrm.com`, a separate Worker serving a prod-wired build, an allowed origin with OAuth redirects configured, because production Clerk keys refuse arbitrary origins.

**Prove it:** Start: M1 rehearsal data on prod, prod Clerk live, staging serving. Actions at staging, each with email and Google sign-in where applicable: (1) a test user whose verified email matches one map entry; (2) a brand-new email; (3) a returning user whose email changed since dev; (4) a planted ambiguous email (two map entries); (5) a sign-in whose browser sends a forged `profile.email` matching someone else's map entry. Expected: (1) lands in the existing org with full timeline, users table gains no row; (2) and (3) behave **identically** at sign-in: fresh row, no membership, no exception; (3) then continues **through the user-facing path**: requests recovery, verifies the old email on their prod Clerk account, operator runs `users:relinkAs`, next load shows their org, and the empty temp row is gone; (4) fresh row; recovery request creates the exception, relink refuses while two map entries match and requires the operator to name the row `_id`; (5) the forged profile changes nothing about identity. Repeated sign-ins add no rows in every case. Pass: all cases, and `members`, `orgs`, `records`, `events` counts unchanged throughout. Fail: any silent merge, any relink without the verified-email proof, any duplicate row on repeat sign-in, or any divergence between cases 2 and 3 before the user acts. Recovery: relink is reversible via the stored previous identifier.

**Evidence and verifier:** `migration-map.json` (emails redacted in the repo, full copy held privately), table dumps per case, the recovery-path screen recording, unit tests that failed on old code first. IV repeats cases 1, 3 (full user-facing path), and 5 with their own test users at staging. Shakur: the three account tasks. **PENDING**.

### Step M3: Cut-over with both deployments frozen, a fresh map, and a rehearsed switch

**Outcome:** app.remoldcrm.com runs on production Clerk and Convex; every membership and record provably intact; the old stack remains a working read-only rollback that cannot diverge; nobody in the copied data lacks a mapping or a disposition.

**Build:**
- **Enforced freeze, both deployments:** a `FREEZE` env var checked in `applyChange`, every other mutation, and the agent REST dispatch, on **dev and prod alike**; frozen writes return a clear error and write nothing. **Named exemptions while frozen: `users.store`, the M2 relink action, and internal operator functions**, so verification sign-ins work. Scheduled functions drained or no-op under freeze. Clerk sign-up set to restricted mode on both instances for the window (Decision 5).
- **Separate production Worker:** `remold-prod`, its own wrangler config, carrying app.remoldcrm.com after the switch. The existing Worker keeps workers.dev and the old build. Each build embeds an identifier (commit hash at `/version` and a meta tag). **The routing switch is rehearsed both directions on a throwaway hostname (`cutover-test.remoldcrm.com`) before freeze day; the live hostname moves only inside the freeze.** Rollback is this Worker routing change.
- **Runbook, then execution:** announce; set Clerk restricted mode; set FREEZE on both deployments; drain; IV write probes (below); **regenerate `migration-map.json` from the dev Clerk Backend API now, inside the freeze**; wipe rehearsal data from prod; export dev to `cutover.zip`; **reconcile: every `users` row in `cutover.zip` has a map entry or an explicit disposition (the no-verified-email manual list); an unaccounted row stops the cut-over**; import to prod; export prod; verify the two exports with M1's canonical comparison; switch app.remoldcrm.com to `remold-prod`; Shakur and one member sign in and relink; unset FREEZE on prod; reopen Clerk sign-up; confirm a stranger can sign up on prod. Dev stays frozen forever; its frontend gets a redirect banner. Dev retained two weeks, then archived.
- **The one-way door is unfreezing prod:** the verify gate, the reconciliation rule, and the write-rejection probes all sit before it.

**Prove it:** Start: M1 and M2 passed; the throwaway-hostname switch rehearsed both ways with build identifiers and backend URLs compared each way; a test user created **between the M2 rehearsal and the freeze** exists on dev. Action: the runbook, timed. Expected: under freeze and before export, an old browser session's edit, an old agent key's `POST /changes` against **dev**, a browser edit and an agent `POST /changes` against **prod**, are all rejected with clear errors, and M1's canonical comparison of dev exports taken before and after those attempts is empty; the regenerated map contains the between-rehearsal user, who relinks successfully after the switch; the reconciliation report shows zero unaccounted users; the cutover export comparison diff is empty; Shakur's prod sign-in shows the Codemyvibe org, members, agents, and a record timeline identical to a pre-freeze export of that record; an agent key works against prod; workers.dev still serves the old build identifier; after commit, sign-up reopened and a stranger signs up on prod. Pass: all, freeze under 3 hours. Fail: any accepted non-exempt write under freeze on either deployment, any verify diff, any unaccounted user, any user unable to reach their org, any agent key dead. Recovery: switch the custom domain back to the old Worker (rehearsed); dev holds every write because the freeze is enforced; unset FREEZE on dev only in that rollback case.

**Evidence and verifier:** timestamped runbook, rejection responses with the before/after canonical comparison, reconciliation report, export comparison output, `/version` outputs from both entry points, screenshots. IV performs the write-rejection probes on both deployments during the freeze and, after cut-over, signs in as the between-rehearsal test user and reads a pre-freeze record. Shakur: his own sign-in on phone and Mac, and the two Clerk sign-up-mode toggles. **PENDING**.

### Step M4: Mautic runs, restores, and its mail lands in the inbox

**Outcome:** A Mautic CodeMyVibe controls, restorable from backup, whose email passes SPF, DKIM, and DMARC into a real Gmail inbox. Independent of M1 to M3; start in parallel.

**Build:** DO droplet, Docker Compose pinned by image digest (exact `mautic/mautic` 7.x tag and digest recorded; 7.x API basic-auth availability verified by the driver against 7.2 docs before build), MariaDB, cron and worker containers per the official example, TLS reverse proxy at `mautic.codemyvibe.com`. SES: verify `mail.codemyvibe.com`, DKIM CNAMEs, SPF, DMARC `p=none` with rua reporting; request production access (Shakur's AWS). Mautic SMTP transport on SES. Dedicated least-privilege API user for the connector. Nightly backup of the database dump plus Mautic config and persistent files to object storage.

**Prove it:** Start: fresh droplet, DNS absent. Action: stand up, install, send a test campaign email to a Gmail address and mail-tester. Expected: Gmail original shows SPF pass, DKIM pass with d=mail.codemyvibe.com, DMARC pass, inbox placement; mail-tester 9+; cron runs green; authenticated `GET /api/contacts` answers. Pass: all four. Fail: any auth failure, spam placement, dead cron. Failure case, reproducible interruption: with a 3-recipient test send queued, stop the DB container after the spool reports exactly 1 sent, restart, drain; each address receives exactly one copy; this establishes behavior at this interruption point only, so the sync layer never assumes exactly-once from Mautic. Restore exercise: from backups alone, rebuild on a scratch droplet; config, credentials, contacts, and sent-email records present; a test send works.

**Evidence and verifier:** Gmail headers, mail-tester URL, cron log, dig outputs, restore transcript with the scratch droplet's `GET /api/contacts` matching the original. IV reruns the header check on a message to their own address and reviews the restore transcript. Shakur: AWS account, SES production request, codemyvibe.com DNS approval. **PENDING**.

### Step M5: The sync: one org, one Mautic, crash-safe, loop-free, loss-free

**Outcome:** A Person created or edited in Remold appears in Mautic within minutes; unsubscribes and form submissions appear on Remold records; the sync survives crashes at any point (including create-then-delete), partial batch failures, missed webhooks, and out-of-order delivery, without duplicates, echoes, orphans, or stale consent.

**Build:** all in Remold, behind existing patterns.

- **Tables:** `integrations` `{orgId, kind: "mautic", baseUrl, credential, fieldMap, campaignMap, enabled, lastError?}` with one integration per org **and** one org per `baseUrl` within this deployment; a second org connecting the same base URL is rejected. `mauticLinks` `{orgId, integrationId, recordId, ref, mauticContactId?, origin: "created" | "adopted", state: "pendingCreate" | "linked" | "remoteDeleted", lastPushedHash}` indexed by record and by contact id; **the record's three-word `ref` is stored on the link itself**, so no recovery path ever depends on a deleted record or on delete-event contents. `processedSubmissions` `{integrationId, formId, submissionId}` as the per-submission dedup markers. Credential in a Convex table, not field-encrypted; accepted v1 risk with a least-privilege Mautic user.
- **Ownership partition (loop killer):** every synced field flows one direction only. Remold owns identity fields: pushed via **PATCH** so Mautic-owned data is never touched. Mautic owns marketing state (`doNotEmail`, points, last activity, form submissions): pulled only. No bidirectional field; all pull writes go through `applyChange` as actor `automation`, reason `mautic-sync`, and the pusher skips records whose only changes since the cursor are mautic-sync events.
- **Crash-safe push protocol:** cron every 5 minutes; durable cursor over `by_object_updated`; batches of 200. Per record: hash; skip if equal to `lastPushedHash`. **Creates: write the link row first, `state: "pendingCreate"`, `origin: "created"`, with `ref`; then create remotely with custom field `remold_ref`; then patch the link with the contact id and `state: "linked"`.** A crash anywhere leaves a pending link whose reconciliation on the next run searches Mautic by `remold_ref`: found means adopt the id and mark linked (origin stays `created`); not found means recreate. Batch responses are processed **per item** (Mautic's batch controller reports individual statuses inside HTTP 200); each success advances that link; each failure records `lastError` and retries; the cursor advances only past fully processed records. Three consecutive failed runs disable the integration visibly.
- **Existing contacts and duplicates:** first-time link searches by `remold_ref`, then by email; an email hit links with `origin: "adopted"`. Within an org, two records sharing an email: first linked wins, later ones are skipped and reported in settings and `agentInbox`, never guessed at.
- **Deletes:** discovered from **delete events** since the cursor, resolved through the retained link (which survives the record). `origin: "created"`: delete the Mautic contact, then remove the link; a `pendingCreate` link whose record is gone reconciles by `remold_ref` search and deletes any remote contact it finds before removing itself, closing the create-then-delete orphan. `origin: "adopted"`: remove the link only. Mautic-side deletion (404 on push, or webhook): link becomes `remoteDeleted` and pushing stops; the retained link prevents silent recreation; an explicit per-record "resync" in settings is the only recreate path and it logs an event.
- **Segment membership pass:** `Campaign.people` edits change the Campaign, not the Person, so each cycle also diffs the current `Campaign.people` links of every mapped campaign against the last-pushed membership set stored with the mapping, and applies adds and removes to the Mautic segment. Independent of the identity hash.
- **Pull, webhook path:** Mautic webhooks (DNC change, form submission) to `httpAction` `/api/mautic/webhook/<integrationId>`, verified with Mautic's HMAC over the **raw body** before parsing, iterating batched payloads. **Each form submission's effect and its `processedSubmissions` marker commit in the same mutation**, so effect and dedup cannot diverge. Submissions with no matching record land in `agentInbox`.
- **Pull, polling backstop:** every 15 minutes, two streams. (1) Form submissions: `GET /api/forms/{formId}/submissions` traversed from the polling checkpoint; any submission without a marker is processed (same atomic mutation); **the checkpoint advances only after a completed traversal, so a missed id below an already-webhooked higher id is still swept**. Markers, not the checkpoint, are the dedup authority. (2) Consent: reconcile **current** channel-specific DNC state per linked contact, page by page (contact-id cursor); reading present state means an old queued event can never overwrite newer consent.

**Prove it:** Start: M3 and M4 done; a test org connected; 3 seeded People; one pre-existing Mautic contact sharing an email with one of them; two test People sharing one email; one mapped Campaign with a Mautic segment. Actions and expectations:
(1) First sync: 2 contacts created with `remold_ref`, the pre-existing one adopted not duplicated, the duplicate-email second record skipped and reported.
(2) Edit a phone in Remold: PATCHed next cycle; a Mautic-side points change is untouched.
(3) Unsubscribe from a Mautic email: `doNotEmail` on the record with an attributed automation event within a minute.
(4) Two idle runs: zero events, zero Mautic `dateModified` changes.
(5) Crash injection (`SYNC_FAIL_AFTER_REMOTE_CREATE`): next run adopts by `remold_ref`; exactly one contact, link `linked`, origin `created`.
(5b) Crash injection again, then **delete the Person before the retry**: the next run finds the orphan pending link, locates the remote contact by `remold_ref`, deletes it, removes the link; Mautic holds no trace.
(6) Batch partial failure: one invalid item; the others commit, the bad one shows `lastError` and retries; the cursor does not silently pass it.
(7) Deletes: delete a `created` Person: contact and link gone; delete a Mautic contact: record intact, link `remoteDeleted`, no recreation over ten runs, explicit resync recreates once with an event.
(8) Webhook outage with partial delivery: disable delivery for submission 101 only, deliver 102 by webhook, then poll: 101 is swept; then replay both webhooks: still exactly two submissions on the records. Separately, two consent flips ending unsubscribed during an outage reconcile to unsubscribed, never stale.
(8b) Segment pass: add an already-synced, unedited Person to the mapped Campaign: they enter the segment next cycle with no Person push; remove them: they leave the segment.
(9) Forged webhook (bad HMAC) rejected 401 with no write; a valid-HMAC batched payload as positive control processes.
(10) A second org connecting the same base URL: rejected.
Pass: all. Fail: any duplicate contact, echoed write, orphaned remote contact, lost or duplicated submission, stale consent, silent recreation, or cross-org touch.

**Evidence and verifier:** Mautic contact export, Remold events export for the window, webhook logs, idle-run diff, per-case transcripts. IV independently reruns cases 5b, 7, and 8 from the plan text on the test org. **PENDING**.

### Step M6: An agent runs a campaign through existing Remold surfaces

**Outcome:** From Claude Code, an agent enrolls people in a campaign using objects that already exist; Mautic sends; results land back on Remold records. Zero new agent auth, zero new field types.

**Build:** Reuse the seeded **Campaign object's `people` links relation** (convex/lib/standard.ts) as the enrollment representation; the M5 segment pass moves membership. Removal from `Campaign.people` removes the contact from the segment next cycle; whether Mautic re-runs a campaign for a returning segment member is verified by the driver and documented from observation, not assumed. Amend PLAN r3 in writing: Step 8 rescoped, forms and landing pages exclusion lifted, Step 10 retained pending M7; grill-ledger superseding entry.

**Prove it:** Start: M5 live on the test org; a 2-step Mautic campaign, 2-minute delays, on the mapped segment; an agent key with no grants. Action: via MCP, ask the agent to add two seeded People to the Campaign; apply its suggestion in the UI; after step 1 delivers, unsubscribe recipient B; after the campaign, remove recipient A from `Campaign.people`. Expected: suggestion attributed to the agent and applied by the human; both contacts enter the segment on the next cycle; A's mailbox receives both emails in order, B receives only step 1 and B's record shows `doNotEmail` with the automation event; nothing is sent for anyone the human did not apply; A leaves the segment after removal. Pass: mailbox contents exact, attribution correct throughout. Fail: any send without an applied suggestion, or an unsubscribe not honored. Failure case: revoke the key, repeat the MCP call: clean error, no suggestion.

**Evidence and verifier:** Claude Code transcript, timestamped mailbox screenshots, events export, the PLAN r3 amendment diff. IV repeats with a Codex session and a second key. Shakur: approves the roadmap amendment. **PENDING**.

### Step M7 (conditional): Stop-on-reply gate, or Step 10 stays

**Outcome:** The one Step 10 promise Mautic has not proven: a campaign stops when the contact replies, including a plain-text reply. Only a pass here retires Step 10. **Runs only if Decision 7 finds a zero-marginal-cost IMAP mailbox; otherwise this step is recorded SKIPPED, Step 10 stays in the roadmap, and the fallback is Step 9 setting a Remold field the sync pushes and the campaign halts on.**

**Build:** Point Mautic's monitored inbox at the qualifying mailbox as campaign reply-to; configure the reply-based campaign decision. Known hazard from the 7.2.1 reply parser: detection depends on finding the tracking hash in the reply body, so stripped plain-text replies can evade it; the test targets exactly that. **Create a dedicated three-step campaign for this test**, 2-minute delays.

**Prove it:** Start: the three-step campaign live; contacts P and Q; the mailbox monitored. Action: enroll both; P replies to step 1 as **plain text with quoted content stripped**, sent from a real mail client; Q never replies; observe for 3 steps times 2 minutes plus a 3-minute delivery allowance, **9 minutes total**. Expected: Q's mailbox holds all three messages in order; P's holds only step 1 and P shows stopped-on-reply. Pass: both mailboxes match exactly, on the plain-text reply, within the window. Fail: P receives step 2, or Q misses a step in the window; on fail, Step 10 remains unretired with the Step 9 fallback recorded, and this gate stays open, not silently absorbed. Failure case regardless of verdict: re-enroll P while stopped; refused or inert, never an unnoticed restart from step 1.

**Evidence and verifier:** both mailbox screenshots with times, monitored-inbox log, campaign contact log. Shakur or IV sends the plain-text reply from a real client. **PENDING** (or **SKIPPED** by Decision 7).

## 5. End-to-end user journey

Shakur opens app.remoldcrm.com on his phone (M0), signs in through production Clerk, and lands in Codemyvibe with every record and timeline he had before the freeze, no dev banner (M1 to M3). In Claude Code he says "add the four bakery owners I met this week to the intro campaign"; a suggestion attributed to claude-mac appears and he taps apply (existing Step 5 flow), linking them to the Campaign record (M6). Within five minutes the sync creates the four contacts in Mautic under their three-word codes and the segment fills (M5), and Mautic sends the first authenticated email from mail.codemyvibe.com into their inboxes (M4). One owner unsubscribes; her record shows Do not email within a minute and step 2 never reaches her (M5). Another replies; if M7 ran and passed, the campaign stops for him by itself. The reply landing on his Remold record is Step 9 behavior and is future until Step 9 passes; today Shakur reads it in Gmail and continues one to one, outside Mautic, where that conversation belongs.

## 6. Unresolved risks

- **Mautic 7.x specifics remain partially from my knowledge:** API basic-auth availability, batch per-item response shape, webhook HMAC details, segment-exit and re-entry behavior, the reply parser's practical hit rate. The driver verifies each against 7.2 docs and 7.2.1 source before the dependent step; M7 is conditional because the reply parser and the monitored-inbox requirements are the least trustworthy.
- **Snapshot import preserving `_id`s is the keystone of M1;** the rehearsal tests it first and the plan stops if it fails.
- **Users with no verified email on dev cannot auto-relink;** they are named before cut-over and resolved via the internal operator path, with the user-facing recovery route for anyone missed. Dev data is retained read-only, not deleted, so late recovery stays possible.
- **The recovery path's ownership proof assumes the user still controls their old email address.** Someone who lost both their dev sign-in method and the old mailbox has only Shakur's personal judgment; acceptable at this scale, unacceptable later, noted for the multi-tenant future.
- **Convex Free limits on prod:** pre-flagged as Decision 6; the crons add well under the free call budget, but real usage decides.
- **Mautic credential in a Convex table is not field-encrypted;** accepted for v1 with a least-privilege API user; revisit if strangers connect their own Mautic.
- **Deliverability is earned, not configured:** M4 proves authentication, not reputation; volume ramps slowly and DMARC tightens only after clean rua reports.
- **One org per Mautic is a v1 simplification;** a shared instance would need contact-ownership isolation designed and reviewed, not patched in.