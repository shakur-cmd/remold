VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, independently verifying B1-m3-r2 at `4aaedce9e45e25259636d5335e956b34062e1ac4`, branch `m3/time-activity`. Evidence level: SIM. Required suites pass, but three must-fix defects remain.

**Must-fix defects**

1. **Loaded timeline pages lose entries after a write.** `convex/lib/merge.ts:12–18` recomputes fixed-size pages; `src/routes/RecordPage.tsx:389` uses them with `usePaginatedQuery`, which retains the cursor used to load each subsequent page. Reproduction: page size 2, three notes plus the creation event. Before insertion, pages contain `[Note 3, Note 2]` and `[Note 1, create]`. Add Note 4 and rerun both loaded queries with their original arguments: results become `[Note 4, Note 3]` and `[Note 1, create]`. **Note 2 disappears.** The last page is still exhausted. This is a backend reproduction of the hook's query pattern, not an independently observed browser interaction. Suggested fix: use stable reactive page boundaries supported by the pagination implementation, or explicitly rebuild the loaded page chain when its boundaries change. Add insertion/deletion tests across already-loaded pages.

2. **Invalid US-format CSV dates silently become different dates.** `convex/csv.ts:59–61` bypasses strict validation for US-format dates on with-time fields. Import Task due dates `2/30/2026` and `13/1/2026`: result is `{ created: 2, errors: [], skipped: 0 }`; export returns `2026-03-02` and `2027-01-01`. Suggested fix: validate the parsed calendar components before returning the timestamp; reject impossible dates as row errors. The supplied invalid-ISO regression passes but misses this alternate input path.

3. **With-time REST output contradicts the job brief.** `convex/lib/values.ts:81` returns `2026-10-02` for a Task due input of `2026-10-02`. The brief requires plain dates to mean midnight UTC and with-time fields to read back as ISO 8601 UTC with time, so expected output is `2026-10-02T00:00:00.000Z`. Round 2 deliberately changes this contract, and its tests assert the changed behavior. Suggested fix: restore the specified REST output while preserving any required internal legacy-date distinction, or obtain an explicit scope amendment before certification.

All three assertions fail against unmodified HEAD implementation. Evidence: [probes.log](/tmp/verify-B1-m3-r2/probes.log), with reproducible tests in [probes.patch](/tmp/verify-B1-m3-r2/probes.patch).

**Should-fix**

- Add a browser behavior check for Show all → Load more → add a note, and for creating a timed field through Settings. Current helper/backend tests and screenshots do not exercise these interactions.

**Verified commands and results**

All required commands ran independently and exited 0:

| Command | Summary |
|---|---|
| `pnpm install --frozen-lockfile` | Already up to date; pnpm 11.23.0 |
| `pnpm typecheck` | Both TypeScript checks clean |
| `pnpm test` | 29 files, 121 tests passed |
| `pnpm test:authority` | 17 files, 98 tests passed |
| `pnpm verify:release` | 19 passed, 0 failed |
| `pnpm build` | Built successfully; chunk-size warning |

Logs are under `/tmp/verify-B1-m3-r2/`. No timeout flakes occurred.

Done-when coverage:

- **Time and settings:** `time.test.ts`, `fields.test.ts`, and `csv.test.ts` cover offset preservation, explicit UTC-midnight instants, local display/edit helpers, plain-date compatibility, metadata creation and invalid ISO inputs. REST-contract and US-date gaps are above.
- **Activity and migration:** `activity.test.ts` checks fields/options, polymorphic linking, additive migration, and exact metadata equality after a second migration.
- **Timeline and task updates:** tests check notes on tasks, activities/tasks/notes together, dated and undated activity ordering, record-scoped reads, and all 201 related notes. Static paging passes; refreshed loaded pages fail the new probe.
- **History:** `history.test.ts` independently passed exact ordering/completeness through 250 events via app and REST, plus malformed REST cursor rejection.
- **Screenshots:** inspected round-2 task timeline and date-time editor images. They show the requested UI and exist in the handover; they remain builder-produced evidence.

Additional independent safety probes passed: foreign-workspace timeline and REST-history refusal using two workspaces in one test database; denial of ungranted agent Activity creation; hidden Activity time excluded from ordering/output; hidden About removes related membership. An initial safety fixture tried to unhide a field using an already restricted owner and was correctly denied; corrected it to only add restrictions. Restored feature tests plus safety probes passed **40/40** (`restored-safety.log`).

Reviewed the base-to-HEAD diff, write paths and release declaration. Schema additions are optional `fields.withTime` and `records.by_s2_d0`; schema is identical to rollback target `25ec0be183b501d946f845505ff61d418274ab9d`. Activity writes retain applyChange and attributed events. No new secret or external-send path was found in the diff. The breaking REST `/events` response change is documented.

**Mutations caught/survived**

Mutations ran only in a disposable scratch copy using `node node_modules/vitest/vitest.mjs run <test-files>`.

| Mutation | Result |
|---|---|
| Stop marking explicit midnight instants | Caught: time assertion failed |
| Skip existing due-field migration | Caught: missing withTime flag |
| Remove notes from timeline | Caught: 3 activity tests failed |
| Replace timeline sort with reverse | Caught: ordering and complete-note paging failed |
| Ignore merged timeline cursor | Caught: 1200 events instead of 250 |
| Restore permissive ISO CSV fallback | Caught: 7 imports instead of 3 |
| Ignore REST history cursor | Caught: 600 events instead of 250 |

An initial broad replacement changed the separate REST record-list cursor instead of history; it survived the two history tests. That was a mis-targeted mutation, not evidence about history coverage. The correctly targeted history mutation was caught. Logs retain both results. All caught mutations failed behavioral assertions, not compilation. After restoration, the 38 feature tests passed, then 40 including safety probes. Builder before/after logs were also inspected. Scratch tests and checkout were removed after preserving their patch and logs.

**Could not verify**

No independent browser/local-backend session was started. Native Convex execution and interactive Load more behavior are not certified; the refresh defect is reproduced in convex-test and corroborated by the installed hook source. Production migration, real-data rollback, and external API-consumer compatibility remain unverified. No production/hosted-service calls, deployments, or email were performed.

Tracked checkout remained clean; no commits were made. This independent review is complete. B1-m3-r2 requires fixes and fresh verification.