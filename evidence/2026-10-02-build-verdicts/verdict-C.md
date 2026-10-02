VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, the independent verifier for C-m6. Reviewed `m6/lead-intake` at `0d9da8de1057b8d7251f90bf08200aa624803d97` against `origin/build/unified-remold-2026-09-24`, the brief, project rules, and builder handover. Evidence below is SIM or static inspection, not SERVICE/LIVE certification.

**Must-fix defects**

1. **P1 — Idempotency replay bypasses current read permissions.** [convex/agentApi.ts:109](/home/old-mac-pro/work/verify/C-m6/convex/agentApi.ts:109) returns `prior.result` before resolving the target or checking its current read scope. Reproduction: create a Person containing `email: "private@x.com"`; give a scoped agent read access to name/email and update access to name; update only the name through `/changes` with key `cached`; revoke the read grant using `api.authority.grants.revoke`; retry the identical request. GET now returns **404**, but replay returns **200**, including `values.email: "private@x.com"`, which was never in the submitted update. Suggested fix: reauthorize access to cached records and fields, including related-record projections, before disclosing a replay. Refuse or redact when authority has narrowed; retain the deduplication marker so refusal cannot cause another write. Add revocation and hidden-field regression tests.

2. **P2 — Existing contact formatting defeats Person matching.** [convex/lib/intake.ts:55](/home/old-mac-pro/work/verify/C-m6/convex/lib/intake.ts:55) compares normalized input against raw stored values; the calls at line 102 consequently miss existing contacts. Reproduction through ordinary `api.records.create`: store email `"Shakur@X.com "`, then intake `"shakur@x.com"`; separately, store phone `"+1 (410) 555-0100"`, then intake `"+14105550100"`. Both return **201 with two People**, rather than linking to the existing Person. The supplied case-normalization test covers only contacts previously created through intake. The handover acknowledges this limitation, but relying on a future import cleanup does not satisfy matching against existing CRM data. Suggested fix: add compatible normalized matching/index projections with safe existing-data handling, preserve original non-empty fields, and cover contacts created through normal CRM writes.

3. **P2 — The daily cap resets at a random time, permitting excess leads within the documented UTC day.** [convex/lib/intake.ts:68](/home/old-mac-pro/work/verify/C-m6/convex/lib/intake.ts:68) omits `start` from the fixed-window limiter. The installed component chooses a random window offset when it is absent (`@convex-dev/rate-limiter/src/shared.ts:208`). With cap **2**, time **2026-10-02 12:00 UTC**, and the limiter’s random fraction fixed to **0.99**, two leads succeed and a third receives 429; at **12:15 UTC**, another lead incorrectly receives **201**. Suggested fix: anchor the window to UTC midnight, for example `start: 0`, and test both same-day enforcement and midnight reset. Applying only that change in scratch made the failing daily probe pass; the change was then reverted.

All three defects have executable reproductions: [probe output](/tmp/verify-C-m6/probes.log), [probe source](/tmp/verify-C-m6/probe-source.txt), and [daily fix check](/tmp/verify-C-m6/daily-start-zero.log). The unmodified implementation produced **4 failed / 4 passed** independent probes; email and phone are separate failures.

**Should-fix**

- Intake alerts omit workspace identity: `convex/lib/intake.ts:73` builds only `intake-limit:<which>`, and `convex/alerts.ts:62` returns no workspace reference. Operators cannot identify the affected workspace in a shared deployment. Include an opaque workspace reference while keeping submitted contact data out of notifications.

**What I verified and how**

Ran every required command myself in the checkout:

| Command | Result / summary |
|---|---|
| `pnpm install --frozen-lockfile` | Exit 0; “Already up to date” |
| `pnpm typecheck` | Exit 0; `tsc -b && tsc --noEmit -p convex` |
| `pnpm test` | 27 files passed; **114 tests passed** |
| `pnpm test:authority` | 17 files passed; **97 tests passed** |
| `pnpm verify:release` | **19 passed, 0 failed** |
| `pnpm build` | Exit 0; built successfully; chunk-size warning |

Logs are `/tmp/verify-C-m6/{install,typecheck,test,authority,release,build}.log`. No required suite had a timeout flake.

Every Done-when item has a supplied test in `convex/intake.test.ts`:

| Requirement | Test line / independently observed coverage |
|---|---|
| Repeated lead produces one Person and Opportunity | 72; also checks links, stage, Note, normalized values and attributed events |
| Concurrent identical intake | 99; `Promise.all`, one result/write in SIM |
| Same key, different body refused | 107 and 33; 422 with unchanged record/event counts |
| Email case/spacing matches | 125; passes for intake-created People; existing-data gap above |
| Midway failure leaves no partial records | 167; required Opportunity field rejects after earlier writes; records, events and idempotency storage unchanged |
| Intake key cannot read or use `/changes` | 181; 403; normal-key refusal/explicit grants at 193 |
| Burst hits limit | 229; 429, no additional CRM records/events, one operator notice; email/day checks at 246/256 |
| Removing idempotency makes tests fail | Independently reproduced below |
| Full suites and exact website contract | Suites passed; handover includes placeholder-key curl, payload, statuses and retry guidance |

Additional independent probes passed for workspace isolation of matching/idempotency, canonical JSON key order, ten concurrent `/changes` calls producing one record in SIM, unknown intake-field rejection, and revoked intake-key replay refusal. Reviewed all 19 changed files, including Settings wiring and authority checks; found no added embedded credential. Schema changes are additive, and `convex/schema.ts` is byte-identical to rollback target `0398a6addeb8ebba1787f599f3eedc9b0d65a59b`. `git diff --check` passed.

**Mutations caught / survived**

Each mutation was applied separately in scratch and tested with `pnpm --config.verifyDepsBeforeRun=never exec vitest run convex/intake.test.ts`, then restored.

| Mutation | Result |
|---|---|
| `replay()` always returns null | **Caught: 7 failed / 13 passed** |
| Remove email normalization | **Caught: 2 failed / 18 passed** |
| Remove intake-purpose gate | **Caught: 1 failed / 19 passed** |
| Remove abuse-limit checks | **Caught: 3 failed / 17 passed** |
| Overwrite existing Person fields | **Caught: 1 failed / 19 passed** |
| Remove upfront intake-grant precheck | **Survived: 20 passed**; per-write field-grant enforcement still rejects the tested unauthorized calls |

[Mutation summary](/tmp/verify-C-m6/mutation-summary.txt); individual logs are beside it. Scratch probes used the same pnpm option to prevent automatic reinstall through the shared dependency symlink. Final custom probes disabled operational metrics to avoid scheduled telemetry errors when advancing their simulated clock; required suites ran normally.

**What I could not verify**

- Actual Convex OCC interleaving: concurrent tests here use convex-test and can serialize. No backend deployment or service concurrency proof was performed.
- Actual rollback deployment, authenticated browser interaction, and delivery of intake alerts to an operator. Schema compatibility, Settings wiring, queued notices and mocked alert tests are narrower evidence.
- The separate website’s email-first ordering, outage isolation, secret installation or retries. These are outside this checkout.

No production/hosted-service calls, deployments, real email, commits or tracked-file edits were performed. Scratch test/copy files were removed after preserving evidence as text. The checkout remains clean. Verdict saved at `/tmp/verify-C-m6/verdict.md`.