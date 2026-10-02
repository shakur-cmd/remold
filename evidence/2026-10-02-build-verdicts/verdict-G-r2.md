VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, independently verifying G-m2-r2 at `82d2e01fa92c5dc13622b2c4a51d025443e064fc` on `m2/import`. Behavioral evidence is **SIM**. Three must-fix findings remain against the supplied brief; the cleanup finding depends on an unconfirmed change of acceptance criteria.

**Must-fix defects**

1. **Credential scanning still permits long credential-like values.** [convex/lib/importCheck.ts:27](/home/old-mac-pro/work/verify/G-m2-r2/convex/lib/importCheck.ts:27) requires either letters plus digits or adjacent uppercase letters plus lowercase letters. For a note body of `"deadbeef".repeat(8)` or `"/".repeat(64)`, local validation returns `problems: []`, and `imports:batch` returns `imported` and persists the value. These are respectively a 64-character hexadecimal/base64-alphabet run and valid base64 encoding of 48 bytes of `0xff`. Fix: recognize long encoded runs without mandatory digit/capitalization combinations; add these cases to local and server rejection tests. Any ordinary-text exemptions should be explicit and tested.

2. **Import dry-run validation still differs from the write path.** [convex/imports.ts:46](/home/old-mac-pro/work/verify/G-m2-r2/convex/imports.ts:46) and [convex/imports.ts:77](/home/old-mac-pro/work/verify/G-m2-r2/convex/imports.ts:77) do not reproduce all checks performed by `applyChange`. Two independent reproductions:

   - Give the owner a company read scope with `records: []` and `fields: "all"`; import `{tmpId:"c",object:"company",values:{name:"Scoped"}}`. The query returns `ready`; the mutation rejects `c (company): Record scope does not authorize new records`.
   - Through the public field APIs, create required company text field `archivedRequired`, then retire it. Import a company with only its name. The query returns `ready`; the mutation rejects `c (company).archivedRequired: Required field is empty`.

   Fix: share creation-authority and required-field validation between preview and execution, including a consistent policy for retired required fields. Add parity regressions for both cases. The mutation safely refuses; the defect is a misleading preflight result, not a demonstrated write-permission bypass.

3. **Cleanup does not satisfy the supplied seed-provenance requirement.** [convex/seed.ts:57](/home/old-mac-pro/work/verify/G-m2-r2/convex/seed.ts:57) checks title/object and a single create event, without proving seed origin. In an unseeded workspace, manually create company `Fictional Plumbing Co`, city `Real City`. `demoPlan` puts it in `remove`; passing that returned ID to `removeDemo` deletes it. The explicit ID list mitigates accidental execution but does not establish “created by the seed” or “Never touches non-seed records.” The handover claims coordinator approval for replacing provenance with human review; no confirming instruction was supplied during this verification. Fix under the supplied brief: require trustworthy provenance and retain ambiguous legacy rows. Alternatively, provide the approved revised criterion and align the brief/tests before certification. This finding is an acceptance gap if reviewed IDs were intentionally approved as the replacement boundary.

Reproductions and actual outputs: [probes.log](/tmp/verify-G-m2-r2/probes.log), **4 failed / 3 passed** across seven adversarial tests.

**Should-fix**

Stabilize the timeout in [convex/alerts.test.ts:106](/home/old-mac-pro/work/verify/G-m2-r2/convex/alerts.test.ts:106), or document supported suite concurrency. Two default-worker full runs timed out at 5000 ms; the isolated file and the full suite with two workers passed. This is separate from the functional findings above.

**What I verified and how**

Read VERIFY.md, the job brief, AGENTS.md, builder handover and prior verdict; reviewed the diff against `origin/build/unified-remold-2026-09-24`. Independently hashed the reviewed HTML core and matched its jobs.json companion to approved SHA256 `a8c8cd26427a542a98d1060ef1c667149ef4bc46120aa839058163025d49a5fe`.

Commands ran independently in the requested checkout, with temporary test directories redirected under `/tmp/verify-G-m2-r2`:

