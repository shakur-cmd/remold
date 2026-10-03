# Job D handover: admins choose what each agent reads

- Branch: `remold/agent-access`, based on `origin/integ/campaigns` (c5e2e6b).
- Implementation commit: `ddbb990`. This handover and its evidence are committed right after it on the same branch (the tip of the branch). Not pushed.
- Builder: Claude Opus 5.5. Not independently verified yet.

## What changed

| File | Change |
|---|---|
| `convex/schema.ts` | `agents.readAllObjects` (optional boolean); `authorityAudit` index `by_target` (`orgId`, `targetId`). Both additive. |
| `convex/agents.ts` | New public mutation `agents.setReadAccess`; `agents.list` now also returns `fixedScope` and `cannotRead` (object keys the agent cannot read). |
| `convex/authority/reads.ts` | New `agentReads()`, used by `scopes()` and `canPropose()`, so `readAllObjects` is honoured exactly where `readObjectIds` was. |
| `convex/authority/inbox.ts` | `sharedInboxReader` treats `readAllObjects` like a non-empty `readObjectIds`. |
| `convex/agentApi.ts` | `GET /api/v1/me` (and MCP `remold_me`) adds `agent.readsAllObjects` and `agent.readableObjects` (object keys). |
| `packages/mcp/src/index.ts` | `remold_me` description; instructions: "remold_me lists the objects you can read. If the work needs an object you cannot see, ask a person in the inbox to give you access (remold_inbox_add)." |
| `src/components/AgentsCard.tsx` | Per agent: what it reads, "Cannot see: …", one "Let it read X" button per hidden object, an "All objects" button, and an "Access" panel with read/create/update/delete per current object plus "All objects, including new ones". Card description updated. |
| `ops/authority/inventory.json` | Row for `agents:setReadAccess` (public, human, readonly `refused`). |
| `ops/authority/service-sweeps.mjs` | Readonly sweep call for `agents:setReadAccess`. |
| `convex/agentAccess.test.ts` | 6 new behaviour tests (below). |
| `evidence/2026-10-03-campaigns/D/*` | Logs, mutants, screenshots, screenshot and rollback scripts. |

## The mutation

`agents.setReadAccess({ orgId, agentId, readAllObjects: boolean, objectIds: Id<"objects">[] })` replaces what the agent reads, like `setGrants` replaces grants.

- Caller: admin, the same as `setGrants`. Widening (any object it did not read before, or turning on `readAllObjects`) also needs a writable workspace and an unrestricted admin (`legacyCeiling`, the same check `setGrants` and `setSharedInbox` use). Narrowing is allowed in a read-only workspace, like the other reductions.
- Refuses: agents in another org (NOT_FOUND), objects from another org (NOT_FOUND), revoked or fired agents (FORBIDDEN), keys with a fixed job (FORBIDDEN), and not-yet-migrated agents (AUTHORITY_MIGRATING).
- Every call bumps `authorityEpoch`, calls `pauseWork`, and writes an `authorityAudit` row `agentReadAccessChanged` with the resulting object ids and the new epoch.

## Decisions and why

1. **Replace semantics, one mutation.** Mirrors `setGrants`. Settings computes the full list for one-click actions. A delta API would only matter for agents, and agents cannot call this (widening access is an owner/admin action, per the brief).
2. **"Fixed job" = `purpose` set, or created scoped.** The brief names intake and Gmail sync. Gmail sync agents have no marker field; they are scoped keys (`createGmailSync` goes through `insertAgent` with `scoped: true`). Rather than match on the name "Gmail sync" or add a field (which would need its own rollback shim), I refuse every agent whose creation audit row is `scopedAgentCreated` (intake, Gmail sync and `createScoped` keys). Scoped keys are the H0 capability-grant model; an owner widens them with `authority/grants:grant`. The lookup uses the new additive `authorityAudit.by_target` index. If you want admins to widen generic `createScoped` keys here too, the check needs a marker for Gmail sync first.
3. **Narrowing drops write grants on objects it no longer reads; hidden fields are kept.** Write grants on unreadable objects were already inert (the write path calls `requireObjectRead`), but keeping them would mean a later "Let it read" quietly restores direct writes. Dropping them keeps "reading never implies write" true over time. `hiddenFieldIds` entries are kept: they hide nothing while the object is unread, and hide the field again once it is read. Dropping them would reveal fields that someone had hidden. Both are tested.
4. **`readAllObjects` also writes every current object into `readObjectIds`.** The flag covers objects added later. The list is there so that a rollback build without the flag still reads what the agent read when the flag was set, and never more. See Rollback below. The flag is removed (not set to false) when turned off, so only agents that read everything carry the field.
5. **Turning "All objects" off sends every current object.** Settings passes all current objects, so turning the flag off narrows nothing that exists now. It only stops covering objects added afterwards.
6. **No automatic widening.** Nothing changes for existing agents until an admin acts. There is no migration and no seed change.
7. **`readAllObjects` applies only to migrated (`authorityVersion: 1`) agents.** Pre-migration agents keep the frozen-cutoff rule. The mutation refuses them with AUTHORITY_MIGRATING rather than migrating them inline.
8. **`/me` `readableObjects` uses `canReadObject`**, so it also includes objects an owner opened with a capability `read` grant. That is what the agent can actually read.
9. **The UI disables write checkboxes for objects the agent cannot read**, because those grants would be dropped or inert. The new-agent form still lists every current object (it already used the live `objects` list), so new objects appear there too.

