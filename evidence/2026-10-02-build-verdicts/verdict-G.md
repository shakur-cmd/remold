VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, independently verifying G-m2 at `ec9d96aef8614df0190680319f1474014907de73` on `m2/import`. Evidence is **SIM** unless stated otherwise. Six must-fix defects remain despite passing repository suites.

**Must-fix defects**

1. **Cleanup deletes records that were never seeded.** [convex/seed.ts:61](/home/old-mac-pro/work/verify/G-m2/convex/seed.ts:61) selects the first matching company create event, then accumulates deletion candidates before confirming a complete seed sequence. Reproduction: in an unseeded workspace, manually create company `Fictional Plumbing Co`, city `Real City`. `demoPlan` lists it for removal; `removeDemo` deletes it and writes a delete event. No seed function was called. Fix: require reliable seed provenance and validate the entire candidate run before selecting any rows. For legacy records, refuse ambiguous histories rather than treating a matching prefix as proof. Add partial-run and manually created anchor tests.

2. **A human edit can bypass edited-row protection.** [convex/seed.ts:71](/home/old-mac-pro/work/verify/G-m2/convex/seed.ts:71) ignores every event whose reason equals `Linked record was deleted`. That reason is caller-controlled through `records.update`. Reproduction: seed, change Ben Sample’s email to `real@example.com` with that reason, then clean up. Ben is planned for deletion and deleted. Fix: preserve human-edited rows regardless of arbitrary reason text; identify any exempt system cleanup through trusted provenance. Add this regression case.

3. **Cleanup modifies non-seed records and does not disclose those writes in its dry run.** [convex/seed.ts:88](/home/old-mac-pro/work/verify/G-m2/convex/seed.ts:88) invokes deletion through `applyChange`, whose reference cleanup updates surviving records. Reproduction: seed, create `Real Person` linked to Fictional Plumbing Co, then clean up. The real person’s company value and lookup projection disappear and `updatedAt` changes. The dry run lists only the 16 demo deletions. This violates “Never touches non-seed records.” Fix: retain candidate demo targets referenced by surviving records, accounting for lookup and links fields transitively, and report the retention reason. Test complete before/after snapshots of real and edited survivors. The builder handover acknowledges this limitation; it remains a defect against the brief.

4. **Import dry runs report `ready` for invalid live-schema inputs.** [convex/imports.ts:37](/home/old-mac-pro/work/verify/G-m2/convex/imports.ts:37) removes unresolved temporary references before validation. Two reproduced cases: a retired `person.company` field containing `@c` returns `ready`, but import rejects `p (person).company: Unknown field "company"`; task `blockedBy: "@t1"` returns `ready`, but import rejects `t2 (task).blockedBy: Expected record array`. Fix: validate field existence, retirement, permissions, cardinality, and live target compatibility before deferring reference-ID resolution. Require query/mutation validation parity tests.

5. **The credential scan accepts long base64-looking values.** [convex/lib/importCheck.ts:26](/home/old-mac-pro/work/verify/G-m2/convex/lib/importCheck.ts:26) requires a digit in every long run and splits on `/`, which belongs to the base64 alphabet. Reproduction: import note body `"YWJjZGVm".repeat(8)`—a 64-character valid base64 string without digits. It returns `imported` and persists the value. Fix: cover long base64-like runs without requiring numeric characters, including the complete base64 alphabet; add alphabet-only and slash-containing cases while retaining intended ordinary-text allowances.

6. **Unknown CLI flags silently turn an intended dry run into a write.** [ops/import/convex.mjs:10](/home/old-mac-pro/work/verify/G-m2/ops/import/convex.mjs:10) puts unknown flags in positional arguments, which the scripts ignore. With a local stub replacing the Convex executable, `remove-demo.mjs --org fixture --prod --dryrun` invoked `seed:removeDemo` with `--prod`; the equivalent records command invoked `imports:batch`. Fix: reject unknown flags, surplus positional arguments, and missing/flag-shaped `--org` values before launching Convex. Add CLI tests proving malformed invocations never spawn a write. These probes made no production calls.

The database reproductions and assertion failures are in [probes.log](/tmp/verify-G-m2/probes.log); CLI evidence is in [cli-calls.jsonl](/tmp/verify-G-m2/cli-calls.jsonl).

**Should-fix**

Use own-property checks or maps for object, alias, and field dictionaries at [convex/lib/importCheck.ts:50](/home/old-mac-pro/work/verify/G-m2/convex/lib/importCheck.ts:50). `{records:[{tmpId:"x",object:"constructor",values:{}}]}` returns no local problems, accepting an unknown object through the prototype chain. With `values:{name:"test"}`, it misleadingly reports unknown keys and an empty known-key list. The server refuses the absent object, but local validation fails its contract. Evidence: [prototype.log](/tmp/verify-G-m2/prototype.log).

**What I verified and how**

