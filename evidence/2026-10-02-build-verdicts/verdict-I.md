VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, independently verifying I-m10 at `747e7cbbd82804b3c2360a6e758ebb8c15dd7f3e` on `m10/first-customer`. Evidence level: **SIM only**. Existing suites pass, but ten additional safety assertions fail.

**Must-fix defects**

1. **Imported history leaks another workspace's agent name.** [workspace.ts:138](/home/old-mac-pro/work/verify/I-m10/convex/workspace.ts:138) trusts the imported `actor`; [events.ts:15](/home/old-mac-pro/work/verify/I-m10/convex/events.ts:15) dereferences that ID without checking workspace ownership. Importing an event into A with B's agent ID, then calling `events.forRecord` as A, returned `actorName: "CONFIDENTIAL B AGENT"`. A had no membership in B. Preserve imported attribution as historical provenance, not an unrestricted live database reference; authorize every actor lookup. Add this two-workspace regression.

2. **Import is neither failure-safe nor exclusive, and silently drops unknown fields.** [workspace.ts:61](/home/old-mac-pro/work/verify/I-m10/convex/workspace.ts:61), lines 113–139. A missing relation left two empty records after failure; retrying the valid export returned `Import needs a workspace with no records, history or agents`. Two simultaneous imports both succeeded, leaving four records, two referencing deleted object definitions. An unknown field containing `MUST NOT DISAPPEAR` was silently discarded by line 127. Validate the entire document before replacing definitions; use an exclusive, resumable import operation with staging or cleanup, idempotent batches, and a final publication step. Reject invalid fields, duplicate IDs/keys, and invalid relations explicitly.

3. **Import bypasses a newly enabled read-only hold.** [workspace.ts:84](/home/old-mac-pro/work/verify/I-m10/convex/workspace.ts:84), lines 91, 102 and 106: only `importDefinitions` calls `writable`. Enabling read-only immediately after definitions committed still allowed two records and two events to be imported. Recheck the hold and import-operation authority in every writing mutation, leaving an interrupted import recoverable.

4. **Export has no consistent snapshot.** [workspace.ts:38](/home/old-mac-pro/work/verify/I-m10/convex/workspace.ts:38) independently queries definitions, records, and history. Updating a company's name between record and event reads produced record value `Original` alongside the latest update event saying `New name`. The same collector supplies the pre-deletion backup. Introduce a consistent snapshot or a workspace revision/write fence with validation and retry; deletion must freeze writes before constructing its recovery export.

5. **Deletion starts before the owner receives the export.** [workspace.ts:154](/home/old-mac-pro/work/verify/I-m10/convex/workspace.ts:154) commits `beginDelete` before returning the file; [WorkspaceCards.tsx:60](/home/old-mac-pro/work/verify/I-m10/src/components/WorkspaceCards.tsx:60) downloads only afterward, despite promising the reverse. Injecting a response failure after that commit resulted in no returned export and a completely deleted workspace after scheduled work drained. Persist a retrievable recovery export or use an export/delivery acknowledgment step before scheduling irreversible removal. Test response loss and retry.

6. **Deletion setup performs unbounded writes.** [workspace.ts:147](/home/old-mac-pro/work/verify/I-m10/convex/workspace.ts:147) collects and deletes every member, then patches every agent, in one mutation. A fixture with 402 members deleted all 402 before scheduled purge began. The existing batch-size assertion measures only later purge steps. Make `deletingAt` an immediate authorization fence for humans, agents, and background execution, and remove/revoke rows through bounded scheduled batches. Include setup in the boundedness test.

7. **Billing transitions lack replay protection and attributed events.** [billing.ts:50](/home/old-mac-pro/work/verify/I-m10/convex/billing.ts:50), lines 63–68, drops the Stripe event ID and accepts equal timestamps. Three correctly signed deliveries—active, canceled, then replay of the original active event, all with the same `created` second—left the flag **active**. A separate signed transition changed the flag while all four audit/event table counts remained zero. Persist verified event receipts, deduplicate by event ID, define same-second/subscription ordering, and write an attributed transition event atomically with the flag. Add replay and audit regressions.

8. **The named rollback target cannot continue pending deletions.** [notes.json:3](/home/old-mac-pro/work/verify/I-m10/ops/release/notes.json:3) names `f2f7021`, whose tree has no `convex/workspace.ts`, while deletion schedules `workspace:purge`. Schema equality is confirmed, but worker compatibility is absent. The handover acknowledges stranded deletions and manual recovery. Supply a compatible rollback worker or an enforced drain/recovery gate, plus an interrupted-deletion rollback rehearsal. This finding is based on source/tree inspection; no deployment rollback was attempted.