| Command | Summary |
|---|---|
| `pnpm install --frozen-lockfile` | Already up to date; pnpm 11.23.0; exit 0 |
| `pnpm typecheck` | `tsc -b && tsc --noEmit -p convex`; exit 0 |
| `pnpm test` | Twice: 27 files passed / 1 failed; 107 tests passed / 1 timeout |
| `pnpm exec vitest run convex/alerts.test.ts` | Isolated timeout rerun: 20 passed |
| `pnpm test --maxWorkers=2` | 28 files passed; 108 tests passed |
| `pnpm test:authority` | 17 files passed; 97 tests passed |
| `pnpm verify:release` | 19 tests; 19 passed; 0 failed |
| `pnpm build` | Built successfully; chunk-size warning |

Logs are retained in `/tmp/verify-G-m2-r2/` as `install.log`, `typecheck.log`, `test.log`, `test-rerun.log`, `alerts-rerun.log`, `test-bounded.log`, `authority.log`, `release.log`, and `build.log`.

Every Done-when item was checked against repository tests:

| Requirement | Coverage and result |
|---|---|
| Import links intact | `convex/imports.test.ts`: linked standard objects, blockedBy list, date alias, importer attribution; passes |
| Repeat creates nothing | Same file: unchanged record/event counts and `already imported`; passes |
| Invalid reference/key fails atomically | Same file: missing/forward reference, unknown keys, late invalid boolean; passes. Independent snapshots additionally confirm rollback of records, events, links and import markers |
| Credential-looking values refused | Existing examples pass; additional encoded-run probes fail as above |
| Cleanup only seed rows; edited row retained | `convex/seed.test.ts`: edited-row protection, lookup/links referrers, transitive retention, runtime revalidation and unchanged survivors pass. Seed provenance remains unproved and counterexample fails |
| Dry runs write nothing | Import and cleanup snapshot tests pass; query validation parity remains incomplete |
| Full suites and production commands | Pass with documented timeout handling. Round 2 handover supplies exact production commands, dry runs first, including reviewed cleanup IDs; no production commands were executed |

Additional probes passed cross-workspace reference and cleanup-ID refusal, workspace-local deduplication, readonly cleanup refusal, hidden-field import rejection, and complete snapshots around failed writes and import queries. Static review found no new public/agent caller for the internal operator functions, no client-controlled actor override, and no actual secrets in the changed code. CLI tests execute a local stub and verify malformed flags never reach Convex.

Only the `imports` table is added to the schema. `git diff 83d2a02d202d1667f96f3516ba7efa553f1d0473 HEAD -- convex/schema.ts` is empty, confirming schema identity with the named rollback target. This is static compatibility evidence.

**Mutations caught / survived**

Each change was applied alone in `/tmp/verify-G-m2-r2/mut`, tested using `node node_modules/vitest/vitest.mjs run <target test file>`, and restored. These failures came from behavioral assertions.

| Mutation | Result |
|---|---|
| Disable batch deduplication | Caught: 1 failed / 8 passed |
| Disable temporary-reference resolution | Caught: 4 failed / 5 passed |
| Suppress unknown-key rejection | Caught: 2 failed / 7 passed |
| Suppress credential rejection | Caught: 2 failed / 7 passed |
| Disable edited-row protection | Caught: 2 failed / 2 passed |
| Disable external-referrer protection | Caught: 3 failed / 1 passed |
| Ignore links-field referrers | Caught: 3 failed / 1 passed |
| Skip dry-run value validation | Caught: 2 failed / 7 passed |
| Ignore unknown CLI flags | Caught: 1 failed / 1 passed |
| Disable cleanup title/object guard | Caught: 1 failed / 3 passed |
| Remove the retired-field exemption from preview required-field checks | Survived: 9 passed; no existing test distinguishes this behavior |

Evidence: [mutations.json](/tmp/verify-G-m2-r2/mutations.json) and individual `mut-*.log` files. After restoration, all three job test files passed **15/15**. Scratch implementation files match the checkout; verifier-authored probe tests were deleted. Tracked checkout remains clean; no implementation edits or commits were made.

**Could not verify**

No production or hosted-service calls, deploys, or real email occurred. The private client JSON and actual production seed history were unavailable. I did not independently replay the builder’s local-backend SERVICE proof, deploy the rollback target, or verify browser history rendering. CLI stubs establish routing, not deployed behavior. The claimed coordinator approval for revised cleanup scope remains unconfirmed. These results do not certify a production import or cleanup.