VERDICT: REVISE

Independent verifier: Astra (gpt-6-astra) via Codex. Reviewed `49c03cca3bd8a5b4f28a59e1fc6b928bc31d40d3` on `m5/social-calendar`. Evidence: SIM only.

## Must-fix

**The bounded scan silently drops matching posts and reports complete results.** `convex/lib/daily.ts:32` calls `firstVisible`, which stops after 1,000 candidates (`convex/authority/reads.ts:19–23`). The index window includes out-of-day instants; filtering them consumes that budget. `convex/records.ts:27` sets `truncated` only when more than 500 matches were returned. Today uses the same scan (`convex/today.ts:30`).

Reproduction: request October 5, 2026 in New York, with local bounds 04:00Z through next-day 03:59:59.999Z. Seed 1,000 posts at `Date.UTC(2026,9,5)+1` (October 4 locally), followed by one at `Date.UTC(2026,9,5,12)` (October 5 locally).

- Actual calendar result: `{"records":[],"truncated":false}`.
- Actual Today result: no posts.
- Expected: the one matching post, or an explicit incomplete result with continuation.
- Boundary comparison: with 999 preceding candidates, both queries return the matching post.

Evidence: `/tmp/verify-E-m5-r2/probes.log` and `probe.patch`. Independent probes: **1 failed, 3 passed**. There is only one matching post, below both result limits.

Suggested fix: preserve the bounded read budget while tracking scan exhaustion. Use bounded continuation or queries that avoid spending the budget on off-day candidates. Calendar and Today must expose incomplete results and allow remaining matches to be retrieved. Do not substitute an unbounded scan. Add the 999/1,000 boundary regression for both callers.

## Should-fix

None additional established.

## Verified and how

All required commands ran independently in the checkout, without timeout flakes:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Exit 0; already up to date, pnpm 11.23.0 |
| `pnpm typecheck` | Exit 0 |
| `pnpm test` | Exit 0; 36 files, 165 tests passed |
| `pnpm test:authority` | Exit 0; 17 files, 100 tests passed |
| `pnpm verify:release` | Exit 0; 19 passed, 0 failed |
| `pnpm build` | Exit 0; built successfully; >500 kB chunk warning |

Logs: `install.log`, `typecheck.log`, `test.log`, `authority.log`, `release.log`, `build.log` in `/tmp/verify-E-m5-r2`.

Done-when coverage:

- **Published-link and agent rules:** passing `convex/posts.test.ts`, independently mutation-tested. Covers create/update, link clearing, grants, proposals, settled posts and protected-field retirement.
- **Local month/week placement:** passing `src/components/Calendar.test.tsx`, including 8 PM New York at midnight UTC.
- **Drag saves the date and keeps time:** passing `src/components/Calendar.drag.test.tsx`, real dnd-kit events through a convex-test mutation. Helper tests cover DST and all-day values.
- **Post metadata and migration:** passing tests check required fields, preserve existing metadata, and prove a second migration run changes nothing.
- **Today:** ordinary local-day tests pass; the independent scan-boundary probe fails as above.
- **No provider publishing:** source inspection found no social-provider publishing path in M5. Status updates use `applyChange`; M5 adds no provider action, network call, credentials or scheduler. This is inspection, not a dedicated absence test.
- **Navigation, colors and timeline reuse:** checked in source. The supplied round-two coordinator ruling permits indexed-date-only calendars; the explanatory UI has a passing test.

Additional independent probes passed: foreign-workspace object/field rejection; rejected publication leaves records and events unchanged; Today obeys record scope and masks title/text. Authority tests also cover calendar masking and record scopes.

Reviewed diffs against the VERIFY default base and `origin/integ/m3`; isolated M5 against the handover's merged `origin/integ/m3b`. M5 changes neither schema nor release metadata relative to m3b. The named rollback target remains `d84a95fe148d53dab6e928c6a7512f9bd8685f36`. Lockfile changes accompany the jsdom test dependency. No new secrets found in the M5 diff.

## Mutations caught / survived

Mutated only a scratch archive, restoring each change afterward:

| Mutation | Observed failure |
|---|---|
| Disable published-link guard | 2 Post tests fail; invalid publication resolves |
| Bypass agent guard | Agent approval returns 200 instead of 403 |
| Bucket by UTC day | All 3 calendar component tests fail |
| Disconnect drag-end from `onMove` | Stored date stays October 5 instead of October 8 |
| Drop time when moving | Stored value loses the expected 8 PM instant |
| Remove Post field-retirement guard | Retirement resolves instead of rejecting |

**Six caught; none survived.** Restored code passes **23/23 tests** across Post, calendar components, drag and helpers (`restored.log`). Each mutation has a separate named log. An initial scratch invocation hit pnpm's symlink safety check; setup errors were not counted. Actual runs used `node node_modules/vitest/vitest.mjs run --maxWorkers=2 <test-file>`.

## Not verified / handoff

No hosted or production calls, deployments, real emails or production migration. I did not start/deploy a local backend or independently reproduce browser screenshots. Builder desktop/phone screenshots exist; I inspected the two phone images, but they remain builder evidence. Real touch dragging and browser layout are not independently certified by jsdom. Rollback compatibility was inspected, not exercised against the named rollback binary.

Tracked checkout files remain unchanged; no commit made. Scratch test copies were removed after retaining logs and the reproduction patch. The earlier fixes pass independent mutation checks, but scan exhaustion remains unresolved. Return to the builder, then independently reverify.