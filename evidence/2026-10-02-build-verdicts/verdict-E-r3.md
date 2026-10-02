VERDICT: REVISE

Independent verifier: Astra (gpt-6-astra) via Codex. Reviewed `739ccd8307b843331dcd25361aeb4d5b184451c7` on `m5/social-calendar`. Evidence level: SIM/local.

## Must-fix

**Live pagination silently loses a post when an earlier page's boundary changes.** `src/lib/pages.ts:17` retains previously collected cursors; lines 24–28 only follow the last page. They never reconcile a changed continuation cursor from an earlier live page. Calendar consumes this hook at `src/components/Calendar.tsx:38`.

Independent reproduction using the real Calendar and convex-test backend:

1. Create 501 posts on October 5, 2026, at noon UTC. Load the week calendar and its two pages: all 501 appear.
2. Create another post at 11:00 UTC and refresh the active query results, as live subscriptions do.
3. The first page now ends at Post 498, but the second still starts after the old boundary, Post 499.

| Check | Before insertion | After insertion |
|---|---:|---:|
| Expected displayed posts | 501 | 502 |
| Actual displayed posts | 501 | 501 |

Post 499 disappears. The calendar displays no “Load more” warning. This is a display omission, not a deleted database record.

Evidence: `/tmp/verify-E-m5-r3/live-probe.log` records `firstCursorChanged:true`, `actualAfter:501`, `expectedAfter:502`, `missing:"Post 499"`, and `loadMoreShown:false`. The independent assertion fails while the file's three existing tests pass. Reproduction: `live-probe.patch` and `probe-add.txt` in the same directory; run the patched test with `node node_modules/vitest/vitest.mjs run src/components/Calendar.drag.test.tsx --maxWorkers=2 --testTimeout=15000`.

Suggested fix: reconcile each page's successor with its current returned cursor, discard/refetch dependent pages when that boundary changes, and truncate successors when an earlier page becomes complete. Preserve bounded reads and stable subscriptions. Add an insertion/move regression; checking only initial page loading misses this defect.

## Should-fix

**Bound the phone month-view dots.** `src/components/Calendar.tsx:171` renders one dot per post without the desktop cap. The supplied `calendar-month-phone.png` visibly stretches October 20 into a tall column of 520 dots. Cap dots and show a count, retaining the selected-day list. This finding combines source inspection with builder imagery; I did not independently capture browser layout.

## Verified and how

All six required commands ran independently:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Exit 0; already up to date; pnpm 11.23.0 |
| `pnpm typecheck` | Exit 0 |
| `pnpm test` | Exit 1; 170 passed, 1 timeout, 36 files |
| `pnpm test:authority` | Exit 0; 17 files, 101 tests passed |
| `pnpm verify:release` | Exit 0; 19 passed, 0 failed |
| `pnpm build` | Exit 0; built successfully; >500 kB chunk warning |

The timeout was `convex/alerts.test.ts > counts each failed run exactly once across page boundaries` at the default 5-second limit. Required isolated rerun, `pnpm test convex/alerts.test.ts`, passed all 21 tests, exit 0. The original full run is not reported as clean. Logs are under `/tmp/verify-E-m5-r3/`.

Done-when coverage:

- Published-link and agent rules: passing Post tests, independently mutation-tested. Covers create/update, blank or cleared links, grants, proposals, settled posts, and protected-field retirement.
- Local placement in month/week: component tests pass, including 8 PM New York at midnight UTC. UTC-placement mutation fails.
- Drag persistence and kept time: real dnd-kit pointer events through convex-test pass. Disconnected drag and lost-time mutations both fail. Helpers also cover DST and all-day dates.
- Post metadata and additive migration: tests verify required fields, unchanged pre-existing metadata, and idempotent reruns. Existing generic record timeline is reused.
- Today and initial pagination: tests pass for local-day filtering, 999/1,000 preceding off-day rows, and continuation past 1,000 published posts. Authority tests cover calendar and Today continuation masking and record scopes. Live page-boundary changes remain defective as above.
- No social-provider publishing path found in M5: source inspection shows metadata changes through applyChange, without a new provider action, network call, scheduler, credentials, or SDK. This is inspection, not an automated absence test.
- Navigation, view switch, color selection, and indexed-field explanation were inspected. The handover's coordinator ruling expressly permits indexed-date-only calendars with an explanation.

Two additional independent probes passed: foreign-workspace object/field rejection, and rejected publication leaving both record and events unchanged. After restoring every mutation, the focused Post/calendar/helper tests plus these probes passed **31/31 across five files** (`restored-and-safety.log`).

Compared the requested `origin/integ/m3` diff, inspected the default-base change inventory, and isolated M5 against merged `origin/integ/m3b`. M5 changes neither schema nor release metadata relative to m3b. The named rollback target is `d84a95fe148d53dab6e928c6a7512f9bd8685f36`. The lockfile adds the jsdom test dependency and its transitive packages. No new secrets found in the M5 diff.

## Mutations caught / survived

All implementation mutations were confined to the scratch copy and restored afterward.

| Mutation | Observed failure |
|---|---|
| Disable published-link guard | Invalid publication resolves instead of rejecting |
| Bypass agent guard | Approval returns 200 instead of 403 |
| Bucket by UTC day | Three calendar component tests fail |
| Disconnect drag-end callback | Stored date remains October 5 instead of October 8 |
| Drop time when moving | Stored value loses the expected 8 PM instant |
| Report budget/page exhaustion as complete | Expected `done:false`, received `true` |
| Omit equal-date continuation | Expected 1,001 records, received 501 |

**Seven caught; none survived.** Individual `mutant-*.log` files and `run-mutants.py` preserve the evidence. The separate live-update defect was uncovered by a new behavioral probe.

## Not verified / handoff

No hosted/production calls, deployments, real email, or production migration. I did not start a local backend or independently reproduce browser screenshots. I inspected builder phone-month and desktop-week screenshots; they remain builder evidence. Real touch interaction and browser layout are not independently certified by jsdom. Rollback compatibility was inspected, not exercised against the named rollback binary.

Tracked checkout files remain unchanged; no commit made. Scratch test copies were removed after preserving logs and reproduction evidence. Return the live-pagination defect to the builder, then independently reverify the fix.