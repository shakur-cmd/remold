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

## Round 2 (after Fable's REVISE)
Merged origin/integ/campaigns (f94e828) into the branch, then fixed the verdict's items. Builder-run, not re-verified, not pushed.

### Merge
Conflicts in `agentApi.ts`, `http.ts`, `mcp/client.ts`, `mcp/index.ts`. Resolution: integ's `objects` (archived filter, `includeArchived`, retiredFields, slotsLeft) is now `objectsOf(ctx, principal, includeArchived = false)`, used by both `objects` and `map`, so the map never lists archived objects or counts them. `/objects?include=archived` and the client's `objects({ includeArchived })` are kept. MCP instructions are integ's full text (views, automations, retire/archive) with only the opening changed to "Start with remold_map ... Then call remold_inbox".

### Changes
- Counts (blockers 1 and 2): `count` is now the string `"0"`, `"1-50"`, `"50+"` or `"unknown"`. Per readable object the map reads at most 51 records through `takeRecords` (new, `convex/lib/list.ts`), which uses the same `plan` as `/records`, so record-scoped agents count only their own records and unreadable rows cannot push theirs out. The whole map has a 600-record read budget, spent in object order; when fewer than 51 remain an object reports `"unknown"`. `takeRecords` does not paginate because a Convex function may paginate only once (my first attempt with `pageRecords` failed with that error, found by the tests). `countCapped` is gone.
- Delete in `canDo` (item 5): `canDelete` is true for an object-wide delete grant, or for any single record the agent can read and holds a delete grant on (same scoped-id logic as `fieldWrite`, now shared as `scopedIds`).
- Features list now needs the object to be present in the (readable, non-archived) result; the unused `byKey.has` check is gone.

### Fail before, pass after (`convex/agentMap.test.ts`, 9 tests)
Written first and run against the merged code with the old 1001-row count (5 failed, 4 passed; the archived test passed straight after the merge because integ's filter does it):
- "reports coarse counts: 0, 1-50 or 50+": failed (numbers, not ranges). Pass after.
- "counts a record-scoped agent's own records, however many it cannot read" (1001 unreadable rows first, then 1 readable): failed on the old code with a count driven by unreadable rows; passes after with "1-50".
- "stays within a fixed read budget across many large objects, and says unknown past it" (15 objects x 2000 rows): failed (count 1000 each); passes after: 11 x "50+", then 4 x "unknown".
- "says it can delete only where a delete grant covers it, including grants on single records": failed (record-scoped delete missing); passes after.
- "leaves archived objects out, with their counts" and "lists a feature only when its object is readable": guard tests, green; see mutants.
Read counts are not observable under convex-test; the budget test proves the 600-row rule through its output (11 answered then unknown), and the per-object bound by the probe size.

### The four surviving mutants, now killed (each applied alone, test file run, reverted)
- Count read filter (replace `takeRecords` with a raw index take): 1 test fails.
- Features readability (check object existence instead of readability): 1 fails.
- Codex `REMOLD_KEY` renamed `REMOLD_API_KEY`: `agentSetup.test.ts` fails (new test compares env names in Codex, generic and Claude snippets with the README and `mcp/src/index.ts`).
- `canDo` delete line removed: 1 fails; also a variant that ignores record-scoped delete grants: 1 fails.

### Suites
- `pnpm typecheck`: clean. `pnpm test:authority`: 101/101. `pnpm verify:release`: pass 37, fail 0. `pnpm build`: built.
- `pnpm test`: 571 passed, 9 failed of 580 in the full parallel run; every failure is a 5s/15s timeout under load (automations, gmailSync, posts, rateLimit, Calendar.drag). Re-run in groups: posts, rateLimit pass; automations has one timeout (the daily cap test, not touched by this job); gmailSync and Calendar.drag time out (gmailSync fails the same way on the untouched base, as found in round 1). Not a clean green on this machine; the verifier saw 477/477 clean last round on a quieter machine.
- No schema change; the rollback statement from round 1 still holds.

### Hosted MCP caveat
A separate job is adding a hosted `/mcp` endpoint. When it lands, the Settings panel should also offer a hosted form (URL plus key, no local build). `agentSetup(url, key)` returns one string per client, so a hosted form is one more member of that object plus one more CopyBlock; the test already compares the env names with the server and README, so a hosted form can be added beside it. The panel's current "build the connector" step applies only to the local form.
Not done: still no screenshot of the panel (no signed-in local backend).