9. **Required behavior tests can pass with broken behavior.** [Legal.test.tsx:15](/home/old-mac-pro/work/verify/I-m10/src/routes/Legal.test.tsx:15) accepts a missing draft marker because `indexOf` returns `-1`, which is less than 80. Replacing the warning with `Final, approved.` left all five legal tests green. Always displaying `No subscription` in Settings and marking pending gate rows done also survived all 16 job tests. Assert marker presence and position, exercise Settings status and data controls, and add a falsifiable check for gate content and evidence. The brief's test requirement is not satisfied by the current coverage.

All runtime reproductions above are recorded in [probes.log](/tmp/verify-I-m10/probes.log), including inputs, observed outputs and failed assertions. Interleaving and response-loss probes wrapped the real action handler and injected changes between actual convex-test queries/mutations; these are deterministic SIM fault injections, not hosted transport tests.

**Should-fix**

- Imported history retains `events.at`, but history pagination/timeline ordering still uses `_creationTime` (`convex/events.ts:48`, `:102`). Preserve original chronology consistently in readers and test history mixed with later native events.
- Definition collection, ghost-ID allocation, import arguments and export returns need explicit supported-size limits and boundary tests. Large-workspace completion is unproven.
- Gate rows for deferred onboarding/sign-up/backups lack concrete evidence paths in places. Keep their status pending, and reference the owning job or evidence location. The builder handover is Markdown despite the project's HTML handover convention.

**What I verified and how**

Read `VERIFY.md`, the job brief, `AGENTS.md`, the builder handover and evidence, M10 scope and gate checklist. Examined the required diff against `origin/build/unified-remold-2026-09-24` and isolated the job changes against `origin/integ/m3b`.

| Command | Independent result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Already up to date; pnpm 11.23.0 |
| `pnpm typecheck` | Exit 0 |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | 35 files; 158 passed |
| `pnpm test:authority --maxWorkers=2 --testTimeout=15000` | 17 files; 99 passed |
| `pnpm verify:release` | 19 passed; 0 failed |
| `pnpm build` | Exit 0; built in 1.21s; chunk-size warning |
| `node_modules/.bin/vitest run convex/workspace.test.ts convex/billing.test.ts src/routes/Legal.test.tsx --maxWorkers=2 --testTimeout=15000` | 3 files; 16 passed |
| Scratch `node_modules/.bin/vitest run convex/verifier.test.ts --maxWorkers=2 --testTimeout=15000` | 10 assertions failed, reproducing the defects above |

Logs are under [/tmp/verify-I-m10](/tmp/verify-I-m10). No test timeout flakes occurred. An initial scratch invocation through `pnpm exec` refused the symlinked dependency directory before running tests; those results were discarded. Scratch tests then used the already-installed Vitest executable.

Coverage against the brief: export/import has a passing fixture round trip, ID/link remapping and owner/mask restrictions; export and deletion have passing two-workspace isolation tests; deletion's fixture counts every org-owned schema table and integration pages; legal pages render publicly with the requested text and footer links; billing tests stub Stripe and exercise real HMAC verification, test-mode gating and live-key refusal. The gate checklist and handover env list exist, and the handover explicitly states that nothing charges money. These passing checks do not cover or negate the defects above.

The schema changes are additive and byte-identical to the named rollback target's schema. A focused scan of job-added lines found no private-key blocks or long Stripe, Resend or AWS credential patterns; this is not a comprehensive secret audit. No production/hosted-service calls, deployments, real emails or charges were made. No tracked files were edited and no commits were created; final git status and diff-check output are clean.

**Mutations caught/survived**

Each mutation was applied separately in the scratch copy and restored afterward. Counts below are assertion failures, not infrastructure errors.

| Mutation | Result |
| --- | --- |
| Remove records' workspace filter from export | Caught: 2 failures |
| Keep old links IDs during import | Caught: 1 failure |
| Omit consent from purge | Caught: 1 failure |
| Bypass webhook signature verification | Caught: 1 failure |
| Permit live Stripe keys through configuration | Caught: 1 failure |
| Replace legal draft warning with approval text | Survived: 5/5 legal tests passed |
| Always show `No subscription` in Settings | Survived: 16/16 job tests passed |
| Mark pending gate rows done | Survived: 16/16 job tests passed |

Detailed results: [mutations.json](/tmp/verify-I-m10/mutations.json) and `mutant-*.log`. Temporary probe tests were deleted after execution as instructed.

**Could not verify**

Hosted Convex limits and scheduler behavior, real Stripe TEST-mode interoperability, authenticated Settings behavior in a browser, production identity/data, deployed rollback, or any LIVE behavior. No SERVICE, SANDBOX or LIVE certification is claimed. Legal approval, live billing approval, onboarding, pricing and the remaining first-customer gates remain pending.