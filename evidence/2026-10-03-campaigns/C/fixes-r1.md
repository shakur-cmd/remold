# Job C fixes, round 1 (verifier should-fix 1 to 3)

Level: SIM (unit tests with convex-test and vitest). No hosted service touched. Verification of these fixes by a fresh session is still pending.

## 1. REST 500 for SLOTS_EXHAUSTED
- convex/http.ts: `SLOTS_EXHAUSTED: 409` added to `statusFor`.
- convex/shape.test.ts "a lookup with no index slot left" now asserts `agentStatus` is exactly 409 (`both` returns it; its other callers use `toMatchObject`).
- Fail before: `AssertionError: expected 500 to be 409` (shape.test.ts, 1 failed | 19 passed).
- Pass after: shape.test.ts 20/20 at that point.

## 2. Verifier probes are now permanent tests
- Merged into convex/shape.test.ts as `describe("shape proposal guards")`, 11 tests (probes P1 to P11, console.log removed). Adjusted: P8 expects 409; P11's audit check ignores unrelated `legacyGrantsFrozen` rows; the P11 "second agent" probe was dropped (it only logged). P1 gained an addObject proposal from the other org, because the object-level checks hide the row-org check for field proposals and only addObject exposes it (first attempt left X1 green).
- Guard removal, one at a time, `vitest run convex/shape.test.ts`, then restored:

| Guard | Removed | Result (test that went red) |
|---|---|---|
| X1 cross-org id check | `row.orgId !== principal.org._id` in authorize | RED: a proposal id from another org is not found for apply or dismiss |
| X2 revoked/epoch | `active(agent, row)` check in apply | RED: revoked agent test, grants-change test |
| X5 agent unrestricted | agent branch of `unrestricted` returns true | RED: restricted admin agent cannot add objects ... |
| X6 requireObjectAdministration in checkNewField | line removed | RED: restricted admin agent ... |
| X8 lookup-target readability | `target && !canReadObject` in authorize | RED: scoped admin sees and applies only ... |
| X9 requireLabel | made a no-op | RED: unknown kinds, bad status and blank labels ... |
| X10 agent `?status=` | list ignores status | RED: agent list honours ?status= ... |
| X11 /me pending count | counts all statuses | RED: agent list honours ?status= ... |
| X13 unknown kind | refusal replaced by a working proposal | RED: unknown kinds, bad status and blank labels ... |

First pass had X1 and X13 green. X1 was fixed by the P1 change above. X13's first mutant was bad (it still failed as a 400); a mutant that actually accepts the unknown kind went red. Script: /tmp/mut.py (not kept).

## 3. MCP `remold_list_records` filter restored
- packages/mcp/src/index.ts: `filter` accepted again beside `filters` and `range`.
- packages/mcp/src/client.ts: `filter` is sent as `filter[field]=value`, the same form as `filters` (REST still also accepts the old `filter=&value=` form).
- New test "still accepts the single filter and sends it as REST's filter[field]" covers the old shape, and old and new together. Existing test covers `filters` and `range`.
- Fail before (client.ts reverted): `expected [ [ 'object', 'person' ], ...(4) ] to deeply equal [ ...(3) ]`, 1 failed | 5 passed. After: 6/6.
- Not covered: the zod schema in index.ts itself (the file starts a stdio server on import).

## Suites after the fixes
- pnpm test: 51 files, 398/398 passed
- pnpm typecheck: exit 0 (a first run caught untyped `unknown` values in the new tests; fixed)
- pnpm test:authority: 17 files, 101/101 passed
- pnpm verify:release: 37 pass, 0 fail
- pnpm build: built
- pnpm --dir packages/mcp test: 6/6 passed
