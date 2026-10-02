VERDICT: PASS

I am Astra (gpt-6-astra) via Codex, independently verifying G-m2-r3 at `e731a3048f6662a9b62c5728882f3473047f74d5` on `m2/import`. This verdict covers the revised job brief. Behavioral evidence is **SIM**, with local CLI stubs; production behavior is not certified.

**Must-fix defects**

None found. The round-2 credential and creation-validation findings are resolved. The revised brief explicitly approves the reviewed-ID cleanup boundary, replacing the seed-provenance requirement.

**Should-fix**

Stabilize [convex/alerts.test.ts:106](/home/old-mac-pro/work/verify/G-m2-r3/convex/alerts.test.ts:106). Both the default full suite and `--maxWorkers=2` timed out at 5000 ms in “counts each failed run exactly once across page boundaries.” The isolated file passed 20/20; the full suite passed 110/110 with two workers and a 15-second timeout. Two workers alone did not eliminate this existing flake on this machine. Adjust the test’s timing strategy or document a sufficient timeout. No tracked test settings were changed.

**What I verified and how**

Read VERIFY.md, the revised job brief, AGENTS.md, the builder handover, prior verdict, and round-3 coordinator rulings. Reviewed the diff against `origin/build/unified-remold-2026-09-24`. Independently matched the reviewed HTML core and jobs.json to approved SHA256 `a8c8cd26427a542a98d1060ef1c667149ef4bc46120aa839058163025d49a5fe`.

Commands ran independently, with temporary directories redirected under `/tmp/verify-G-m2-r3`:

| Command | Actual result |
|---|---|
| `pnpm install --frozen-lockfile` | Already up to date; pnpm 11.23.0; exit 0 |
| `pnpm typecheck` | `tsc -b && tsc --noEmit -p convex`; exit 0 |
| `pnpm test` | 27 files passed / 1 failed; 109 tests passed / 1 timeout |
| `pnpm exec vitest run convex/alerts.test.ts` | Isolated rerun: 20 passed |
| `pnpm test --maxWorkers=2` | 27 files passed / 1 failed; 109 tests passed / same timeout |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | 28 files passed; 110 tests passed |
| `pnpm test:authority` | 17 files passed; 97 tests passed |
| `pnpm verify:release` | 19 tests; 19 passed; 0 failed |
| `pnpm build` | Built successfully; chunk-size warning |

Logs: [suite summary](/tmp/verify-G-m2-r3/suites-summary.log), [default test run](/tmp/verify-G-m2-r3/test.log), [isolated rerun](/tmp/verify-G-m2-r3/alerts-rerun.log), [two-worker run](/tmp/verify-G-m2-r3/test-bounded.log), [adjusted-timeout run](/tmp/verify-G-m2-r3/test-timeout-adjusted.log). Other command logs are retained beside them.

Every Done-when item has behavioral test coverage:

| Requirement | Evidence |
|---|---|
| Batch imports with links intact | `convex/imports.test.ts`: lookup, polymorphic and links references, date alias, counts and named importer attribution |
| Repeat creates nothing | Same file: `already imported`, unchanged record/event counts; independent probe also checks links and import markers |
| Invalid reference or unknown key writes nothing | Same file: missing/forward references, unknown keys and late invalid scalar; independent full-table snapshots verify rollback |
| Credential-looking values refused | Same file: word/prefix rules, hexadecimal/base64/base64url runs and approved path/URL exemptions; independent 39/40-character boundary probes pass |
| Cleanup honors reviewed IDs and protects edited rows | `convex/seed.test.ts`: exact ID boundary, title/object checks, edited rows, lookup/links referrers, transitive retention, runtime revalidation and unchanged survivors |
| Dry runs write nothing | Import and cleanup snapshot tests; independent snapshots include records, events, links and import markers |
| Full suites and production instructions | Results above; Round 2 handover supplies exact production commands, dry runs first, reviewed cleanup file via `--ids`; Round 3 retains them |

Eight additional adversarial probes passed: foreign workspace references and cleanup IDs; workspace-local deduplication; rollback after links were created; hidden fields and creation field scopes; retired custom lookup referrers; reviewed-subset and readonly cleanup refusal; ordinary public creates with active versus retired required fields; and credential boundaries with server-accepted paths. Evidence: [probes.log](/tmp/verify-G-m2-r3/probes.log).

Static review found no new public or agent route to the internal operator functions, no client-controlled actor override, and no actual secrets in the changed code. CLI tests use a local Convex stub and prove malformed invocations cannot dispatch. Existing authority tests pass after the shared validation refactor.

Only the `imports` table is added. `git diff 83d2a02 HEAD -- convex/schema.ts` is empty, confirming schema identity with rollback target `83d2a02d202d1667f96f3516ba7efa553f1d0473`. This establishes static compatibility, not a deployed rollback rehearsal.

**Mutations caught / survived**

Each mutation was applied alone in `/tmp/verify-G-m2-r3/mut`, tested with `node node_modules/vitest/vitest.mjs run <target test file> --maxWorkers=2`, then restored. Repository tests caught all 14 valid mutations:

| Mutation | Failing tests |
|---|---:|
| Disable batch deduplication | 1 |
| Break temporary-reference resolution | 4 |
| Suppress unknown-key rejection | 2 |
| Suppress credential rejection | 2 |
| Disable long encoded-run detection | 2 |
| Skip dry-run creation authorization | 1 |
| Skip dry-run required-field checks | 1 |
| Require retired required fields again | 1 |
| Disable edited-row protection | 2 |
| Disable outside-referrer protection | 3 |
| Ignore links-field referrers | 3 |
| Disable seed title/object guard | 1 |
| Ignore unknown CLI flags | 1 |
| Ignore reviewed IDs and select all workspace records | 3 |

None survived. An initial reviewed-ID mutant used a nonexistent index and was discarded; the corrected version fails behavioral assertions, including deleting a record when the reviewed list is empty. Evidence: [mutations.json](/tmp/verify-G-m2-r3/mutations.json), individual `mut-*.log` files, and [corrected ID-boundary result](/tmp/verify-G-m2-r3/mut-reviewed-ids-corrected.log).

The restored job tests plus independent probes passed **25/25**. All scratch source files match the checkout after restoration; the verifier-authored test was deleted. The tracked checkout remains clean, with no implementation edits or commits. Evidence: [restored tests](/tmp/verify-G-m2-r3/restored.log), [integrity check](/tmp/verify-G-m2-r3/integrity.log).

**Could not verify**

No production or hosted-service calls, deploys, or real email occurred. The private client JSON and production workspace state were unavailable. I did not independently replay the builder’s local-backend SERVICE proof, deploy the rollback target, or inspect browser history rendering. CLI stubs verify routing rather than deployed behavior. Actual production import and cleanup remain subject to the coordinator’s dry runs and explicit ID review.