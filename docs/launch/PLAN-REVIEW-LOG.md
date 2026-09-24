# Review log: Remold x Mautic plan

Process: triad-v2. Driver: Opus 5.5 (coordinating only). Author: Fable (claude-fable-5, runtime modelUsage confirmed claude-fable-5, subscription max). Challenger: Astra (gpt-6-astra via codex exec). Cap: 3 passes. Raw outputs: /tmp/remold-mautic-1790255184

## Pass 1: r1 sha256 c84f7bf513c7, Astra VERDICT: REVISE
Blockers (10): M1 compared against a moving dev DB; M2 relinked on a browser-sent email; stranded users had no destination and old dev sessions could re-row; prod Clerk rehearsal impossible on localhost; banner freeze did not stop writes; one Worker meant rollback build got overwritten; shared Mautic across orgs broke isolation via email matching; sync not crash-safe; polling backstop unspecified; Step 10 cut without proving stop-on-reply (Mautic 7.2.1 reply parser needs tracking pixel in reply HTML).
Optional: reuse Campaign.people; pin Mautic image digest and full restore test; M0 from observed state.
Dispositions (Fable): all 10 blockers and 3 optional accepted. See /tmp/remold-mautic-1790255184/fable-r2.md.

## Pass 2: r2 sha256 d128e8dc4b60
Astra VERDICT: REVISE. Prior blockers 1, 2, 4, 6, 7, 10 resolved; 3, 5, 8, 9 partly open.
New blockers (6): M2 cannot tell new user from returning user with changed email, no user-facing recovery; identity map goes stale if sign-up stays open between M2 and M3; prod never explicitly frozen and live domain switched before freeze; M5 orphan when remote create succeeds, ack fails, record deleted; shared submission high-water mark skips missed webhooks; M7 fixture expects 3 emails from a 2-step campaign.
Optional: segment-membership reconciliation pass; canonical comparison for freeze probes; skip native Mautic reply mailbox, use Step 9.

## Pass 3: r3
r3 sha256 04d712596c35. Fable accepted all 6 pass-2 blockers and 3 optional.
Astra VERDICT: REVISE. Pass-2 blockers 1, 2, 5, 6 resolved; 3, 4 partly open; one new.
Remaining blockers (3):
1. M3: blanket users.store exemption leaves dev writable. Fix: on frozen dev, users.store returns existing row without writing and rejects creation; on prod exempt only named migration ops; add profile-update and missing-row freeze probes.
2. M3 (new): restricted prod sign-up blocks the verifiers, who have no prod Clerk account yet. Fix: pre-provision prod accounts or invitations for named cut-over verifiers; rehearse with a dev-only user.
3. M5: pending-create cleanup can race an in-flight remote create. Fix: durable deletion request on the pending link, coordinate create/delete; test delayed create + delete + cleanup ends with no contact and no pending state.

## Status: NOT CONVERGED at cap (3 passes)
All three remaining items are build-level fixes with named tests, inside M3 and M5. M0, M1, M4, M6, M7 have no open blockers. Starting M0 verification and M4 (Mautic host) does not depend on them.
Driver fact correction after final review (plan text not edited, to keep the reviewed revision intact): SES is USD 0.16 per 1,000 emails on the Essentials tier (aws.amazon.com/ses/pricing, checked 2026-09-24), not 0.10. DigitalOcean 2 GiB / 1 vCPU droplet USD 12/month confirmed (digitalocean.com/pricing/droplets).

## User override 2026-09-24: no pass cap, new priorities
Shakur: keep passing until settled; be bold; switching Clerk to WorkOS is fine. Priorities: (1) change quickly once other teams use it, (2) charge customers, (3) simple start. Driver found prod-to-be has 1 user, 1 org, 16 fictional records, so r1-r3 migration machinery is largely moot. Brief v2 appended to BRIEF.md. r3 NOT CONVERGED status superseded by the r4+ loop.

