VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, independently verifying D-m4-r2 at `25fa891a46038994b933abee16860090344700bd`, branch `m4/funnels`. Evidence level: SIM. Read VERIFY.md, the job brief, M4 context, builder handover and round-1 verdict. Reviewed the job-specific diff against `origin/integ/m3`, isolating D's changes against the merged `origin/integ/m3b` baseline.

**Must-fix defects**

1. **ISO midnight bounds exclude matching plain-date records.** `convex/agentApi.ts:65` calls `instant()` for every date field. That parser encodes midnight timestamps as midnight + 0.5 ms (`convex/lib/values.ts:21`). For an Opportunity with Close Date October 1, `range[closeDate]=2026-10-01..2026-10-31` returns `["First day"]`, but `range[closeDate]=2026-10-01T00:00:00Z..2026-10-31T23:59:59Z` returns `[]`, HTTP 200. The inclusive lower boundary is incorrectly shifted past the stored plain date. **Fix:** distinguish bound parsing from with-time storage encoding; plain-date bounds must use the actual timestamp. Add a regression proving equivalent bare-date and ISO-midnight ranges include the boundary record.

2. **Steps still silently omit urgent work after the first 1,000 created tasks.** `convex/lib/list.ts:136` takes 1,000 rows in creation order before sorting by due date at line 138. Created 1,000 December 1 steps, then an October 1 step named “Urgent,” all through applyChange. First result: “Future 0.” Walking every page returns 1,000 tasks, never “Urgent,” and ends with `isDone: true`. No overflow indication is returned. **Fix:** page the complete matching set in due order, with undated rows last, without truncating by creation order first. Add a regression beyond the cap proving the urgent task appears first and every task remains reachable.

Independent probe evidence: `/tmp/verify-D-m4-r2/probes.log`, **2 failed, 1 passed**. These failures occur on the unmodified implementation. No fixes were made.

**Should-fix**

- Add maintained UI behavior tests for New funnel, quick-add/done, and filter controls. The checked-in tests do not exercise these interactions.
- Aggregation beyond 4,000 matching records remains partial. The revised UI now explicitly discloses the limit and the cap test passes, but those totals cannot equal a complete filtered export.

**What I verified and how**

All required commands ran independently in the reviewed checkout, with exit status 0:

| Command | Summary |
| --- | --- |
| `pnpm install --frozen-lockfile` | Already up to date |
| `pnpm typecheck` | No diagnostics |
| `pnpm test` | 33 files, 155 tests passed |
| `pnpm test:authority` | 17 files, 99 tests passed |
| `pnpm verify:release` | 19 passed, 0 failed |
| `pnpm build` | Built successfully; chunk-size warning |

Logs: `/tmp/verify-D-m4-r2/{install,typecheck,test,authority,release,build}.log`. No timeout flakes occurred.

Every testable Done-when item has checked-in coverage: two-funnel counts/sums versus filtered exports; two-field AND plus inclusive date range and outside records; unreadable-field rejection; migration idempotency. All passed. Round-1 local-day and DST regressions now pass; server step ordering works for the tested 32-task fixture, but fails at the cap above.

An additional independent permission probe passed: foreign-workspace step targets are rejected, record-scoped readers receive only their allowed tasks, and hiding About suppresses both steps and the Today funnel name. Two initial probe-fixture mistakes were corrected before the final run; they are not product findings.

D's writes reuse record mutations/applyChange. No new external-send path or embedded credential was found in D's diff. Email tests stub fetch. D adds no schema change relative to m3b; inherited m3b changes include an optional reminder field and an index. Release checks name rollback target `d84a95fe148d53dab6e928c6a7512f9bd8685f36`; this is not an actual rollback rehearsal.

**Mutations caught/survived**

Ran targeted tests with `node node_modules/vitest/vitest.mjs run <test-file> -t <test-name>` in a scratch copy. All nine applied mutations were caught:

- Double summed amounts.
- Remove the query-field permission check.
- Omit all-day exclusions from the range filter.
- Sort steps by creation instead of due date.
- Sort steps using a hidden due date.
- Remove the standard Campaign lookup (fixture fails because the field is absent).
- Change existing field order on every migration run.
- Use a fixed 24-hour day across DST.
- Make the upper range index boundary exclusive.

No applied mutation survived. Logs: `mutation-*.log`. After restoring all mutations, funnel and field tests passed **32/32** (`restored.log`). Scratch tests and the mutation checkout were deleted.

**Could not verify**

No local backend/browser session was started, so screenshots, rendered layout and UI interactions were not independently reproduced. Builder screenshots remain builder evidence. Production migration, actual live-data rollback compatibility and service performance remain unverified. No production or hosted-service calls, deployment, or real email were performed. The reviewed checkout remains clean; no tracked files were edited and no commits were made.