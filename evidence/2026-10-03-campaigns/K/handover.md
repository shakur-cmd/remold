# Job K handover: business blueprints, applied as one reviewable proposal

- Branch: `remold/blueprints` (based on `origin/remold/shape-lifecycle`, 050abad). Not pushed.
- Code commit: `36827ee`. This handover is committed on top of it.
- Evidence level: unit and integration tests are **convex-test (SIM)**. Screenshots, the rollback check and the agent REST calls in `screenshot.log` ran on an **isolated local Convex backend (SERVICE, synthetic data)**. Nothing touched production or any hosted service; the browser refused every non-localhost request ("non-local requests blocked: none").

## What it does

An agent (or a person picking a starter) proposes a whole reshaping as one blueprint: `{ version: 1, name, description, changes: [...], records?: [...] }`. Each change is one of the existing agent proposal bodies (named by key, no `reason`): addObject, addField, addOptions, relabel, reorderFields, reorderObjects, reorderOptions, archiveObject, setTitleField, retireField. A field may target an object that the same blueprint adds, in any order (cycles too). `records` are up to 50 starter records by field key; lookups name a record by title, including another starter record.

- Agents: `POST /api/v1/shape/proposals` with `{ kind: "blueprint", reason, blueprint }`, MCP `remold_propose_blueprint`. List built-ins: `GET /api/v1/blueprints`, MCP `remold_blueprints`. Export: `GET /api/v1/blueprints/current`, MCP `remold_export_blueprint`.
- People: Suggestions shows one card per blueprint (grouped diff, retire/archive impact, slots after applying, starter-record checkbox, Apply all). Settings has "Start from a template" (4 built-ins), "Paste a blueprint" and "Export this workspace's shape" (downloads JSON).

## What changed

