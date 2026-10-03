# Job C handover: agents can remold the workspace

Builder evidence only, not certification. Level: unit (convex-test) plus SERVICE on an isolated local Convex backend with synthetic data. No hosted service, deploy, or real email was touched.

- Branch: `remold/agent-schema`, based on 371a62c (code identical to cc9ed1c).
- Code commit: 2c46108. Final commit (this handover and evidence): see `git log -1 remold/agent-schema`.

## What changed

- `convex/lib/metadata.ts` (new): the one set of shape rules. Validators (`fieldSpec`, `objectSpec`, `shapeChange`), `checkObject`, `checkNewField`, `checkOptions`, `createObject`, `createField`, `fieldFor`, `requireUnrestricted`.
- `convex/objects.ts`, `convex/fields.ts`: `objects.create`, `fields.create`, `fields.update` now call the shared helpers. Same args, same messages.
- `convex/shapeSuggestions.ts` (new): human `list`, `apply`, `dismiss`; agent-side validation `proposalFor`; plain-words `describe`; agent DTO `agentRow`.
- `convex/schema.ts`: new table `shapeSuggestions` (additive).
- `convex/agentApi.ts`: `proposeShape`, `shapeProposals`; `/me` gains `pendingShapeProposals`.
- `convex/http.ts`: `GET` and `POST /api/v1/shape/proposals`.
- `convex/_generated/api.d.ts`: registers the two new modules (codegen needs a deployment; edited by hand to match what codegen writes).
- `packages/mcp/src/client.ts`, `index.ts`: `remold_propose_shape`, `remold_shape_proposals`; `remold_list_records` takes `filters` and `range`; server instructions say Remold is meant to be reshaped.
- `src/routes/Suggestions.tsx`: shape proposal cards in "Waiting for you", a "Could not apply" section, and `useWaiting` (record plus shape count) used by `AppShell.tsx` (nav badge) and `Today.tsx`.
- `ops/authority/inventory.json`, `inventory.test.ts`: 7 new inventory rows; route parser now reads a literal second path segment (`/shape/proposals` instead of `/shape/:id`).
- `ops/authority/service-sweeps.mjs`, `fixture-sweeps.ts`: readonly and mask sweep calls for the new surface; table dump includes `shapeSuggestions`.
- `convex/shape.test.ts` (new, 20 tests), `packages/mcp/src/client.test.ts` (+2 tests).

## How it works, in short

