# Job E independent verification: PASS

Verifier: Claude Fable 5.1 (this session), independent of the builder (Sol 6.1 / Codex).
Subject: `fix/sol-review` at `139c7c7` (diff vs base `aa68030`), checked out detached in `~/scratch/iv-E`, `pnpm install --frozen-lockfile`.
Evidence level: SIM/SANDBOX (vitest + convex-test, local MCP client with injected fetch). No hosted service touched. No edits to the main repo, nothing pushed.

## Suites (all run here, exit 0)

| Command | Result |
|---|---|
| `pnpm test` | 52 files, 414/414 passed. The builder's one sandbox failure (`listen EPERM` on the redirect test) does not reproduce; it was the builder's sandbox, not the code. |
| `pnpm typecheck` | clean |
| `pnpm test:authority` | 17 files, 101/101 |
| `pnpm verify:release` | 37 pass, 0 fail |
| `pnpm build` | built in 680ms |
| `pnpm --dir packages/mcp test` | 8/8 |

## Fix-by-fix: fixed, fails without the fix, side effects

Method: for each finding, revert only that fix (file or single hunk) on top of 139c7c7, rerun `convex/jobE.test.ts` (+ MCP suite), confirm the finding's tests go red, restore. Then run my own probes (`~/scratch/iv-E-probe.test.ts`, 8 tests, all green on 139c7c7) for the behavior-change questions.

| Finding | Red without the fix | Fixed | Side-effect probe |
|---|---|---|---|
| F3 stale delete conflicts | `convex/suggestions.ts` reverted: 3 red (changed, added, hidden-value conflict) | Yes. `suggestions.ts:52-55` compares the union of reviewed and current keys; conflicts are re-projected through `row()` so newly hidden values do not leak. | No false positive: a no-op update (same values) still applies; a cleared value (set to null) conflicts and the record survives (P-F3). |
| F4 CSV atomic rows | `convex/csv.ts` reverted: 2 red (number, required) | Yes. Each row runs in `internal.csv.importRow` (`csv.ts:114`); a throw rolls back the row's lookup creation, record, links and events. False comment removed. | Dedupe semantics preserved: existing csv test still sees in-batch "Website" twice as `skipped: 1` without the removed `seen` set; a bad row mid-batch leaves earlier/later good rows and their companies intact, ghost company absent (P-F4). `createMissing` unchanged. |
| F10 MCP idempotency | `packages/mcp/src/client.ts` reverted: 2 red in MCP suite + 2 red in jobE; `convex/http.ts` alone reverted: 1 red (proposal/inbox/shape dedupe) | Yes. Header sent, key stripped from JSON; REST now binds keys for `propose`, `proposeShape`, `inboxAdd`, `inboxResolve`, `markReplied` (`http.ts:62`). | Same key with a different body or route is `IDEMPOTENCY_MISMATCH`; keys are per agent (P-F10). |
| F11 date bounds | `convex/lib/values.ts` reverted: 1 red | Yes. `supported()` bounds years 1000-9999 on numbers, day strings and instants (`values.ts:14,23,32`). | Live data safe: all-day 0 (1970-01-01), 1950, 2200-12-31, instant 0.5 and a pre-1970 instant all write via the human path and read via REST; `range[closeDate]=1940..2200` still lists; REST all-day "1970-01-01" still accepted (P-F11). |
| F12 retired values vs delete | single hunk `retained \|\| !field.retired` reverted in `agentApi.ts`: 2 red (none, protected); hidden stays refused as control | Yes. Retained definitions are included only for `action === "delete"` (`agentApi.ts:105`). | Retired values never appear in the delete proposal or delete response (`readable`/`readableMap` still skip `field.retired`) (P-F12). |
| F13 discovery | `capabilities` and `withTime/protectedFromAgents/write` removed in `agentApi.ts`: 2 red | Yes. `/me.agent.capabilities` projects id, capability, scope, mode, delegate, expiresAt from `principal.capabilities` (own valid grants only). `/objects` fields add `withTime`, `protectedFromAgents`, `write.{create,update}` in direct/propose/none. | `/me` shows nothing from another agent's grants, nothing revoked, no key hashes; a hidden field is absent from `/objects` entirely and other fields' write modes match actual authority (P-F13 x2). Additive: existing `grants` kept. |
| F14 `remold_record_events` | MCP client reverted: `pages record events` red | Yes. Tool registered (`packages/mcp/src/index.ts:19`), client encodes id and cursor, REST paging exercised end to end in jobE. | None observed. |
| F16 Today reuse, `findByTitle` | old `today` assembly restored in `agentApi.ts`: 1 red (retired Done parity) | Yes. REST `today` calls shared `daily()` (`agentApi.ts:91-96`); `findByTitle` has zero callers in convex/src/packages/ops/scripts/bin after removal; typecheck clean. | Output shape unchanged: `{ tasks, quiet }`, record keys `createdAt,id,object,ref,title,updatedAt,values`. With real data (overdue, today, +5d, +30d, done; one quiet deal and one fresh), REST ids and order equal the app's `today.get` (P-F16). |

## Findings

No blockers.

### Should-fix

1. **F16 parity test is weak.** `convex/jobE.test.ts:81` ("REST Today uses the app selection for retained done values") asserts `result.tasks` equals the app's list, then asserts both are `[]`. It would pass if both paths returned nothing for any reason. My P-F16 probe with five tasks and two deals is the test that actually proves parity and order; recommend adding it (or equivalent) to the suite. Not a blocker: the behavior is correct.

### Notes

2. **Per-record field lookups in Today.** `agentApi.ts:94` `show()` calls `objectForId` (a `fields` collect) once per record, up to 70 times per `/today`. The old code did it once per object. Harmless at current scale; a `Map` by `objectId` would restore it.
3. **CSV row cost.** `importRow` re-runs `importTarget` (writer check, fields collect, column checks) for every row, so a 100-row batch does ~100x the auth/metadata reads it did before. Correctness is the priority here and this is the review's own suggested alternative; flag only if import batches get slow.
4. **In-batch dedupe now depends on search-index visibility within one transaction** (the `seen` set was removed). Convex documents search as transactionally consistent and convex-test agrees (existing csv test, P-F4). Worth one SERVICE check on a dev deployment the first time a real import runs with `skipDuplicates`.
5. **F11 does not clean existing stored values** outside 1000-9999; `readableValue` would still throw on one. The handover says so. Live data in 1970-2200 is unaffected (P-F11).
6. **Handover header is stale**: it says "Final commit hash: unavailable" because the builder's sandbox could not write `.git`; the coordinator committed the same tree as `139c7c7`. The handover also calls the `pnpm test` EPERM failure "pre-existing"; it is environmental and passes here.
7. `remold_me` tool description still says "this agent's grants"; it now also returns `capabilities`. Copy only.

## How to re-check

```
git -C /Users/urkel/Documents/CodeMyVibe/Projects/remold worktree add ~/scratch/iv-E2 139c7c7
cd ~/scratch/iv-E2 && pnpm install --frozen-lockfile
cp ~/scratch/iv-E-probe.test.ts convex/ivE.probe.test.ts
pnpm exec vitest run convex/jobE.test.ts convex/ivE.probe.test.ts   # 24 pass
git show aa68030:convex/suggestions.ts > convex/suggestions.ts && pnpm exec vitest run convex/jobE.test.ts   # 3 red
```

Worktree `~/scratch/iv-E` removed after this verdict was written.
