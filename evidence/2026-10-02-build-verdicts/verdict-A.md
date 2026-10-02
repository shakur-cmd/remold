VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, independently verifying A-m0 at `57a7cfb6dd0f51ae170165119db9378302a9b0ef` on `m0/safe-floor`. I read VERIFY.md, the job brief, AGENTS.md, the builder handover/evidence, and the diff against `origin/build/unified-remold-2026-09-24` (merge base `3c4e789`). The original checkout remains clean; no tracked files were edited and no commits were made.

The following defects must be fixed before acceptance:

1. **P1 — Workspace creation accepts an email without proof it is verified.** [convex/orgs.ts:15](/home/old-mac-pro/work/verify/A-m0/convex/orgs.ts:15) rejects only `emailVerified === false`. With open signup disabled, the allowlist set to `shakur@codemyvibe.com`, and an authenticated identity carrying that email but no `emailVerified`, `canCreate` returned `true` and `create` returned an organisation ID. Expected: `FORBIDDEN`. The existing test covers explicit `false`, but misses an absent claim. Require `emailVerified === true` and test absent/false/true claims. Changing that comparison in scratch made the new negative test and all five workspace tests pass. Evidence: [email-probe.log](/tmp/verify-A-m0/email-probe.log), [email-fixed-probe.log](/tmp/verify-A-m0/email-fixed-probe.log). **SIM; production token contents were not inspected.**

2. **P2 — A deleted origin branch still satisfies the recoverability check.** [ops/deploy/prod.mjs:71](/home/old-mac-pro/work/verify/A-m0/ops/deploy/prod.mjs:71) fetches without pruning; line 43 trusts local remote-tracking refs. In a local bare-origin fixture, I pushed a release branch, deleted it directly on origin, and ran the same fetch. Origin had no branch containing the release commit, yet `releasable()` accepted it. Fetch/prune an explicit origin branch refspec and check only refreshed refs. Pruning made this reproduction refuse correctly. Evidence: [stale-origin.log](/tmp/verify-A-m0/stale-origin.log), [stale-origin-fixed.log](/tmp/verify-A-m0/stale-origin-fixed.log). **SIM; local Git only.**

3. **P2 — Relative backup destinations can lose the newly exported file.** [ops/backup/export.mjs:17](/home/old-mac-pro/work/verify/A-m0/ops/backup/export.mjs:17) keeps the destination relative, but line 27 executes Convex from a temporary directory and line 28 removes it. With `REMOLD_BACKUP_DIR=.`, a simulated CLI export wrote its zip inside that temporary directory. Cleanup deleted it; checksum generation then failed with `ENOENT` in the caller’s directory. Resolve the destination to an absolute path before constructing the zip path. Add a CLI-boundary test for `.` and a relative subdirectory, asserting the zip and checksum survive. Evidence: [relative-backup.log](/tmp/verify-A-m0/relative-backup.log). **SIM subprocess; actual filesystem operations, no production export.**

4. **P2 — Required orchestration safeguards lack regression coverage.** Removing the entire `runChecks(...)` call at [prod.mjs:88](/home/old-mac-pro/work/verify/A-m0/ops/deploy/prod.mjs:88) left all seven deploy tests green. Replacing the rollback `restoreDrill(...)` call at line 90 with `{ result: 'PASS' }` also left them green. Add subprocess-level tests proving failed checks and rejected snapshots prevent deployment, and dry runs never deploy. The required invite-only UI also has no committed assertion: my scratch rendering tests passed both states, and caught forcing the create form to appear for denied users. Add that coverage too. Evidence: [mutations.json](/tmp/verify-A-m0/mutations.json), [ui-probe.log](/tmp/verify-A-m0/ui-probe.log), [ui-mutation.log](/tmp/verify-A-m0/ui-mutation.log).

Should-fix items: stabilize the existing alerts timeout so a correct release does not intermittently fail; replace the Bun deployment runner with the required pnpm runner; provide the builder handover in the project-required single-file HTML format. This verifier report uses Markdown as VERIFY.md explicitly requires.