## Pass 4: r4 sha256 17825ba1cf21 (Fable rewrite under Brief v2)
Changes: deleted all r1-r3 cut-over machinery (prod starts empty); auth to WorkOS AuthKit; billing Stripe Checkout + portal direct with own billing table; new Step 2 change-speed rails (CI gate, previews, @convex-dev/migrations, rollback, backups, per-org flags, versioned v1 contract, rate limiting), Step 3 charging (trial, read-only on lapse, never delete), Step 4 simple start; Mautic CodeMyVibe-only, r3 M4-M6 carried as Steps 5-7. r3 preserved at PLAN-r3-mautic-sync.md.
Driver verification: npm packages exist (@convex-dev/migrations 0.3.6, rate-limiter 0.4.0, stripe 0.1.6, workos 0.0.3); Stripe Billing 0.7%; Clerk Hobby 50k MRU; Convex daily backups Pro-only.
Astra VERDICT: REVISE, 11 blockers: rollback after migration unproven (schema rejects backfilled docs; old clients); previews not reproducible (seed needs orgId, AuthKit callbacks); no prod error/backup alerting; billing entitlement states contradictory (free tier vs read-only; local trial vs Stripe); Stripe event ordering/missed deliveries/duplicate subscriptions; per-seat sync is an unspecified distributed transaction; paying-team isolation and all write paths not tested; no complete export/deletion path; no purchase terms/privacy/refund gate; MCP package private and needs local path, so paste-only setup impossible; r3 create/delete race still open.
Optional: decide auth and billing together; evaluate @convex-dev/stripe; skip starter-object picker; keep Clerk app through rollback window; Mautic connector operator-configured only.

## Pass 5: r5
r5 sha256 a13fc9820bde. Fable accepted all 11 blockers and 5 optional. Key moves: flat workspace plan after cardless trial, no free tier (Shakur decision), per-seat deleted; reconciliation-based Stripe processing; expand-migrate-contract deploy gate; reproducible previews; ops alerts with Shakur as operator; owner export + operator deletion; commercial terms gate; @remold/mcp published to npm; pendingDelete closes sync race.
Astra VERDICT: REVISE. r4 blockers 2,3,4,6,7,10,11 resolved; 1 open, 5 and 8 partial. 6 blockers: rollback still deploys pre-expand schema; Step 1 route-back fallback abandons prod data; reconciliation extends grace forever / restores unpaid access; concurrent Checkout not prevented (reserve + idempotency key); personal account deletion undefined; tax gate ignores physical nexus. Optional: buy Convex Pro now and delete temporary backup/exception tooling; no bespoke schema-diff classifier.

## Pass 6: r6
r6 sha256 4657b88572ea. Fable accepted all 6 blockers and both optional. Convex Pro now (Decision 5), deleting export scheduler, storage integration, exception pipeline. Rollback target = expand release. Go-live declaration replaces route-back window. Grace deadline per episode; purchase reservation + idempotency key; personal account deletion; tax as verified launch decision. Driver verified: Convex exception reporting is Pro-only (Sentry/PostHog/Datadog).
Astra VERDICT: REVISE. r5 blockers 2,4,5,6 resolved; 1 partial; 3 fixed with related gap. 3 blockers: expand release not a valid rollback after contraction (defer destructive contraction at launch); terminal canceled has no recovery (allow new reserved Checkout); exception reporting stores but does not alert Shakur. Optional: use Convex's actual 7-day managed backup retention; run snapshot rehearsals only for data-affecting releases.

## Pass 7: r7
r7 sha256 02b42a4abec0. Fable accepted all 3 blockers and 2 optional: defer destructive contraction; new reserved Checkout after terminal cancel; alert rule to Shakur; 7-day managed retention; rehearsals only for data-touching releases.
Astra VERDICT: APPROVED on r7 sha256 02b42a4abec0 (hash verified by Astra and by driver on disk). No new blockers.
Optional not applied (to keep approved revision intact), carried as a build note for Step 3 case 3b: deliver a delayed webhook for the old canceled subscription after repurchase; it must not overwrite the current subscriptionId or revoke the new subscription's access.

## Status: CONVERGED at pass 7. Author Fable accepts r7; challenger Astra approved r7. All step checks PENDING; nothing built.