An admin-role agent posts `{ kind, reason, ... }`: `addObject` (key, label, labelPlural, icon, up to 12 fields), `addField` (object plus the field), `addOptions` (object, field, full option list), or `relabel` (object, optional field, label, labelPlural). The server resolves keys to ids, runs the same checks Settings runs, and stores a pending row. An admin who could make the same change in Settings sees it on the Suggestions page ("Add field Budget (number) to Opportunity", the agent's name and reason) and taps Apply or Dismiss. Apply re-runs the shared helper against the current shape; if the world moved on, the row becomes `failed` with the same message a person would get, and nothing is written. The agent reads `GET /api/v1/shape/proposals?status=` to see its own rows, with `result: { object, fields }` as keys once applied.

## Decisions and why

1. **Stored as `change` (a typed union with `kind` inside), not `kind` + `payload`.** One validator per kind, checked by Convex, with ids resolved at proposal time. Result is `{ objectId, fieldIds }`.
2. **Agent role gate: `agent.role === "admin"`, else 403.** As the brief says. This is simpler than the approved H0 amendment A1 design (owner-issued `setup.propose` grant, 10 ops / 3 open per grant, setupEvents). The brief scoped this job; A1 is not built. Shakur may want to reconcile the two.
3. **Proposal-time checks use the agent as principal.** Adding an object needs the agent to read every object and field (the agent version of `unrestrictedHuman`, because a duplicate-key answer would reveal hidden object keys). Field changes need full object scope (`requireObjectAdministration`). Unknown and unreadable objects or targets both answer `Object not found`, so proposals cannot probe.
4. **Who sees and applies.** Admin or owner, plus the same scope Settings demands: unrestricted for a new object, full object scope for field kinds, and read access to any lookup target. Member-role people get 403 on apply and dismiss and an empty list. Restricted admins never see proposals about objects outside their scope.
5. **Stale means failed, not half-applied.** Each helper checks everything before its first write, so `apply` catches VALIDATION, NOT_FOUND or SLOTS_EXHAUSTED from the helper and marks the row failed. Authority errors (FORBIDDEN) are thrown and leave the row pending.
6. **Proposals from an agent whose access changed (revoked, fired, epoch bumped) cannot be applied.** Same rule as record suggestions. The card says so and offers Dismiss.
7. **Audit: `authorityAudit`, action `shapeProposalApplied`, actor = the applying person, targetId = proposal id, objectIds = [object].** The proposal row keeps agentId, reason, resolvedBy, resolvedAt and result ids, so the chain is agent proposed, person applied, these ids created. `events` was not used because it is per record (`recordId` required). The human Settings path still writes no audit row, as before.
8. **Applying a new object gives the proposing agent read access to it** (appends to `readObjectIds`, no epoch bump so its other pending work is not paused) and writes an `agentReadExtended` audit row. Without this, a v1 agent could never use an object created after it, which defeats "propose it, then use it". Write grants are not given; it proposes record changes as usual. Only unrestricted admins can apply new objects, the same people who can already widen agent grants (`agents.setGrants`). **Flag for Shakur:** this is a small authority widening by an admin, not the owner.
9. **addOptions takes the full option list (same shape as `fields.update`)** so removal is refused with the human message `Options cannot be removed`. Agents may not relabel existing options (`Agents can add options but not change existing ones`), as the brief requires. Only the additions are stored; apply appends them to whatever options exist then.
10. **Human-path behaviour changes (two, small):** a lookup is refused when the object has no free text slot left (`No index slot left for another lookup on this object`, code SLOTS_EXHAUSTED), because related records are found through that slot; and an empty label or plural label is refused (`Label is required`). Previously both were accepted. This is the brief's "slot availability" rule and matches A1's approved "only a lookup without a slot is refused". Other types still go unindexed when slots run out, as before.
11. **Dismiss stays available while the workspace is read only** (a reduction, like `suggestions.dismiss`). Apply and propose are refused.
12. **Agent list defaults to all statuses, newest first, 100 rows**, so an agent sees outcomes without asking for each status. `/me` adds a sibling `pendingShapeProposals` (the agent's own pending count); `pendingSuggestions` is unchanged.
13. **Labels in `describe` are read live**, so a renamed object reads with its current name.
14. No per-agent cap on open shape proposals. The REST write rate limit applies, as for record suggestions.

## New env vars

None.

## Fail before, pass after

All new tests were written first and run against the base code.

- `convex/shape.test.ts`, 19 tests, base: `Tests 19 failed (19)` (`fail-before-convex.txt`). After: 19 passed.
  - refuses a member-role agent and stores nothing
  - stores an admin agent's proposal without changing the shape
  - same rules as the person's path, one test each, comparing the person's message to the agent's: bad key (field and object), duplicate key (field and object), select without options, withTime on a non-date, relation to an unreadable object, removing an existing option, lookup with no index slot left (this one also fails on base for the person's path, which accepted it)
  - applies a new field exactly once and attributes it (audit row actor, result ids, agent sees `applied` with keys, second apply is `already`)
  - applies a new object with its fields, and the proposer can then use it (sees it in `/objects`, proposes a record on it)
  - adds options and relabels without touching anything else
  - an agent may not rename an existing option
  - fails a proposal made stale by a later change, with nothing half-applied (fields and objects tables byte-equal before and after)
  - dismisses without changing the shape
  - a member-role person can neither see nor apply
  - a person with restricted reads cannot apply a new object
  - refuses proposals and applies while the workspace is read only
  - lists only the calling agent's proposals and counts them in /me
- `MCP list filters › segment a real REST list: people at one company`: the real `RemoldClient` against the real HTTP router. With the base client: `expected [ 'Ada', 'Ben', 'Cy' ] to deeply equal [ 'Ada', 'Cy' ]` (filters silently dropped; `fail-before-mcp-e2e.txt`). After: passes.
- `packages/mcp/src/client.test.ts`: "passes multi-field filters and a range to REST" (asserts `filter[company]=Atlas`, `filter[city]=Boston`, `range[createdOn]=2026-01-01..2026-01-31`) and "proposes shape changes and lists the agent's own proposals". Base: `2 failed | 2 passed (4)` (`fail-before-mcp.txt`). After: 4 passed.
- Mutants (`mutants.mjs`, output in `mutants.txt`): 13 deliberate breaks (no agent role gate, stale throws, no read extension, restricted person may apply, agent lists all, slot rule off, member may apply, member sees list, no audit, agent may rename options, duplicate key allowed, option removal allowed, dismiss keeps pending). **13/13 caught.** An earlier run had one survivor, a redundant role check inside `authorize`; I deleted that line, since `requireWriter/requireMember(..., "admin")` already gates every entry point.

## Full suites (after, at 2c46108)

| Suite | Baseline 371a62c | After |
|---|---|---|
| `pnpm test` | 49 files, 329/329 | 50 files, **349/349** |
| `pnpm typecheck` | clean | **clean** |
| `pnpm test:authority` | 101/101 | **101/101** (inventory test now covers the 7 new rows) |
| `pnpm verify:release` | 37/37 | **37/37** |
| `pnpm build` | ok | **ok** (`✓ built`; the usual chunk-size warning) |
| `pnpm --dir packages/mcp test` | 2/2 | **4/4** |

## SERVICE (local backend, synthetic)

- `pnpm proof:authority` **fails at base 371a62c too**, before reaching the sweeps: `service-agents.mjs:23` expects `/Agent inactive/`, gets `Stale claim`. With `I1_SUITES=sweeps` it fails at base with `No readonly sweep call for reminders:set`. Both are pre-existing and unrelated to this job (`service-preexisting-failures.txt`). I did not fix them.
- To exercise my sweep rows anyway, I ran a scratch copy narrowed to the shape rows (`service-sweeps-shape-only.log`): `READONLY SWEEP {"shapeSuggestions:apply":"refused: Workspace is read only","HTTP POST /api/v1/shape/proposals":"403 ... Workspace is read only","shapeSuggestions:dismiss":"allowed"}`. Every org table was unchanged after each refusal. The mask sweep passed with `shapeSuggestions:list` and agent `GET shape/proposals` included.

## Screenshots

`screenshot.mjs` boots the isolated local backend (`ops/authority/local.mjs`) and the real app in Vite. Only `src/lib/identity` is swapped for a locally signed JWT, because sign-in normally goes through WorkOS. The browser aborts every non-localhost request (log: `non-local requests blocked: none`).

- `suggestions-shape-proposals.png`: three pending proposals (new option, new object with 3 fields, new field), a "Could not apply" card with `Field key already exists`, nav badge 3.
- `suggestions-after-apply.png`: after clicking Apply on the Budget card. The script then read the opportunity fields from the backend: `name, amount, stage, closeDate, company, person, campaign, budget`.

## Rollback compatibility

Schema change is additive: one new table (`shapeSuggestions`), no changes to existing tables or fields. No new standard objects or fields, so `seed:ensureStandard` is untouched. Exercised, not just inspected (`rollback.mjs`, `rollback.log`, SERVICE local backend):

1. This build wrote 1 applied, 1 failed and 1 pending shape proposal, created object Venue (with a lookup) through a proposal, and extended the agent's read list.
2. The previous release's `convex/` (git 371a62c) was pushed over the same data: `functions ready`. The old code listed Venue, its fields `name,capacity,owner`, and created a Venue record. Agent `/me` worked, the agent still saw Venue through `/objects`, and `/shape/proposals` returned 404 (route absent, expected).
3. Forward again to this build: proposals by status `{"pending":1,"applied":1,"failed":1}`, so nothing was lost.

So yes, the previous release runs against data written by this one. Objects and fields created by proposals are ordinary rows. The `shapeSuggestions` rows simply sit unused under the old release.

## Owner setup to go live

None beyond a normal `pnpm deploy:prod`. To use it, an agent must have role admin (Settings, Agents). Existing member-role agents get 403 on shape proposals.

## Left undone or uncertain

- H0 amendment A1 (grant-based `setup.propose`, op caps, setupEvents, field retire) is not built; this job follows the brief's simpler admin-role gate.
- The human list scans up to 200 newest rows per status and filters by visibility in memory. For a restricted admin, the cost depends slightly on how many proposals they cannot see. That is a timing-only, count-level signal, and shape proposals are low volume. Not an index-per-object design like `visibleSuggestions`.
- `describe` shows the current labels of objects and fields. An agent whose access later narrows could still read the current label of an object it proposed about.
- The person's Settings path for objects and fields still writes no audit row; only applied proposals are audited.
- The pre-existing SERVICE failures above.
- Screenshots use a local identity stub, not WorkOS sign-in.
- Not independently verified.
