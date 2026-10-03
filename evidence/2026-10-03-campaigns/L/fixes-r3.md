# L fixes r3 (verifier follow-ups F1, F2)

## Changes
- F1 `convex/orgs.ts` `create` takes optional `timeZone`; stored via `validZone`, "UTC" if invalid, left unset if omitted. `src/routes/Home.tsx` passes `Intl.DateTimeFormat().resolvedOptions().timeZone`. Existing workspaces untouched.
- F2 `orgs.setTimeZone` re-aims `dueAt` of the org's switched-on schedule automations with `nextDue(schedule, now, newZone)`. dateReached automations hold no due time (they read the zone at each tick), so nothing to recompute.

## Failing first (fix stashed)
- zone.test.ts "takes the creator's browser zone when a workspace is created, UTC when it is not a zone": FAIL
- automations.test.ts "changing the workspace zone moves a switched-on schedule's next due time...": FAIL, expected 1791190800000 (09:00Z) to be 1791205200000 (09:00 New York)

## Passing after
- pnpm test: 61 files, 608 tests passed
- pnpm typecheck: clean
- pnpm test:authority: 17 files, 101 tests passed
- pnpm verify:release: pass 37, fail 0
- pnpm build: built
- packages/mcp build: ok; test: 10 passed

Not independently verified (builder run).