Read VERIFY.md, the job brief, repository instructions, the handover and supplied evidence; inspected the full diff against `origin/build/unified-remold-2026-09-24`. Independently matched the approved HTML core SHA256 and its jobs.json companion to `a8c8cd26427a542a98d1060ef1c667149ef4bc46120aa839058163025d49a5fe`.

Commands run in the requested checkout:

| Command | Independent result |
|---|---|
| `pnpm install --frozen-lockfile` | Already up to date; pnpm 11.23.0; exit 0 |
| `pnpm typecheck` | `tsc -b && tsc --noEmit -p convex`; exit 0 |
| `pnpm test` | Final run: 27 files passed; 102 tests passed |
| `pnpm test:authority` | Final run: 17 files passed; 97 tests passed |
| `pnpm verify:release` | 19 tests; 19 passed; 0 failed |
| `pnpm build` | Built successfully; chunk-size warning |

The first concurrent suite runs timed out in `convex/alerts.test.ts`, `convex/rateLimit.test.ts`, and `ops/authority/h0-parity.test.ts`. Reran each file alone using `pnpm exec vitest run <file>` (with `--config ops/authority/vitest.config.ts` for h0-parity): respectively **20/20**, **2/2**, and **5/5** passed. Subsequent full application and authority runs passed. Initial failures and reruns are retained in `/tmp/verify-G-m2/*log`.

Every Done-when requirement has an existing test, but several tests miss unsafe cases:

| Requirement | Existing coverage and independent assessment |
|---|---|
| Batch imports with links intact | `imports.test.ts`: linked company/person/opportunity/project/task/note, blockedBy list, date alias and importer history; passes |
| Repeating a batch creates nothing | `imports.test.ts`: unchanged record/event counts and `already imported`; passes |
| Invalid reference or unknown key rolls back everything | `imports.test.ts`: missing/forward reference, unknown keys, late invalid boolean; passes. Additional probe confirms records, events, links and import markers all roll back |
| Credential-looking values refused | Five existing examples pass; alphabet-only base64 counterexample fails |
| Cleanup removes only seed rows and keeps edited rows | Existing fixture passes; non-seed anchor, reason spoof, and surviving-link probes fail |
| Dry runs write nothing | Existing tests pass. Additional full snapshots of records/events/links/import markers remain identical; validation parity still fails |
| Full suites and production handover | Required commands pass after documented timeout reruns. Handover includes exact production commands with dry runs first; those commands were not executed against production |

Additional SIM probes confirmed cross-workspace reference rejection, per-workspace batch deduplication, unchanged second-workspace records/events/links/import markers after cleanup, and readonly refusal of both mutations. The 12 adversarial probes produced **5 passes and 7 failures**, with the failures supporting findings above. They ran as `node node_modules/vitest/vitest.mjs run convex/verifier.test.ts` in the scratch copy. Scratch pnpm execution initially refused the shared node_modules symlink, so the installed Vitest executable was used directly. Verifier-authored test files were deleted after evidence capture.

Reviewed internal function visibility and HTTP callers: no new public/agent route to these operator functions or caller-supplied actor override was found. The normal authority and field-mask checks remain on writes. No actual secrets were found in the changed code. The import/cleanup tests use simulated data; CLI execution probes used a stub.

Schema changes are additive: only the `imports` table is added. `git diff 83d2a02d202d1667f96f3516ba7efa553f1d0473 HEAD -- convex/schema.ts` is empty, confirming identical schemas at the named rollback target. Tracked files remain unchanged; no commits were made.

**Mutations caught and survived**

Each mutation was applied separately in `/tmp/verify-G-m2/mut`, tested with `node node_modules/vitest/vitest.mjs run convex/imports.test.ts convex/seed.test.ts`, then restored.

| Mutation | Result |
|---|---|
| Disable already-imported early return | Caught: 1 failed, 8 passed |
| Drop temporary-reference resolution | Caught: 1 failed, 8 passed |
| Suppress unknown-key rejection | Caught: 1 failed, 8 passed |
| Suppress credential rejection | Caught: 1 failed, 8 passed |
| Coerce invalid `done: "maybe"` to false | Caught: 1 failed, 8 passed |
| Disable edited-seed protection | Caught: 2 failed, 7 passed |
| Skip dry-run value validation | Caught: 1 failed, 8 passed |
| Remove seed object/title checks from the candidate loop | **Survived: all 9 passed** |

Evidence: [mutations.json](/tmp/verify-G-m2/mutations.json) and individual `mut-*.log` files. The surviving mutation confirms inadequate negative coverage for exact seed selection.

**Could not verify**

No production or hosted-service calls, deploys, or real email were performed. The private client JSON and actual production seed history were unavailable. I did not independently replay the builder’s local-backend SERVICE proof, deploy the rollback target, or verify browser history rendering. The CLI stub proves argument routing, not deployed service behavior. Static schema compatibility and SIM results do not certify a production import or cleanup.