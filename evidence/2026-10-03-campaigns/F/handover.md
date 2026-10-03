# Job F handover: saved views that people and agents can define

- Branch: `remold/views`, based on origin/integ/campaigns `aa68030`.
- Work commit: `debfc48` (code, tests and evidence). This handover is committed on top of it.
- Evidence level: builder-run SIM (vitest + convex-test) and SERVICE (isolated local Convex backend, synthetic data). **Not independently verified.** Nothing was deployed or pushed.

## What changed

Backend
- `convex/schema.ts`: new `views` table; optional `viewId` on `shapeSuggestions.result`.
- `convex/lib/views.ts`: view validators, `checkView` (the rules for saving one, shared by people and agent proposals), `effective` (drops retired fields and lists them), `forReader` (what a reader may see of a view), `runView` (one page with the reader's own access), `viewDetails` (plain words for Suggestions).
- `convex/lib/days.ts`: pure day math shared by app and server: relative ranges (`today`, `next7`, `thisMonth`, `overdue`) to calendar days in a time zone, and days to list bounds.
- `convex/views.ts`: `list`, `create`, `update`, `reorder`, `remove` for people.
- `convex/lib/metadata.ts`: `addView` added to the `shapeChange` union.
- `convex/shapeSuggestions.ts`: `addView` proposal (keys resolved, filter values coerced like agent input, then `checkView`), describe, authorize, apply (creates the shared view as the agent's).
- `convex/agentApi.ts`, `convex/http.ts`: `GET /api/v1/views?object=` and `GET /api/v1/views/<id>/records?cursor&limit&tz`; `addView` fields accepted on `POST /api/v1/shape/proposals`.
- `convex/_generated/api.d.ts`: the three new modules registered (hand-edited to match codegen, which needs a deployment; the local backend run regenerates it and pushed fine).

App
- `src/components/ViewsBar.tsx`: tabs ("All" plus views), Save view dialog (personal by default; admins can share and pin), Save changes, and a menu to rename, move left/right, pin/unpin, delete. Shows which retired fields a view lost.
- `src/routes/ObjectList.tsx`: list state loads from and saves to a view; a Columns picker; relative date presets in the date range control; a blocked view shows a plain message instead of rows.
- `src/components/AppShell.tsx`: pinned shared views listed under their object in the menu.
- `src/lib/views.ts`: a view's list URL.

Agents
- `packages/mcp/src/client.ts`, `index.ts`: tools `remold_views`, `remold_view_records`; `remold_propose_shape` documents and accepts `addView`; server instructions mention views.

Authority bookkeeping
- `ops/authority/inventory.json`: 9 rows (5 public functions, 2 internal agent queries, 2 routes).
- `ops/authority/service-sweeps.mjs`: read-only sweep calls for the 4 new public writes. I did not run `proof:authority` (the service sweep); the vitest inventory check passes.

Tests: `convex/views.test.ts` (9), `convex/lib/days.test.ts` (10), one in `packages/mcp/src/client.test.ts`.

## Decisions and why

1. **A `views` table, as the brief says,** not records/fields metadata. A view is per user or per workspace configuration, not CRM data.
2. **Personal unless shared; no owner means shared.** Only admins and owners share. Only shared views can be pinned.
3. **A view only narrows.** The app runs a view through the existing `records.list` (and Board/Calendar) with the person's own access. Agents run it through `pageRecords` with theirs. No new read path.
4. **Hidden fields.** Columns a reader can't read are dropped silently. Filter, range or sort parts on fields they can't read are left out of what they're shown, values included. A view that chooses, orders or lays out rows by a field the reader can't query is **blocked** for them: the app shows a message, the agent list marks it `usable: false`, and running it returns 403 `FORBIDDEN`. Running it without that part would widen it.
5. **Retired fields.** These are dropped when the view is read, and listed as `dropped` (field label and part). A board or calendar that lost its field shows as a table. Saving the view stores the cleaned version. I treated "deleting a field" as retiring, because retiring is the only removal fields have.
6. **Relative ranges resolve when read, in the reader's time zone.** The app uses the browser's zone. Agents pass `tz` (an IANA name, default UTC); an unknown zone is 400. Fixed range dates are stored as calendar days (`YYYY-MM-DD`) for the same reason. Definitions: today; next 7 days is today plus the six after it; this month is its first through last day; overdue is every day before today. Overdue is by day, not by the current minute, so something due later today is not overdue.
7. **Day starts across DST.** The server takes the zone's offset from 14 hours before UTC midnight. That gives local midnight, or the moment clocks jump where midnight is skipped (Santiago, Beirut). Tested in New York (23 and 25 hour days), Santiago and Beirut. My first version (an iterated offset) got Beirut wrong. The test caught it and I replaced it (fail-before in `fail-before-skipped-midnight.txt`).
8. **No human "run view" query.** People get a view's rows through `records.list`. A second human read path would only duplicate it. The agent run is the one server-side runner.
9. **`addView` goes through the shape-proposal path unchanged, so it is admin-agent only**, like every other shape proposal. Applying needs an admin person who can read every field the view names. A person who can't sees nothing of the proposal (same as other proposals about unreadable things).
10. **Validation parity.** Agent input names fields by key; keys are resolved, filter values are coerced (e.g. option label "Proposal" becomes `proposal`), then the same `checkView` runs. The test checks identical messages for 8 refusals.
11. **Limits.** 3 filters (the brief's number; the list API allows 5), 20 columns, 60-character names. Empty `columns` means automatic columns, the existing behaviour.
12. **Reorder is per group:** shared views (admins) or one person's own, one object at a time. Shared tabs come first, then personal ones (marked with a person icon).
13. **Read-only workspaces** refuse create, update and reorder; delete stays available as a reduction, like dismissing a suggestion.
14. **Board group field in the app** comes from the view, else the first select field, as before. I did not add a group-by picker. Agents can set any select field.

## New env vars

None.

## Fail before, pass after

All new tests were written first and failed on the base code (`fail-before.txt`): the 8 view tests failed (module `views` missing, or proposal refused), `days.test.ts` failed to load, and the MCP test failed with `client.views is not a function`. Pass after: `pass-after.txt` (19/19 + MCP 7/7).

| Behaviour | Test | Before | After |
|---|---|---|---|
| Saved view = same ad-hoc filters/range/sort, all pages | views › returns exactly what the same ad-hoc filters, range and sort return | × | ✓ |
| Relative range across DST and UTC midnight, per tz | views › resolves a relative range when it is read…; days › today is the local date…; 23/25-hour days; skipped midnight | × (skipped midnight: × on my first fix too) | ✓ |
| Restricted agent and member: rows and fields hidden, hidden filter refused | views › run by a restricted agent, hides unreadable rows and fields and refuses filters on hidden fields | × | ✓ |
| Personal views invisible to others; only admins share | views › keeps personal views to their owner; only admins share | × | ✓ |
| Rename, reorder, pin, delete | views › can be renamed, reordered, pinned and deleted | × | ✓ |
| Read-only workspace | views › cannot be saved or changed while the workspace is read only, but can be deleted | written after the code; fails on a mutant without the read-only gate (`× … Tests 1 failed`) | ✓ |
| Retired field: view works, part dropped and flagged | views › keeps working when a field it uses is retired… | × | ✓ |
| addView validation mirrors the human path | views › are refused by the same rules as a person saving the view | × | ✓ |
| addView applied creates the shared view | views › is applied by an admin from Suggestions and creates the shared view | × | ✓ |
| MCP client routes | client › lists saved views and runs one, passing the time zone | × | ✓ |

Mutants (`mutants.txt`): 9 of 9 caught. They cover: the hidden-field check skipped, retired fields kept, others' personal views listed, hidden columns shown, hidden filter values shown, today taken in UTC, the offset read after a clock change, every day 24 hours, and proposals skipping validation.

## Full suites (`suites.txt`)

- `pnpm typecheck`: clean.
- `pnpm verify:release`: tests 37, pass 37, fail 0.
- `pnpm build`: built.
- `pnpm test:authority`: **101/101** on rerun. The first run had 1 failure: the inventory test hit its 5 s timeout (5055 ms) while other job worktrees compiled on this machine.
- `pnpm test`: **not clean under this machine's load.** Best full run: `Tests 3 failed | 414 passed (417)`. With `--testTimeout=60000`: `2 failed | 415 passed`. Every failure is a timeout, in `gmailSync.test.ts` (last contact), `Calendar.drag.test.tsx` (two tests with their own 15 s limit) and once `posts.test.ts` (read budget). This branch touches none of those files or what they render. The same gmailSync and Calendar.drag tests timed out on the untouched base (`aa68030`) before I changed anything: `Tests 1 failed | 397 passed (398)`, then `2 failed`. Run alone, Calendar.drag passes 4/4. gmailSync's last-contact test takes about 5.4 s against its 5 s limit, and passes with a longer timeout. Load average was 9 to 16 from the J-import and B-booking jobs. A quiet machine should be used to confirm the full suite.
- MCP package: 7/7.

## Running for real (SERVICE, local backend, synthetic data)

`screenshot.mjs` (log in `screenshot-run.log`) used an isolated local Convex backend through `ops/authority/local.mjs`, Vite and headless Chromium. Every non-localhost request was blocked; none were attempted.
- REST in the real Convex runtime: `GET /api/v1/views` 200. Runs of the Overdue view with `tz=America/New_York` and `tz=Asia/Tokyo` returned 200 (so `Intl` time zones work in the Convex runtime). Bad tz gave 400. The `addView` proposal gave 201.
- The app: opened a view from its pinned menu link, then a saved board view. Built a filter and saved it as a shared pinned view through the dialog; it was confirmed in the database (`shared: true, pinned: true, filters: ["qualified"]`). Opened a relative-range view (Overdue). Applied the agent's proposal from Suggestions, and it appeared in the menu. Retired a field and saw the note.
- Screenshots: `views-bar.png`, `saved-board-view.png`, `save-view-dialog.png`, `relative-range-view.png`, `suggestions-add-view.png`, `retired-field-note.png`.

Rerun: `PLAYWRIGHT_CORE=<path>/node_modules/playwright-core CHROMIUM=~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome node evidence/2026-10-03-campaigns/F/screenshot.mjs`.

## Rollback compatibility (measured, `rollback.mjs`, logs `rollback-*.log`)

- **Views only** (no `addView` proposals): the previous release (`aa68030`) pushes and runs over the data. It ignores the `views` table. `rollback-views-only.log`: functions ready, objects, records and Suggestions served.
- **With any `addView` proposal row**: the previous release's own schema push is **refused** (`Document … in table "shapeSuggestions" does not match the schema … kind: "addView"`). The lines after the refusal in `rollback-default.log` come from the still-running new code, not the old one.
- **Old functions with this release's additive schema** (`schema.ts`, `lib/metadata.ts`, `lib/views.ts`, `lib/days.ts` kept): pushes and runs. But the old `shapeSuggestions.list` returns `addView` rows without `summary` and `details` (`rollback-keep-schema.log`). The old Suggestions page reads `row.details.length`, so it would break while a pending or failed `addView` row exists. I did not screenshot that; it is from reading the old code.
- **So the compatible rollback target is the previous functions plus these four schema files.** Dismiss pending `addView` proposals before rolling back. If a failed `addView` row exists, the old Suggestions page will break until that row is removed (an operator data edit; not done here).

## Owner setup to go live

None beyond the normal deploy (`pnpm deploy:prod`, by the owner). No env vars, no seeding, no new standard objects or fields.

## Left undone or uncertain

- Not independently verified. Full `pnpm test` was not seen clean on this loaded machine (see above).
- `proof:authority` (the service sweep including the new read-only entries) was not run.
- No group-by picker on the board in the app; a view's group field comes from the view or the first select field.
- `Date.now()` in the agent run: Convex may serve a cached result for an identical request until data changes, so a relative range read just after midnight could briefly reflect the previous day for an identical repeated request. Not observed; not tested.
- The app's per-day bounds for fixed dates use the browser zone (the existing `dayRange`). The agent's use `tz`. The same view can therefore show different instants to people in different zones, by design.

## Round 2 (verifier REVISE, iv-F-verdict.md)

Commits: merge of `origin/integ/campaigns` 4bce955 as `72e88c5`, then the round-2 work and this section on top (hash in the commit log). Builder-run SIM; not re-verified.

### 1. Verifier mutants: 12/12 killed

The verifier's script was gone, so I rebuilt its 12 mutants from the verdict's table in `r2-mutants.py`. Result: `r2-mutants.txt`, **12/12 killed**. New tests (these pin behaviour that was already right, so they pass on the old code and fail on the mutants):
- *is blocked, not widened, for a reader who cannot see its sort, range, board or calendar field*. Covers an agent limited to `name` and a member with amount/stage/closeDate hidden. Views sorted, ranged, board and calendar are `usable: false` or `blocked`, with no field keys or dates in the listing, and a run returns 403. A table view with an unused group field stays usable. Kills M2, M4, M5, M6.
- *are not listed or run on an object the reader cannot read*: a member with company-only scope and an agent granted only company. Covers `views.list`, update, `/views`, `?object=` (404) and running a view (404). Kills M3.
- *keeps personal views to their owner…*: now also checks that a member's update and reorder of a shared view are refused. Kills M8.
- *stays hidden from an admin who cannot read a field it names, and cannot be applied by them*. Kills M9.
- *refuses columns the saver cannot read, and pins only shared views*, on create and on update. Kills M10 and M11.
- Two new parity pairs: `2026-02-30` and `March 1` refused with the same message on both paths. Kills M12.

### 2. People's filter values are checked like an agent's

`checkView` now runs each filter value through `resolveValues`, the agent's coercion, and returns the coerced view. `views.create`, `views.update` and the `addView` proposal all store what it returns. The proposal no longer coerces separately, so there is one rule. People now get the same `VALIDATION` messages as agents. The test *checks filter values like the agent path does* covers a bad option, an object value, text in a number field, and an unknown company. An option label is stored as its id and "900" as 900. It failed before the fix (`r2-fail-before.txt`: `expected null to be truthy`).

### 3. Unknown tz refused on every run

`runView` checks the zone first (`knownZone` in `lib/days.ts`), before any day math. The test *refuses an unknown time zone on every run, with or without dates* covers a view with no range and one with a fixed plain-date range: 400 "Unknown time zone" for both, and 200 with `Asia/Tokyo`. It failed before (`[200, undefined]`).

### 4. Merge and archived objects

- Merged 4bce955. There were conflicts in `convex/agentApi.ts`, `ops/authority/inventory.json` and three `packages/mcp/src` files.
  - `agentApi.ts`: took their `proposeShape` (idempotency replay) and added `...viewInput` to `shapeArgs`.
  - Inventory: rebuilt as their full list plus my 9 rows. I checked that no base row is missing.
  - MCP: kept their `idempotencyKey` and `recordEvents` changes and re-applied my tools, schema fields and instructions on top.
  - After the merge, typecheck was clean and views + shape + authority + MCP tests passed (50, 101 and 9).
- `remold/shape-lifecycle` was not merged. **The archived check is written defensively and is live.** `archived(object)` in `lib/views.ts` reads `(object as { archived?: boolean }).archived`, so it compiles without the field. `views.list`, `GET /api/v1/views` (and `?object=`) and every run skip or 404 views on an archived object. The pinned menu uses `views.list`, so it follows.
- The test *leaves views of an archived object out of lists and runs* is `skipIf` the schema has no `objects.archived`, so it starts running by itself after lifecycle merges. I checked it now by temporarily adding `archived` to the schema: it passes, and fails when the `views.list` guard is removed. Then I reverted the schema.

### 5. Schema lines for the release's expand commit

I moved the view validators into **`convex/lib/viewSpec.ts`**, a new 14-line file that depends only on `convex/values`. The expand commit needs that file plus:
- `convex/schema.ts`:
  - `import { viewSpec } from "./lib/viewSpec";`
  - the `views: defineTable({ orgId, objectId, ...viewSpec, ownerId?, pinned?, order, createdBy: { kind: user|agent, id }, updatedAt }).index("by_org", ["orgId"]).index("by_object", ["orgId", "objectId"])` line
  - `viewId: v.optional(v.id("views"))` inside `shapeSuggestions.result`
- `convex/lib/metadata.ts`:
  - `import { viewSpec } from "./viewSpec";`
  - the `addView` member of `shapeChange`: `v.object({ kind: v.literal("addView"), objectId: v.id("objects"), view: v.object(viewSpec), pinned: v.optional(v.boolean()) })`

With those in the release's schema, the previous functions can run on data this branch writes. The one remaining caveat from round 1 still applies: the old Suggestions page cannot render `addView` rows, so dismiss pending ones before rolling back functions.

### Suites (`r2-suites.txt`; load average 9 to 13 throughout, from other job worktrees)

- `pnpm typecheck`: clean. `pnpm test:authority`: 101/101. `pnpm verify:release`: 37/37. `pnpm build`: built. MCP: 9/9.
- `pnpm test` (default): `4 failed | 490 passed | 1 skipped (495)`. The 4 are the same timeout tests as round 1 (gmailSync last contact, posts read budget, two Calendar.drag).
- `pnpm test --testTimeout=60000 --maxWorkers=2`: `2 failed | 492 passed | 1 skipped`. The 2 are both in Calendar.drag, which sets its own 15 s limit per test, so the flag doesn't raise it.
- Calendar.drag alone: 3/4 on the first try (one timeout), **4/4** on the second. The verifier saw 417/417 on a quiet machine at round 1.
- The skipped test is the archived one above.

### Not done

- I didn't put rollback steps in `ops/deploy/README.md`; per the coordinator, the schema-expand commit covers this.
- Verifier notes N1 to N6 are unchanged: an admin with a hidden field can't rename a view that names it; no cap on views; the blocked view still runs its list query; load-in-render; the misleading "Membership required"; `Date.now()` caching. My round-1 `mutants.txt` was not rerun after the refactor (one anchor moved); round 2's 12/12 replaces it as the mutant record.