## Env vars

None.

## Fail before / pass after

Tests in `convex/agentAccess.test.ts`. The final test file was run against base code (c5e2e6b, in a temporary worktree): all 6 fail (`fail-before.log`). With this change, all 6 pass (`pass-after.log`).

| Test | Before (c5e2e6b) | After |
|---|---|---|
| an agent made before an object existed cannot read it, can after Let it read, and loses it, with any in-flight proposal, when removed | × `expected undefined to deeply equal [ 'venue' ]` | ✓ |
| reading all objects covers objects added later, and hidden fields stay hidden | × `no such export setReadAccess` | ✓ |
| reading never implies writing, and removing read drops write grants so reading again does not bring them back | × `no such export setReadAccess` | ✓ |
| only unrestricted admins change access, for live agents with no fixed job, to objects in their own workspace | × `expected Error … to match { data: { code: 'FORBIDDEN' } }` | ✓ |
| an agent learns what it can read from /me | × `expected undefined to be false` | ✓ |
| an agent made before Email existed drafts an email and reads the campaign report once an admin lets it read Email | × `expected undefined to deeply equal [ 'email' ]` | ✓ |

Several of these fail on base mostly because the mutation is missing. To show they test behaviour, `mutants.log` breaks each guard in turn. **9 of 9 mutants are killed:** readAll ignored in reads, write grants kept on narrowing, fixed-scope keys accepted, restricted admin allowed to widen, no epoch bump, other-org objects accepted, revoked agents accepted, member role allowed, `/me` omitting readable objects.

