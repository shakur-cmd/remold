# D round 3 fixes (verdict notes 2 and 3, probe Q6)

## Note 2 / Q6: setGrants keeps grants on unread objects
Change: convex/agents.ts `setGrants` now carries over the agent's stored grants on objects it cannot read (not in its read set) unless the new list already has them. They stay inert until read returns, as in setReadAccess (B1). Nothing widens: only grants already stored are kept, and the new-grant read check is unchanged.

Test (convex/agentAccess.test.ts, "toggling a grant keeps a stored grant on an object the agent cannot read"): agent holds stored `create venue` on an unread Venue; toggle `update company`; stored grants must be both, and the list still shows only `update company`.

- Before fix (convex/agents.ts stashed): FAIL `expected [ 'update company' ] to deeply equal [ 'create venue', 'update company' ]`
- After fix: PASS (1 passed)

## Note 3: readsEverything on principals
Chose comments, not setting the flag: neither principalFor (convex/authority/grants.ts) nor the suggestion-apply agent principal (convex/suggestions.ts) reaches sharedInboxReader, and computing the flag costs an objects query per call. Absent fails closed, so a comment is the smaller, safe change.

## Suites (pnpm test with --testTimeout=60000 --maxWorkers=2)
- pnpm test: 54 files passed, 469 tests passed
- pnpm typecheck: clean
- pnpm test:authority: 17 files, 101 tests passed
- pnpm verify:release: 37 pass, 0 fail
- pnpm build: built OK
