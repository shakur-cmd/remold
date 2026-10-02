VERDICT: PASS

Independent verifier: Astra (gpt-6-astra) via Codex. Job B2-m3-r2, branch `m3/reminders-guards`, commit `c44423f9804e17a5ec3fbcae60fd130ab770ea3a`, compared with `origin/build/unified-remold-2026-09-24`. Acceptance is **SIM only**, not production certification.

## Must-fix defects

None found. Round 1's protected-reference deletion bypass is fixed. Direct agent deletions and applied agent proposals now refuse protected lookup/links cleanup atomically; human deletion still works. Removing that fix in scratch reproduces all four failures.

## Should-fix

- **Concurrency regression coverage:** `convex/reminders.test.ts:118–129` runs overlapping actions only after a successful send. Removing the duplicate-day check from `convex/reminders.ts:35` leaves all eight reminder tests green. My independent probe starts two first sends together: the submitted implementation sends once; the mutant sends twice. Add that scenario to the permanent suite. Evidence: `claim-guard-off.log`, `claim-guard-independent.log`, `probes.log`.
- **Capacity:** `convex/reminders.ts:26` always selects the first 1,000 opted-in members, so later members have no continuation path. `convex/today.ts` limits lists to 50 tasks and 20 quiet deals without an email truncation notice. Paginate recipients and disclose truncated lists before expanding usage.
- **Settings coverage:** both toggles are present and their backend mutations are tested, but there is no interaction test proving that clicking each checkbox persists the intended setting. Add local interaction coverage.

## Independently verified

Required commands ran in the supplied checkout:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Exit 0; already up to date; pnpm 11.23.0 |
| `pnpm typecheck` | Exit 0 |
| `pnpm test` | Exit 0; 29 files, 115 tests passed |
| `pnpm test:authority` | Exit 0; 17 files, 98 tests passed |
| `pnpm verify:release` | Exit 0; 19 passed, 0 failed |
| `pnpm build` | Exit 0; built in 1.87s; bundle-size warning only |

No timeout flakes occurred. Logs are in `/tmp/verify-B2-m3-r2/`, named after each command, with colons replaced by hyphens.

Requirement checks:

- **Email:** tests verify Resend URL/method/bearer/plain-text payload, case-insensitive allowlisting, refusal, missing configuration, once-only warning and failure handling. Resend fetches are stubbed.
- **Reminders:** tests verify default-off, opt-in/out, 11:00 UTC cron declaration, due/overdue/timed tasks, quiet deals, done-task removal, Today link, workspace isolation, daily deduplication, retry and read-only opt-out. Composition reuses `today.daily`.
- **Alerts:** tests verify email-only delivery, allowlisting, retry, deduplication and independent webhook delivery. Existing open/resolve/webhook tests remain green.
- **Agent guards:** tests cover forward/backward/terminal stages, direct writes, proposal creation/application, protected fields, admin-only configuration, unchanged data on refused reference cleanup and human edits.
- **Audit:** the read-only reconciliation test checks both returned `late: true` and the stored receipt.
- **Environment handover:** includes non-secret examples for `RESEND_API_KEY`, `REMOLD_EMAIL_FROM`, `REMOLD_EMAIL_ALLOWLIST`, `REMOLD_APP_URL` and `REMOLD_ALERT_EMAIL_TO`.
- **Rollback:** schema changes are additive optional fields/indexes. HEAD's schema is byte-identical to named rollback target `da767dfe138ce49894cd859858a440d4658611bd`. Rollback restores Round 1 behavior, including its known guard defect; schema compatibility does not make that target equally safe.

Five additional independent behavior probes passed: reminder record scopes/hidden titles/hidden due dates/removed membership; simultaneous first sends; edited stage-option ordering; retired protected lookup cleanup; retired protected links cleanup. The cleanup probes check records/events/links remain unchanged on refusal.

Read the authored diff, including authority inventory and release metadata. No embedded credential was found in that diff. Generated API declarations were hand-maintained by the builder; no lockfile change. No tracked files were edited and no commits were made.

## Mutations caught / survived

Each mutation ran separately in `/tmp/verify-B2-m3-r2/mut` and was restored afterward. Command: `node node_modules/vitest/vitest.mjs run <test-file>`. Audit used `--config ops/authority/vitest.config.ts`; alert/audit mutations selected their named test with `-t`.

| Mutation | Result |
|---|---|
| Remove allowlist refusal | Caught: 1 email test failed |
| Remove once-only warning guard | Caught: 1 email test failed |
| Disable reminder sender | Caught: 6 reminder tests failed |
| Remove daily cron | Caught: 1 reminder test failed |
| Exempt reference cleanup from guard | Caught: 4 guard tests failed |
| Remove applyChange guard | Caught: 8 guard tests failed |
| Remove proposal-time guard | Caught: 2 guard tests failed |
| Stop storing daily marker | Caught: 2 reminder tests failed |
| Stop releasing failed-send marker | Caught: 1 reminder test failed |
| Require writer for opt-out | Caught: 1 reminder test failed |
| Remove alert email deduplication | Caught: selected test failed, 20 sends instead of 1 |
| Remove read-only late classification | Caught: selected test failed, `late: false` |
| Remove claim's duplicate-day refusal | **Survived existing 8/8 tests; caught by independent probe, 2 sends instead of 1** |

Before/after evidence: `cleanup-guard-off.log` versus `restored.log`; `claim-guard-independent.log` versus `probes.log` and `restored.log`. After restoration, all 25 selected tests passed: 20 existing tests plus five independent probes. Mutation failure messages were inspected; failures were behavioral, not compilation failures. `mutations.json` and individual logs retain results. Scratch test/source copies and runner scripts were deleted after recording evidence.

## Could not verify

Real Resend delivery, production environment configuration, hosted cron execution, authenticated Settings interaction, browser appearance, deployment, regenerated Convex API declarations and live rollback were not exercised. No production/hosted-service calls, deploys or real email occurred. The existing redirect test uses loopback HTTP only.

The implementation passes this independent SIM verification. UI interaction and live delivery remain unverified.