What the tests cover (the brief's Done-when list):
- An agent made before Venue existed gets 404 on it, reads it after "Let it read", proposes on it (201), and gets 404 again after removal. The suggestion it made under the wider access is then refused by `suggestions.apply` (FORBIDDEN, epoch changed). Audit rows and epoch 2 are checked.
- `readAllObjects` covers an object created afterwards. A hidden field stays out of `/records`, `/records/:id` and `/objects` under readAll.
- Intake, Gmail sync and scoped keys are refused (and listed with `fixedScope: true`). Other-org objects, cross-org agents and revoked agents are refused. A member-role human is refused. An admin with hidden fields cannot widen but can narrow.
- Reading never implies writing: with readAll, `POST /changes` create and update are 403. After the read is removed and given back, a previous `create` grant does not come back. Hidden field ids persist and still hide.
- Existing-agent campaign flow, end to end: the workspace has no Email object; an agent is made; `seed:ensureStandard` adds Email (the real path for older workspaces). Before access: proposing an email is 404, and the campaign report shows no emails. After "Let it read Email": the agent proposes a draft (201), a direct create is still 403 (no write grant), a person applies the draft, and the report lists it as a draft with "Not approved yet". The email preview returns 200.
- Inventory: with the row removed, `ops/authority/inventory.test.ts` fails on `agents:setReadAccess` (`inventory-fail-before.log`); with it, the test passes.

Not covered by a test: the `sharedInboxReader` change. It only differs from before when an agent has `readAllObjects` and an empty `readObjectIds`, which this code never writes (with zero objects in the workspace, both are empty).

## Full suites

| Command | Baseline (c5e2e6b) | This branch |
|---|---|---|
| `pnpm test` | timeout failure under load (see note) | `Tests 393 passed (393)` with `--testTimeout=60000` (`suite-longtimeout.log`); default timeout: `4 failed \| 389 passed`, all 4 load timeouts |
| `pnpm typecheck` | clean | clean |
| `pnpm test:authority` | 101/101 | `Tests 101 passed (101)` |
| `pnpm verify:release` | 37/37 | `tests 37, pass 37, fail 0` |
| `pnpm build` | ok | `✓ built` (usual chunk-size warning) |
| `pnpm --dir packages/mcp test` | n/a | `Tests 5 passed (5)` |

Note on `pnpm test`: other builder jobs were running on this machine (load average 6 to 7 on 8 cores). With the default timeouts, slow tests time out: `gmailSync.test.ts` "last contact" (5 s limit), two `Calendar.drag.test.tsx` paging tests (15 s), and `rateLimit` once. I ran the base commit c5e2e6b under the same load and the same `gmailSync` "last contact" test timed out there too (`1 failed | 386 passed`). Each of these passes alone. None of them touches agent access. With a longer timeout the whole suite passes: 393 = 387 at base + 6 new.

## SERVICE (local backend, synthetic)

- `I1_SUITES=sweeps node ops/authority/service.mjs` (`service-sweeps.log`): **PASS** "Readonly workspace refuses every public human write and every agent REST write", including `"agents:setReadAccess":"refused: Workspace is read only"` with every org table unchanged. The run then stops at the mask sweep with `No mask sweep call for events:timeline`. That gap was already there: `events:timeline` is in the inventory, has no mask-sweep call at base, and I did not touch it.
- Screenshots (`screenshot.mjs`, `screenshot.log`) use `ops/authority/local.mjs` and the real app in Vite. Only `src/lib/identity` is swapped for a locally signed JWT, as in Job C. Non-local requests blocked: none.
  - `agents-card.png`: "Research agent" (made before Venues and Booking pages) shows "Cannot see: Venues, Booking pages", one "Let it read" button for each, and "All objects". "Ops agent" shows "Reads all objects, including new ones."
  - `agents-card-access.png`: after clicking "Let it read Venues" (toast "It can read Venues"; the backend then lists `venue` in the agent's `/objects`), with the Access panel open (read/create/update/delete per object). Write boxes for Booking pages are disabled because it cannot read them.

## Rollback compatibility

Schema changes are additive: an optional `agents.readAllObjects` and a new `authorityAudit.by_target` index. No standard objects or fields change, so `seed:ensureStandard` is untouched. The campaign end-to-end test still runs it and it adds Email as before. This release runs on data written by the previous one: nothing is backfilled.

Going back to the previous release was exercised, not just reasoned about (`rollback.mjs`, `rollback.log`, local backend):

1. This build set `readAllObjects` on one agent, narrowed another (dropping its `create company` grant), and then created Venue.
2. **Plain c5e2e6b refuses to deploy** once any agent has the flag: `Schema validation failed … Object contains extra field readAllObjects`. Before anyone turns on "All objects", a plain rollback is fine. The index and `setReadAccess` narrowing write nothing the old schema rejects.
3. **c5e2e6b plus only the `readAllObjects` schema line** gives `functions ready`. The old code reads the 11 objects listed when the flag was set, not Venue (created later). So it reads less, never more. The narrowed agent still cannot see Company.
4. Forward again: the flag, Venue access and the narrowed grants are all intact.

So a rollback after "All objects" has been used needs that one-line schema shim, or clearing `readAllObjects` on agents first (which also narrows them to their listed objects).

## Owner setup to go live

None required. After deploy (by the owner, `pnpm deploy:prod` only), existing agents read exactly what they read before. To let an older agent work with Email or any newer object: Settings, Agents, then "Let it read Emails" (or "All objects"). Direct writes still need the per-object create/update/delete boxes under Access.

## Left undone or uncertain

- Generic `createScoped` keys cannot be widened here (decision 2). Owners use capability grants for them.
- The shape-proposal apply path (`shapeSuggestions.apply`) still adds the new object to the proposer's `readObjectIds` without an epoch bump or `pauseWork`. That is existing behaviour and only widens, so I left it alone.
- The MCP instruction text has no automated test. It is a string in `packages/mcp/src/index.ts`.
- One-click buttons send a full list computed from the page. Two admins clicking at the same moment could overwrite each other. The last write wins, and each write is audited and bumps the epoch.
- The full SERVICE replay (`pnpm proof:authority`) was not run end to end. It stops on the pre-existing `events:timeline` mask-sweep gap.
- Screenshots use the local identity stub, not WorkOS sign-in.
