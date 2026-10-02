VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, independently verifying B1-m3 at `31c07c20d2295ce5e36a22d9c27a4ea61bfc1c1b`, branch `m3/time-activity`. Evidence level: SIM. Three must-fix defects remain despite passing required suites.

**Must-fix defects**

1. **Explicit midnight instants display as the wrong local day/time.** `src/lib/fields.ts:15`, `:22`, `:55` infer “all day” from divisibility by 86400000. With `withTime: true`, `2026-10-02T00:00:00Z` in America/New_York should edit as `2026-10-01T20:00`; it instead edits as `2026-10-02T00:00` and displays a date without time. Passing that displayed input through `inputToDate` yields `2026-10-02T04:00:00Z`, four hours later. This proves a conversion defect, not that clicking Save without changing the input necessarily shifts it. Fix: render with-time values consistently as instants; distinguish legacy/all-day values explicitly if needed. Add midnight and local-day-boundary regression tests.

2. **The replacement timeline removes access to older related notes.** `convex/records.ts:36`, `:49` cap each kind at 200 without a cursor. `src/routes/RecordPage.tsx:129` hides the previous paginated Note/About panel, while `:470` loads only change events. A fixture with 201 related notes returns 200 timeline entries and omits `Note 0`; the existing related-record paging returns all 201 on the same fixture. Fix: page related entries as well, or preserve an accessible paginated related list. Increasing the cap only postpones the defect.

3. **CSV silently accepts invalid timed values and discards their time.** `convex/csv.ts:57` falls through to the permissive date parser when `instant()` rejects input. Importing `2026-10-02T09:00`, `2026-10-02T25:00:00Z`, and `2026-02-30T09:00:00Z` creates three records with no errors. Export yields midnight October 2, midnight October 2, and midnight March 2 respectively. Fix: for with-time fields, reject invalid timestamps instead of falling back to date-prefix parsing; keep plain-date compatibility separate.

All three reproduced against unmodified feature code. Evidence: [probes.log](/tmp/verify-B1-m3/probes.log); reproducible checks: [probes.patch](/tmp/verify-B1-m3/probes.patch).

**Should-fix**

- Add a behavior test for the merged timeline’s ordering and Load more interaction. Removing the client sort at `src/routes/RecordPage.tsx:401` survived all 18 relevant activity/history/field-helper tests. Backend paging tests do not exercise the rendered merge.
- Explicitly document the breaking `/records/:id/events` response transition from an array to `{ events, nextCursor }` for external consumers. No external consumer compatibility was verified.

**Verified commands and results**

All required commands ran independently and exited 0:

| Command | Summary |
|---|---|
| `pnpm install --frozen-lockfile` | Already up to date; pnpm 11.23.0 |
| `pnpm typecheck` | Both TypeScript checks clean |
| `pnpm test` | 29 files, 109 tests passed |
| `pnpm test:authority` | 17 files, 98 tests passed |
| `pnpm verify:release` | 19 passed, 0 failed |
| `pnpm build` | Built successfully; chunk-size warning |

Logs are under `/tmp/verify-B1-m3/`. No timeout flakes occurred.

Done-when coverage reviewed:

- Time/settings: `time.test.ts`, `fields.test.ts`, and `csv.test.ts` cover offset preservation, plain-date regression, metadata creation and local-time helpers. Midnight and CSV rejection gaps are above; Settings clicks are not exercised by those tests.
- Activity/migration: `activity.test.ts` verifies fields/options, polymorphic links, additive metadata and second-run equality.
- Timeline/task updates: `activity.test.ts` verifies related kinds and notes on tasks; authority masks tests verify hidden values. Full merged UI ordering lacks coverage.
- History: `history.test.ts` pages 250 events through both app query and REST, checks exact order/completeness, and rejects a malformed REST cursor.
- Screenshots: inspected builder task-timeline and date-time-editor images. They exist and show the requested UI, but are builder evidence.

Additional scratch permission probes passed: related-record scope, hidden About field, foreign timeline target, foreign REST history, and refusal of ungranted agent Activity creation. An initial verifier fixture incorrectly used IDs from separate mock databases; corrected to distinct workspaces in one database before drawing conclusions. Restored feature checks plus these probes passed 28/28; restored masks passed 4/4.

Reviewed the base-to-HEAD diff, schema, write paths and rollback declaration. The only schema addition is optional `fields.withTime`; schema matches rollback target `398eb48e0bee522c086b3788f8db0a2143aef799`. No new secret or external send path was found in the diff. Activity writes retain applyChange/events. Migration is a single internal mutation and its repeated-run test passed.

**Mutations caught/survived**

Scratch mutations ran with `node node_modules/vitest/vitest.mjs run <test-files>`; masks used `--config ops/authority/vitest.config.ts`. Each caught mutation failed on a behavioral assertion, not compilation.

| Mutation | Result |
|---|---|
| Truncate timed input to a day | Caught: 2 time tests failed |
| Skip existing due-field migration | Caught: migration test failed |
| Omit notes from timeline | Caught: related-items test failed |
| Ignore app history cursor | Caught: 1200 events instead of 250 |
| Ignore REST history cursor | Caught: 600 events instead of 250 |
| Return unmasked timeline title | Caught: secret-title assertion failed |
| Remove backend timeline sort | Survived: 4/4 activity tests passed |
| Remove client merged-timeline sort | Survived: 18/18 relevant tests passed |

Per-mutation logs and `mutations.py` are retained beside the verdict. Mutations were restored before passing checks; scratch test files and the scratch checkout were deleted after preserving the probe patch. The supplied before logs were reviewed; independently observed mutation failures and restored passes provide the red/green comparison.

**Could not verify**

No independent browser/local-backend session was started, so native Convex cursor behavior, reactive UI paging and interactive screenshots are not certified. No hosted/production calls, deployments or email were performed. Production migration, real-data rollback and external-client compatibility remain unverified. The named rollback’s old code can discard time when editing timed values, as the handover notes.

Tracked checkout remained clean; no files were committed. This independent review is complete; B1-m3 awaits fixes and fresh verification.