# Job M handover: agent onboarding and workspace map

Branch `remold/agent-onboarding`, base 4bce955. Final commit: see `git log -1` on the branch (the handover is committed with the code). Builder-run, SIM only. Not independently verified. Not pushed.

## What changed
- `convex/agentApi.ts`: `me` and `objects` bodies moved into `meOf` and `objectsOf` (same output, shared); new internal query `map`.
- `convex/http.ts`: `GET /api/v1/map`.
- `ops/authority/inventory.json`: registered `agentApi:map` and `HTTP GET /api/v1/map` (same classification as `objects`: agent principal, masks projected).
- `packages/mcp/src/index.ts`, `client.ts`: tool `remold_map`; server instructions now say start with `remold_map`, then `remold_inbox`.
- `packages/mcp/README.md`: mentions `remold_map` and the Settings snippets.
- `src/lib/agentSetup.ts`: pure snippet builder (Claude Code command, `.mcp.json`, Codex `config.toml`, generic MCP JSON, test line).
- `src/components/AgentsCard.tsx`: after creating a key, shows those snippets with copy buttons (existing CopyBlock), key shown once as before. Intake and Gmail keys are unchanged.
- Tests: `convex/agentMap.test.ts`, `src/lib/agentSetup.test.ts`, one case in `packages/mcp/src/client.test.ts`.

## Decisions
- Map reuses `objectsOf` (the exact `/objects` logic), so read scopes, hidden fields and write modes cannot drift from `/objects`.
- Counts: `take(1001)` per readable object on `by_object`, then filtered by `canReadRecord` (so a record-scoped agent counts only its records), reported as at most 1000 with `countCapped: true`. At most 1001 reads per object; no full scans. Cost: a scoped agent on a huge object may see a smaller capped number than the real total, which is the safe direction.
- Features list = standard object keys present AND readable: campaigns, emails, posts, invoices. `bookingPages` and `automations` are listed only if objects with keys `bookingPage` or `automation` exist; they do not exist in this build, so they never appear today.
- `canDo` is derived from the same per-field write modes as `/objects` plus the delete grant: "apply directly" objects, "propose" objects, then constant lines for shape proposals and the inbox. The inbox line is unconditional because per-item visibility is checked by `remold_inbox` itself.
- Pending counts reuse `me`'s (visible inbox, suggestions, own shape proposals).
- The setup snippets use the README's exact path placeholder `/absolute/path/to/remold/...`: the app cannot know the person's checkout. The panel says to replace it. A unit test reads the README and asserts the Claude command and Codex `args` agree with the builder.
- Removed the REST curl example from the issued-key panel (the README still has it) to keep the panel to the four client blocks.
- Claude `.mcp.json` block includes `"type": "stdio"`; the generic block does not.

## New env vars
None.

## Fail-before / pass-after
- `convex/agentMap.test.ts` on base code (no route): 3 failed, 1 passed (the 401 test already passed on base). Failing: scoped agent map, caps, features. After: 4/4 pass.
  - "shows only readable objects and fields, with write modes and counts, to a scoped agent": a hidden field (`company.name`) and its value `Atlas` are absent, `venue` unreadable and absent, person fields all `propose` on create, company `update` is `direct`, counts correct.
  - "reports counts only for readable objects and caps them at 1000": 1005 rows inserted, count 1000, `countCapped`; object absent until read access given.
- `src/lib/agentSetup.test.ts` on base: file failed (module did not exist). After: 4/4 pass (URL and key in every block, no other `rm_` key or secret words, README agreement, test line).
- `packages/mcp/src/client.test.ts` "reads the workspace map with one GET": added with the client method; passes.

## Suites (final)
- `pnpm typecheck`: clean.
- `pnpm test:authority`: 17 files, 101/101 (needed the inventory entries; before adding them the inventory test failed 1/101).
- `pnpm verify:release`: pass 37, fail 0.
- `pnpm build`: built.
- `pnpm test`: 474 passed, 3 failed of 477. The 3 failures are timeouts under machine load in `gmailSync.test.ts` (fails the same way on the untouched base, re-run on it: timed out in 5000ms) and `Calendar.drag.test.tsx` (a different case fails or passes between runs; one run failed, base run passed). Same pattern Job F recorded. None touch this change. Not clean green; stating that plainly. New tests are included in the 474.

## Rollback compatibility
No schema change, no new tables or fields, nothing for `seed:ensureStandard`. The previous release runs against the same data unchanged. Rolling back only removes `/api/v1/map`.

## Owner setup to go live
None beyond a normal deploy. Agents then see the new snippets on next key creation; existing keys can call `/api/v1/map` immediately.

## Not done / uncertain
- No screenshot of the setup panel: Settings needs a signed-in WorkOS session, and I did not get a local backend with sign-in running. The panel was typechecked and built but not seen in a browser.
- Map latency on a workspace with very many objects was not measured (each readable object costs up to 1001 reads, run in parallel).
