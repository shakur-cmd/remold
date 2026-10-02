VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, independently verifying D-m4. Reviewed `20ead7f50aaac61f15fcd256a39fa0943df7e7c7` on `m4/funnels` against the job-specific base `origin/integ/m3` (`20f561e`). Evidence level: SIM. Read VERIFY.md, the job brief, M4 context, builder handover, and the authored diff.

**Must-fix defects**

1. **Date filters include records from the preceding local day.** `src/lib/fields.ts:33` expands the lower bound to the earlier UTC/local midnight. In America/New_York, a task at `2026-10-01T02:00:00Z` displays as September 30, 10 PM. Filtering October 1 through October 1 returns it. An independent probe called `dayRange` and `records.list`: expected `[]`, received `["Outside September 30"]`. Fix: use the same calendar-day semantics as display, handling UTC-midnight all-day values separately instead of widening one interval. Add an exclusion test for the preceding local day.

2. **Date filters exclude the final hour on the DST fallback day.** The same line adds a fixed 24 hours to midnight. In America/New_York, November 1, 2026 has 25 hours. A task at `2026-11-02T04:30:00Z` displays as November 1, 11:30 PM, but a November 1-only filter excludes it. Independent probe: expected `["Inside November 1"]`, received `[]`. Fix: calculate the next calendar midnight, then subtract one millisecond; test both DST transitions alongside all-day values.

3. **Steps are sorted after pagination, hiding urgent steps.** `src/routes/RecordPage.tsx:420` requests 100 related records in creation order; line 432 sorts only those loaded records. Created 100 December 1 steps, then an October 1 step named “Urgent.” The exact query and sorting used by Steps put “Future 0” first and omit “Urgent” from the first page. Fix: paginate by due date before rendering, with undated steps last. Add a test with an urgent step created after the first page.

All three failures are recorded in `/tmp/verify-D-m4/probes.log`: **3 failed, 8 passed**, including the six existing funnel tests. No fixes were made.

**Should-fix**

- `convex/lib/list.ts:94` and line 96 cap board aggregation at 4,000 records. Static review confirms that larger boards cannot equal a full filtered export. The builder discloses this and the UI adds “+”; explicitly communicate partial totals or provide complete aggregation. The cap was not load-tested.
- Add maintained UI behavior coverage for New funnel, quick-add/done, filter controls, and step ordering. Reversing step order survived the entire application test suite.

**What I verified and how**

Required commands run in the reviewed checkout:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Already up to date; completed |
| `pnpm typecheck` | Passed; no diagnostics |
| `pnpm test` | 33 files, 133 tests passed |
| `pnpm test:authority` | 17 files, 99 tests passed |
| `pnpm verify:release` | 19 passed, 0 failed |
| `pnpm build` | Built successfully; chunk-size warning |

No timeout flakes occurred. Logs are `/tmp/verify-D-m4/{install,typecheck,test,authority,release,build}.log`.

Every testable Done-when item has an existing test: two-funnel counts/sums versus exports; AND filters with inclusive date boundaries and outside records; unreadable-field rejection; migration idempotency. I reran them. Extra independent probes passed for foreign-workspace filter/range/group/object rejection and masking the funnel name when Task.About is hidden. The full suite also exercises inherited agent stage guards.

Reviewed writes continue through existing record mutations/applyChange. No new external-send path, embedded credential, or schema change was found in the diff. Release checks passed against metadata naming rollback target `63dc87b`; this is not a deployed rollback rehearsal.

**Mutations caught/survived**

Executed in a scratch copy using `node node_modules/vitest/vitest.mjs run convex/funnels.test.ts`, except where noted:

- Double summed amounts: caught, totals/export test failed.
- Remove query-field permission guard: caught, unreadable-field test failed.
- Change inclusive upper index bound to exclusive: caught, range test failed.
- Remove campaign field definition: caught, including migration test failure.
- Increment existing field order during migration: caught by the targeted “second run changes nothing” test.
- Reverse UI step ordering: **survived**, full suite still 133/133.

Raw evidence: `mutation-*.log`. After restoring implementation, funnel and field tests passed **21/21** (`restored.log`). Scratch test files and the mutation checkout were deleted.

**Could not verify**

No local backend/browser session was started, so I did not independently reproduce screenshots, quick-add interactions, or rendered layout. Builder screenshots are not independent proof. Production migration, live data compatibility, service performance, and actual rollback remain unverified. No deployment, hosted-service verification, or real email was performed. The reviewed checkout remains clean; no tracked files were edited and no commits were made.