I ran the required commands in `/tmp/verify-A-m0/repo`, an isolated clone of the reviewed commit:

| Command | Independent result |
|---|---|
| `pnpm install --frozen-lockfile` | Exit 0; pnpm 11.23.0 |
| `pnpm typecheck` | Exit 0 |
| `pnpm test` | Initially 100 passed, 1 alerts timeout; final unchanged-code dry run: 28 files / 101 tests passed |
| `pnpm exec vitest run convex/alerts.test.ts` | Isolated timeout rerun: 20/20 passed |
| `pnpm test:authority` | 17 files / 97 tests passed |
| `pnpm verify:release` | 31 passed, 0 failed |
| `pnpm build` | Exit 0; bundle-size warning only |

Logs: [suites.json](/tmp/verify-A-m0/suites.json), [test.log](/tmp/verify-A-m0/test.log), [alerts-rerun.log](/tmp/verify-A-m0/alerts-rerun.log). The first full dry run also hit the alerts timeout. The successful rerun used CPU affinity `taskset -c 0,1`, without changing code or test timeouts.

All five brief items were examined:

- **Deploy:** committed placeholders refused. A complete dry run with temporary values passed with `gallant-pika-581` planted in both `.env.local` and shell variables. It confirmed the production bundle target and printed `pnpm exec convex deploy -y` then `bun x wrangler@4.138.0 deploy`. No deployment ran. Evidence: [dry-placeholder.log](/tmp/verify-A-m0/dry-placeholder.log), [dry-forward-limited.log](/tmp/verify-A-m0/dry-forward-limited.log).
- **Rollback:** floor/key/bundle tests passed. The pinned `566abac` schema accepted my seeded snapshot in a local restore/schema-push rehearsal, preserving canonical data. Schema, authentication configuration, and invite implementation are unchanged by this job. Evidence: [rollback-drill.log](/tmp/verify-A-m0/rollback-drill.log).
- **Workspace creation:** stranger denial, listed creator, spoofed profile, explicit unverified email, open signup, and invite acceptance were exercised. Denial occurs before workspace inserts. The missing verification-claim case fails as reported above. UI rendering passed independently.
- **Backups:** export naming/checksum/no-overwrite helper tests passed. I seeded a local backend, exported it, restored and re-exported: **PASS, 45 tables, 341 rows, 341 restored**. Dropping one of 250 record rows while retaining the original checksum produced **FAIL, exit 1**. Evidence: [drill-pass.log](/tmp/verify-A-m0/drill-pass.log), [drill-dropped-exit.log](/tmp/verify-A-m0/drill-dropped-exit.log).
- **Callbacks:** closed/open HTTP tests passed; removing the gate made them fail. Existing isolation, agent-authority, read-scope and hidden-field suites passed. I found no added credentials or schema contraction in the diff.

Mutation results: **caught** removal of the workspace gate, callback gate, rollback floor, deploy-key check, bundle check, checksum verification and row-count comparison. The verifier’s additional UI test caught bypassing its denied-state rendering. **Survived:** skipping predeploy suites and skipping the rollback schema drill. Mutations were reverted; the temporary added `.test.ts` files were deleted after recording results.

I inspected the handover’s fail-before/pass-after evidence for all five items, both dry-run transcripts, and coordinator deploy/restore instructions. Builder evidence was not treated as certification.

Limitations: no production export, deploy, real email, hosted application-service call, live sign-in, or actual production-data compatibility was verified. Local backend drills ran with external networking disabled. Because the CLI normally queries a hosted version endpoint, a scratch CLI copy pinned its cached backend version to `precompiled-2026-09-28-5c7cb5b`; the harness adaptation is recorded in [offline-harness.diff](/tmp/verify-A-m0/offline-harness.diff). These are local SERVICE results, not LIVE certification. The full older-ref deploy command was reviewed in builder evidence; independently I exercised its floor checks and local schema rehearsal, rather than repeating that entire command.