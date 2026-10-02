VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, independently verifying D-m4-r3 at `e8792880c94f1cc61bb9a31ca40889c0b35e967a`, branch `m4/funnels`. Evidence level: SIM. Read VERIFY.md, the job brief, M4 context, builder handover and prior verdict. Inspected the reference-base diff inventory and reviewed D's changes against the merged `origin/integ/m3b` baseline.

**Must-fix defect**

1. **An inclusive ISO upper bound excludes a task due exactly at midnight.** `convex/agentApi.ts:65–68` passes the exact timestamp to the range; `convex/lib/list.ts:72` compares it directly with the stored slot. Midnight instants are stored as midnight + 0.5 ms (`convex/lib/values.ts:21,33`).

   Reproduction: create Task “Midnight” through `records.create`, with Due Date `Date.UTC(2026,9,1) + 0.5`, the standard encoding of `2026-10-01T00:00:00Z`. Request:

   `GET /api/v1/records?object=task&range[dueDate]=2026-09-30T23:59:59Z..2026-10-01T00:00:00Z`

   Expected: `["Midnight"]`. Actual: HTTP 200, `[]`. Widening only the upper bound to `2026-10-01T00:00:00.001Z` includes the task. Independent probe fails on the unmodified implementation; evidence: `/tmp/verify-D-m4-r3/probes.log`.

   Suggested fix: make with-time comparisons account for the midnight storage encoding at inclusive upper bounds, consistently across index, filter and record-scoped paths. Preserve exact plain-date bounds and separate all-day semantics. Add a regression for a midnight instant exactly at the upper bound; the existing regression tests midnight at the lower bound and an end-of-day upper bound.

**Should-fix**

- Add maintained UI behavior tests for New funnel, quick-add/done, and filter controls. Checked-in tests do not exercise these interactions.
- Totals above 4,000 matching records remain partial. The UI discloses the cap, but those totals cannot equal a complete filtered export.

**What I verified and how**

All required commands passed independently in the checkout:

| Command | Summary |
| --- | --- |
| `pnpm install --frozen-lockfile` | Already up to date |
| `pnpm typecheck` | No diagnostics |
| `pnpm test` | 33 files, 157 tests passed |
| `pnpm test:authority` | 17 files, 99 tests passed |
| `pnpm verify:release` | 19 passed, 0 failed |
| `pnpm build` | Built successfully; chunk-size warning |

Logs: `/tmp/verify-D-m4-r3/{install,typecheck,test,authority,release,build}.log`. No timeout flakes or reruns were needed.

Every testable Done-when item has passing checked-in coverage: counts/sums versus filtered exports for two funnels; two-field AND plus inclusive date range with outside records; unreadable-field rejection; migration idempotency. Earlier plain-date ISO-bound and 1,000-step truncation regressions pass. The 1,002-step test reaches every step once, with the urgent step first and undated step last.

An additional independent permission probe passed: foreign-workspace steps/totals are rejected; record-scoped readers receive only their allowed steps and totals; hiding About suppresses steps and Today funnel associations. Final independent probe result: **1 failed, 1 passed**. An initial permission-fixture update accidentally requested broader authority and was correctly refused; the fixture was corrected before the final run.

D's writes reuse applyChange-backed record mutations. No new external-send path or embedded credential was found in D's diff; email tests stub fetch. D adds no schema change relative to m3b. Release checks name rollback target `d84a95fe148d53dab6e928c6a7512f9bd8685f36`; this is not a live rollback rehearsal.

**Mutations caught/survived**

Ran `node node_modules/vitest/vitest.mjs run <file> -t <name> --maxWorkers=2` in a scratch copy. All eight mutations were caught by assertion failures:

- Double summed amounts.
- Remove the query-field permission check.
- Make the upper range index boundary exclusive.
- Add 0.5 ms to parsed REST bounds.
- Truncate steps to 1,000 rows.
- Read steps in creation order instead of due order.
- Change field order on every migration run.
- Remove Today funnel associations.

No applied mutation survived. Logs: `mutation-*.log` and `mutations.log` under the verification directory. After restoring mutations, funnel and field tests passed **34/34** (`restored.log`). Scratch tests and the mutation copy were deleted. The scratch pnpm launcher initially refused a symlinked modules directory; invoking the installed Vitest directly resolved that harness issue.

**Could not verify**

No local backend/browser session was started, so rendered layout, screenshots and UI interactions were not independently reproduced. Builder screenshots remain builder evidence. Production migration, live-data rollback and service performance remain unverified. No production or hosted-service calls, deployment, or real email were performed. No tracked files were edited, no commits were made, and the checkout remains clean.