VERDICT: REVISE

Independent verifier: Astra (gpt-6-astra) via Codex. Job E-m5-r4, branch `m5/social-calendar`, commit `1a1cfc5551af0af8c60aafda38a786d7e3da669d`. Evidence: SIM/local. Reviewed both required base comparisons and the builder's four-round handover.

**Must-fix**

1. **Nonfinite range bounds cause an unbounded loop.** `convex/lib/daily.ts:25–29`, reachable from `records.inRange` (`convex/records.ts:22`) and the shared Today range logic.

   Reproduction: authenticate as a workspace member, use that workspace's Post object and planned field, and call `records.inRange` with `firstDay = lastDay = Date.UTC(2026,9,5)`, `start = end = Infinity`, and `paginationOpts = {cursor:null,numItems:500}`.

   Expected: immediate `VALIDATION` rejection. Actual: validation permits the bounds; the midnight loop initializes `m = Infinity`, and `m += DAY` never advances. The array keeps growing. The isolated public-query probe reached the call and required external termination after three seconds. A direct call to the unchanged `dayIntervals` first returned two intervals for ordinary bounds, then hung on the same invalid input. No hosted-service impact was tested or claimed.

   Fix: validate the four numeric bounds explicitly before either loop, requiring finite, safely representable timestamps within the supported date domain. Add rejection coverage for both public queries, including Infinity, negative Infinity and oversized finite numbers. Do not validate `Object.values(w)`: callers pass additional nonnumeric query arguments.

   Before/after evidence: `range-input.log`, `nonfinite-query.log`, `nonfinite-reached.log` versus `nonfinite-fixed.log`. A scratch-only guard checking `[w.firstDay,w.lastDay,w.start,w.end].every(Number.isSafeInteger)` made the public-query rejection test pass alongside all 13 Post tests: **14 passed**. This confirms the cause; no fix was applied to the checkout.

**Should-fix**

- Make the live calendar tests reliable under the normal test command, through cheaper fixtures or an explicit appropriate timeout. The unmodified `pnpm test` timed out at five seconds in both 501-record calendar tests (`src/components/Calendar.drag.test.tsx:113,124`). The file passed alone with the handover's 15-second timeout; the entire suite also passed with two workers and that timeout. Logs distinguish these runs.

**What I verified and how**

| Command | Independent result |
|---|---|
| `pnpm install --frozen-lockfile` | Exit 0; already up to date |
| `pnpm typecheck` | Exit 0 |
| `pnpm test` | Exit 1; 177 passed, two timeout failures |
| `pnpm test src/components/Calendar.drag.test.tsx --maxWorkers=2 --testTimeout=15000` | Exit 0; 4 passed |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | Exit 0; 37 files, 179 tests passed |
| `pnpm test:authority` | Exit 0; 17 files, 101 tests passed |
| `pnpm verify:release` | Exit 0; 19 passed |
| `pnpm build` | Exit 0; built, existing large-chunk warning |

Done-when coverage:

- `convex/posts.test.ts` verifies standard Post metadata, campaign lookup, additive/idempotent migration, published-link enforcement, agent restrictions despite grants, Today filtering, local-day/DST ranges, read budgets and pinned pagination.
- `Calendar.test.tsx` verifies month/week local-date placement, displayed time, record links and phone dot limits. `calendar.test.ts` verifies date movement and retained local time, including DST. `Calendar.drag.test.tsx` drives real dnd-kit pointer events through the backend mutation and checks the stored timestamp.
- Round-4 regression passes: inserting before an earlier loaded page boundary preserves all 502 posts. My additional live probe also preserved the complete set after a tail insert, moving that record across the page boundary, and deleting it: five component tests passed, including the four existing tests.
- Authority tests cover hidden dates/text, record-scoped calendar results and subsequent Today pages. A separate verifier probe confirmed foreign-workspace object rejection and unchanged records/events after refused publishing. Its first fixture incorrectly used separate databases with colliding synthetic IDs; I corrected it to use two identities/workspaces in one database before drawing conclusions.
- No social-provider publishing path found in the feature: calendar writes use `records.update`/`applyChange`; provider URLs in Post tests are stored strings. Existing email tests mock fetch. No real email was sent.
- Schema matches the named rollback target `d84a95fe148d53dab6e928c6a7512f9bd8685f36` exactly. Migration preservation/idempotency tests pass. No live rollback was attempted.

**Mutations caught/survived**

Each was applied separately in scratch and restored. Tests ran with `node node_modules/vitest/vitest.mjs run <files> --maxWorkers=2 --testTimeout=15000`.

| Mutation | Caught by |
|---|---|
| Disable published-link check | 2 failures |
| Disable agent settled-status guard | 1 failure; HTTP 200 instead of 403 |
| Ignore endCursor | 3 failures, including 501 instead of 502 visible posts |
| Bucket by UTC date | 6 failures |
| Disable drag callback | 1 failure; stored date unchanged |
| Drop time when moving | 4 failures |

All six caught; none survived. Initial pnpm launches in the symlinked scratch copy were refused by its module-directory safety check and do not count as mutation evidence. The direct Vitest runs above produced assertion failures.

**Could not verify / boundaries**

- No standalone backend or fresh browser screenshots this round. Builder screenshots remain builder evidence; independent UI checks used component rendering and jsdom, not phone-browser visual certification.
- No hosted calls, deployments, production migration, real email, or service-level rollback. This is not production certification.
- The calendar still requires indexed date fields, with an explanatory UI for unindexed fields, as accepted in the supplied round-2 handover. Phone month mode does not support dragging; week mode supplies the drag view.
- Tracked checkout remained clean; no commits. Temporary scratch checkouts/tests were removed after evidence capture. Logs and this verdict remain under `/tmp/verify-E-m5-r4`.