Backend
- `convex/lib/blueprint.ts` (new): `parseBlueprint` (format and size limits), `requireWholeWorkspace`, `runBlueprint` (objects first, then every step through the shared helpers, then the whole-blueprint slot check, then optional starter records), `trialOf`/`rollBack` (the rolled-back trial), `refusal`, `diffOf` (the grouped card), `summaryOf`, `exportBlueprint`.
- `convex/lib/proposals.ts` (new, moved from `shapeSuggestions.ts` without behaviour change): key-to-id resolution `changeFor` (was the body of `proposalFor`) and `perform`, so blueprints and single proposals share one path. Both now take any `Principal`.
- `convex/blueprints.ts` (new): `templates`, `preview`, `apply`, `current` (people), `trial` (internal), `check` (action).
- `convex/lib/templates.ts` + `convex/lib/blueprints/{service,agency,creator,retail}.json` (new): the 4 built-in blueprints.
- `convex/shapeSuggestions.ts`: `proposalFor` accepts kind `blueprint`; `authorize` needs unrestricted access for blueprints; `describe` and the person row carry the blueprint diff; `apply` runs a blueprint all-or-nothing (and extends the proposing agent's reads by every new object); new `applyBlueprint` action and internal `markFailed`.
- `convex/agentApi.ts`: shape args come from `lib/metadata.ts`; new `blueprints`, `currentBlueprint`, `trialBlueprint`.
- `convex/http.ts`: blueprint proposals go through the trial first; `GET /blueprints`, `GET /blueprints/current`.
- `convex/lib/metadata.ts`: `fieldInput`, `changeInput` and `blueprint` validators; new `shapeChange` variant `{ kind: "blueprint", blueprint }`; `validKey` exported.
- `convex/lib/lifecycle.ts`: `applyLifecycle` takes any `Principal`; the first retitle page inside a title change uses `take` instead of `paginate` (Convex allows one paginate per function; a blueprint can retitle several objects). Later pages still page in their own transactions.
- `convex/_generated/api.d.ts`: registers the 4 new modules (hand edit in codegen's form; `convex codegen` needs a deployment here).
- `convex/tsconfig.json`, `tsconfig.app.json`: `resolveJsonModule` for the template JSON files.

Frontend
- `src/components/BlueprintReview.tsx` (new): the shared review (diff groups, impacts via `objects.impact`, slot use, records checkbox) and `useBlueprintCheck`.
- `src/routes/Suggestions.tsx`: `BlueprintCard` for blueprint proposals.
- `src/routes/Settings.tsx`: `BlueprintsCard` (template picker, paste, export) and `BlueprintDialog`.

Agents and ops
- `packages/mcp/src/client.ts`, `packages/mcp/src/index.ts`: `blueprints`, `currentBlueprint`, `proposeBlueprint`; tools `remold_blueprints`, `remold_export_blueprint`, `remold_propose_blueprint`.
- `ops/authority/inventory.json`: rows for the 11 new functions and 2 routes. `ops/authority/service-sweeps.mjs`: read-only sweep calls for the 3 new public writes.

Tests and evidence
- `convex/blueprints.test.ts` (new, 18 tests). `evidence/2026-10-03-campaigns/K/`: this file, fail-before/pass-after, mutants, suites, screenshots and their script and log, rollback script and log, Astra's review.

## Decisions

1. **Apply is atomic, never chunked.** A blueprint applies in one Convex mutation; any refusal throws and Convex discards every earlier step. No partial state can exist, so no "partially applied" status or resume action is needed. This is safe because of hard size limits (100 changes, 20 new objects, 12 fields per addObject, 50 starter records): a person's apply then stays far inside Convex's per-transaction read and write limits (rough worst case: a few thousand document reads, well under 1,000 writes). I judged a resumable chunked plan to be more machinery and more failure states for no gain at these sizes.
2. **Validation is a trial run of the real apply.** To check a blueprint "against the current shape using the shared helpers", the proposal path (and the person's check) applies it for real in a mutation that always throws a `BLUEPRINT_TRIAL` ConvexError; the caller (http action or `blueprints.check` action) reads the result from the error. Every rule (key collisions, references, options, lifecycle rules, slots, starter-record values) is therefore exactly the apply code, with no second simulator to drift. Confirmed on the real local backend, not only convex-test (`screenshot.log`: a dangling reference refused with 404, nothing stored).
3. **Failure recording.** Because a failed apply rolls back, `shapeSuggestions.applyBlueprint` (an action) calls `apply`, and on a refusal it records `failed` with the message in a second transaction. Suggestions uses the action. Calling the `apply` mutation directly on a blueprint row still refuses atomically; it just leaves the row pending.
4. **Objects first.** All new objects are created (with their Name field) before any other step, so any step can point a relation at any new object, in either direction.
5. **Slot exhaustion is a blueprint error.** A single new text, number, date or yes/no field without a free index slot is quietly kept unindexed today; a blueprint refuses instead, naming the object and counts ("Not enough index slots on Wide: it needs 10 text slots and has 8. Set indexed: false on ..."), because a template that silently produces unsortable fields is worse. `indexed: false` remains the explicit opt-out. Lookups were already refused per field.
6. **addOptions in a blueprint lists only the options to add** (an agent's single addOptions proposal lists them all). Templates must apply to workspaces that already customised a select. Changing an existing option is still refused.
7. **Who may propose, review and apply.** Admin role only (member-role agents and people refused), and only principals that see every object, field and record (`requireWholeWorkspace`). A blueprint can touch anything and resolves links by title, so a restricted principal could learn about hidden things through its check results.
8. **Agent trials and starter records.** Agents need record grants to create records, but the real write is the person's. In the agent's trial the starter records are written as the workspace owner (`ownerOf`, the existing operator stand-in), inside the transaction that is rolled back. Because of decision 7, the agent can already read every record, so this reveals nothing it could not read. The trial also adds each new object to the agent's read list (rolled back too), as `apply` will.
9. **Person path.** A person picking a template (or pasting a blueprint) reviews it in a dialog and applies it directly (`blueprints.apply`, audited as `blueprintApplied`). There is no proposal row, because `shapeSuggestions.agentId` is required and changing that would make rollback harder.
10. **Records are opt-in at apply time.** The checkbox is off by default; without it `runBlueprint` gets no writer and creates none. Records are created through `applyChange` with the reason "Starter record from blueprint ..." and attributed to the person.
11. **Export** emits what differs from a new workspace: every custom object (fields, options, retired fields as add-then-retire, title, name relabel, archive) and, for standard objects, relabels, added fields and options, retired fields, title, and field, option and object order where they differ. Anything the caller cannot read is left out, as are relations to it; orders are left out when part of the list is hidden, since an order must name every item. No records, ids or settings. `version`, `name` ("<workspace> shape") and a description are set.
12. **Templates are JSON** under `convex/lib/blueprints/` and listed by `blueprints.templates`, so the app and agents read one source. The Agency template relabels Company to Client and extends the standard Project instead of adding a second one.

## Env vars

None.

## Fail before, pass after

All in `convex/blueprints.test.ts`. Before the implementation the 16 original tests all failed (`fail-before.txt`, e.g. `expected 400 to be 201`, `Could not find module for: "blueprints"`, `client.blueprints is not a function`). After: 18/18 pass (`pass-after.txt`).

| Behaviour | Test | Before | After |
|---|---|---|---|
| Cross-referencing new objects apply correctly; one grouped card | applies a blueprint whose new objects refer to each other, shown as one grouped card | × expected 400 to be 201 | ✓ |
| Starter records only with the checkbox, linked and attributed | creates starter records only when the person ticks the box ... | × | ✓ |
| Template picked, checked, applied by a person | a person picks a built-in template, checks it and applies it ... | × module not found | ✓ |
| Slot exhaustion across the whole blueprint | slot exhaustion summed across every change in the blueprint | × | ✓ |
| Collisions (workspace and within blueprint) | key collisions, with the workspace and within the blueprint | × | ✓ |
| Dangling references (objects, fields, records) | dangling references, to objects, fields and records | × | ✓ |
| Format and limits | format: version, kinds, size limits | × | ✓ |
| Atomic, failure recorded, no half state | a blueprint made stale before apply fails plainly and leaves nothing half applied | × | ✓ |
| Direct invalid apply changes nothing | a person's direct apply of an invalid blueprint changes nothing | × | ✓ |
| Export re-applied to a new workspace reproduces the shape | exporting a reshaped workspace and applying it to a new one reproduces the shape | × | ✓ |
| Export of an untouched workspace is empty | an untouched workspace exports an empty blueprint | × | ✓ |
| Export hides unreadable objects and fields (agent and person) | export leaves out objects and fields the caller cannot read | × | ✓ |
| Each built-in validates and applies to a fresh workspace | each validates and applies, with its starter records, to a fresh workspace, and agents can list them | × | ✓ |
| Member-role agents and people refused | member-role agents and people are refused | × expected 400 to be 403 | ✓ |
| Restricted admin agent refused | an admin agent that cannot read every object cannot propose a blueprint | × | ✓ |
| MCP client routes | lists, exports and proposes blueprints over REST | × | ✓ |
| Review fix: several title changes in one blueprint | a blueprint can change several titles at once, as an export of such a workspace does | × `Only a single paginated query (.paginate()) is allowed per function execution` | ✓ |
| Review fix: record-scoped admin agent cannot probe records through a trial | an admin agent limited to some records of an object cannot propose one ... | × (proposal accepted) | ✓ |
| Review fix: retired custom fields survive export | exporting a reshaped workspace ... (now retires company.legacy and job.address) | × shapes differ | ✓ |

The review-fix "before" lines are in `review-fixes-fail-before.txt`.

**Mutants** (`mutants.txt`): 12 hand mutations of the new code, each killed by the suite: no whole-blueprint slot check, no reference check, starter records without the box, export ignoring object reads, export ignoring field reads, export dropping field order, export dropping option order, no objects-first pass, failure not recorded, blueprint review not limited to unrestricted people, preview open to members, no trial at proposal time.

## Full suites (`suites.txt`)

- `pnpm test`: 443 tests; 440 to 442 pass on this shared, loaded machine. The only failures are timeouts in `gmailSync` "last contact" and two `Calendar.drag` paging tests, which pass when run alone (9/9) and fail the same way on base 050abad run at the same time (423/425). `convex/blueprints.test.ts`: 18/18. Details in `suites.txt`.
- `pnpm typecheck`: clean.
- `pnpm test:authority`: 101/101 passed.
- `pnpm verify:release`: 37/37 passed.
- `pnpm build`: built; MCP package `tsc` build also clean.
- `pnpm proof:authority` (SERVICE, not required): 50 PASS, then the harness stops at `service-secrets.mjs:94` with `spawnSync unzip ENOBUFS` (export bigger than Node's 1 MB buffer). Base 050abad stops at the same place with the same error, so this is pre-existing. The read-only sweep, which now covers the 3 new public writes, comes after that point and did not run on either.

## Screenshots (SERVICE, `screenshot.mjs`, `screenshot.log`)

- `suggestions-blueprint-card.png`: an agent's "Repair shop" blueprint: two new objects referring to each other, Stage gains options, a retire and an archive with their impact, slot use after applying, the starter-record box ticked. Clicking Apply all applied it: objects `repairJob`, `quote` added, Workshop archived, proposal `applied`, starter record "Cracked screen" created.
- `settings-template-picker.png`: Settings, "Start from a template".
- `settings-template-review.png`: the Creator or coach template under review, checked OK, records box off.
- `settings-template-refused.png`: the Service template in the same workspace: "Cannot apply: Step 2, add object quote: Object key already exists", Apply all disabled.

## Rollback compatibility (`rollback.mjs`, `rollback.log`, SERVICE)

- Templates and blueprints applied by a person write only ordinary objects, fields, options, records, events and audit rows. The previous release runs on that data unchanged.
- **A plain rollback to 050abad is refused once a blueprint proposal row exists** (new `shapeSuggestions.change` variant): `Schema validation failed. Document ... in table "shapeSuggestions" does not match the schema`. `pnpm deploy:prod --ref` already refuses a ref whose schema rejects the backup.
- **A schema-only rollback build works**: 050abad's code plus this branch's `convex/schema.ts`, `convex/lib/metadata.ts` and `convex/lib/slots.ts` started (`functions ready`), kept all objects, listed the template's fields, created a record, hid blueprint proposals from the Suggestions list (old code cannot read them), and refused to apply the pending blueprint ("Server Error"), changing nothing. Rolling forward again kept everything, and the pending blueprint then applied.
- No new standard objects or fields, so `seed:ensureStandard` is unchanged.

## Owner setup to go live

None. No env vars, no external services, no schedules. After deploying, Settings shows the template card to admins and the export button to everyone; admin agents can use the new routes at once (MCP clients get the new tools after `pnpm --filter @remold/mcp build`).

## Independent review (Astra, gpt-6-astra via Codex, read-only, `astra-review.txt`)

Six findings; I checked each.
1. Record-scoped admin agent could probe hidden records through the owner-backed trial. **Confirmed by a failing test; fixed** (`requireWholeWorkspace`).
2. No committed compatible rollback target for the new schema variant. **True, not changed**: same situation and same schema-only rollback recipe as Job G (above). Worth a release-process decision by the coordinator.
3. Two `setTitleField` in one blueprint fail (one `paginate` per function). **Confirmed by a failing test; fixed** in `lib/lifecycle.ts`. This also affected exports of workspaces with more than one changed title.
4. Export drops edits to existing standard options (renamed or recoloured stages). **True, documented below**; the blueprint format has no change kind for editing an existing option, by design of the agent proposal rules.
5. Export dropped retired custom fields. **Confirmed; fixed** (added then retired, keeping key and slot).
6. Export can exceed the import limits (over 20 custom objects or 100 changes). **True, documented below.**

## Left undone or uncertain

- Export cannot carry renamed or recoloured options of standard select fields (only added and reordered ones), field `required` changes on standard fields, or `protectedFromAgents`. Applying such an export gives the standard labels.
- A workspace with more than 20 custom objects or more than 100 differences exports a blueprint that the import limits refuse with a clear message; it must be split by hand. The limits are there to keep apply in one transaction.
- When a restricted principal exports, field and object orders that include hidden items are left out, so that export may not reproduce order exactly (by design).
- The diff labels a relation by the target's current label, so in the Agency template a relation to Company reads "lookup to Company" even though the same blueprint renames it Client.
- The read-only service sweep for the new public writes is written but never ran, because the service proof stops earlier on a pre-existing harness buffer limit (see the suites section). The convex-test suite does cover refusal for member-role and restricted principals.
- Transaction headroom for the largest allowed blueprint was reasoned, not measured on a real backend with a maximal blueprint.
- `convex/_generated/api.d.ts` was edited by hand.
