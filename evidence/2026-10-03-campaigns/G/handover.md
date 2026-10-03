# Job G handover: shape lifecycle (retire, restore, reorder, archive, retitle)

- Branch: `remold/shape-lifecycle`, based on `origin/integ/campaigns` (aa68030). Not pushed.
- Implementation commit: `1b729e9`. This handover (plus `astra-review.txt`) is in the commit after it.
- Evidence level: unit and integration tests are **convex-test (SIM)**. Screenshots and the rollback check ran on an **isolated local Convex backend (SERVICE, synthetic data)**. Nothing touched production or any hosted service.

## What changed

Backend
- `convex/lib/lifecycle.ts` (new): one `checkLifecycle` used by both paths for the 8 kinds; `applyLifecycle` (check, write, audit); `impactOf` (retire/archive preview); `retitle` (internal, pages stored titles after a title-field change); the table of standard fields features rely on.
- `convex/lib/metadata.ts`: 8 new `shapeChange` variants; `fieldSpec.indexed` (optional, text only); `capacity` now comes from `lib/slots.ts`.
- `convex/lib/slots.ts`: exports `capacity` and `slotsLeft(fields)`.
- `convex/fields.ts`: `retire` now goes through the shared helper; new `restore`, `reorder`, `reorderOptions`.
- `convex/objects.ts`: new `reorder`, `setArchived`, `setTitleField`, and query `impact`.
- `convex/shapeSuggestions.ts`: agents can propose the 8 kinds (names by key, `order` list); validated by `checkLifecycle` at proposal time and again at apply; summaries/details for each kind; person rows carry a `preview` target (each card loads its own impact); `reorderObjects` needs unrestricted access like `addObject`; `result` omitted when there is no single object.
- `convex/agentApi.ts`, `convex/http.ts`: `/api/v1/objects` skips archived objects unless `?include=archived`, and reports `archived`, `retiredFields`, and `slotsLeft {text, number, date, boolean}`. Proposal body accepts `order` and `indexed`.
- `convex/lib/search.ts`: open searches skip archived objects; a search naming an object (a picker for a link to it) still finds its records.
- `convex/authority/reads.ts` (`visibleTitle`): a text title is read from the current title field's value, not the stored copy (see review fix 1).
- `convex/schema.ts`: `objects.archived` (optional boolean) and `authorityAudit.before` (optional string). Additive only.
- `convex/_generated/api.d.ts`: registers `lib/lifecycle` (hand edit matching codegen output).

UI
- `src/routes/Settings.tsx`: Navigation list (move objects up/down, Archive custom objects, Unarchive); fields with up/down, Use as title (text fields), Order options (select fields), Retire with impact in the confirm, a Retired section with Restore; the add-field form gains "Searchable and sortable" for text and a line with slots left per kind.
- `src/components/AppShell.tsx`: archived objects left out of the nav.
- `src/routes/Suggestions.tsx`: retire/archive cards show "What this touches".

Agents and docs
- `packages/mcp/src/client.ts`, `index.ts`: `remold_objects` takes `includeArchived` and documents slots, retired fields and order; `remold_propose_shape` lists the 8 new kinds with their inputs, plus `order` and `indexed`; server instructions mention proposing retire/archive/reorder.

Tests and proof
- `convex/lifecycle.test.ts` (new, 27 tests).
- `convex/posts.test.ts`, `src/components/Calendar.drag.test.tsx`: fixture-only fix (see decision 9). Assertions untouched.
- `ops/authority/inventory.json`: 8 rows (6 public writes, `objects:impact`, `lib/lifecycle:retitle`). `ops/authority/service-sweeps.mjs`: readonly sweep calls for the 6 new public writes.

## Decisions and why

1. **Restore after slot reuse: refuse, do not reallocate.** Retiring keeps the slot (unchanged from before: `allocateSlot` counts retired fields), so in normal use nothing can take it and restore is always safe. Only a migration that frees slots (`releaseSlot`) could hand it on. Then restore refuses with `"<Field> cannot be restored: its index slot is now used by <Other>"` (409 `SLOTS_EXHAUSTED`). Reallocating would need backfilling a projection on every record of the object in one transaction, which is unbounded. A text/select/number/date field whose slot was released (no slot at all) is restored unindexed, values intact; a lookup with no slot is refused, because related-record lookups need the slot.
2. **Retire keeps the slot.** That is what makes restore safe and reversible. The cost is that retiring does not free capacity; the "Searchable and sortable" toggle at creation is the way to save slots, and the form shows slots left per kind (retired fields count, because they keep theirs).
3. **One rule set.** Human mutations build the same `ShapeChange` an agent's proposal stores and call `applyLifecycle`; proposals call `checkLifecycle` at proposal time, then apply runs it again. Messages are therefore identical by construction, and the tests check each pair.
4. **Protected fields** (standard objects only; refused with a plain reason): post status, published link, planned; email subject, body, campaign, follows up, status; person email; campaign people, status; note about; activity about, when, type; task due date, done; invoice amount, due, paid on. I left out fields existing tests show are designed to be retirable (email sendAt, opportunity stage). There are no booking features in this tree, so none are listed.
5. **Archive** is a flag on the object. Hidden from the nav, open search, the agents' object list (REST and MCP) and new link-target pickers. Records, links, record pages and `records?object=` reads still work, so nothing linked breaks. Standard objects cannot be archived. Object reorder lists only objects not archived; archived ones keep their relative place after them.
6. **Reorder takes the whole list** (every live field, every non-archived object, every option), refusing anything else with "List every … once". Partial lists are ambiguous and race badly. Retired fields keep their relative order after the live ones.
7. **Title field: text only.** Changing it rewrites stored record titles (they feed the search index): the first 50 records in the same transaction, the rest in scheduled pages of 50. `lib/lifecycle:retitle` is idempotent and can be re-run by hand with `cursor: null`.
8. **Audit and reversibility.** Every lifecycle change writes `authorityAudit` with `action` = the kind, the target, and `before` (previous order, or previous title field key). Every kind has an inverse (restore/retire, unarchive/archive, reorder back, set title back). Nothing is deleted.
9. **Displayed titles come from the title field's value** (`visibleTitle`). This closes a leak Astra found (below). It equals what `applyChange` stores in every state the app can produce. Two test fixtures inserted records directly with a stored title that differed from their title value (a state no write path produces), so I made them write both; their assertions are unchanged.
10. **Impact previews are their own query** (`objects.impact`), loaded per card, counting at most 500 records ("More than 500 records…" past that), and naming only objects and fields the viewer can read. The Suggestions list stays one bounded read. Agents do not get impact counts (they could count records they cannot read).
11. **`slotsLeft` in REST** is shown only to an agent that can read every field of the object (else `null`), since hidden fields hold slots too.

## Env vars

None.

## Fail before, pass after

All 27 tests in `convex/lifecycle.test.ts` were run against the base (aa68030, in a throwaway worktree): **24 failed (24)** for the original set (`fail-before.txt`, reasons in `fail-before-reasons.txt`: missing functions such as `fields.restore`, unknown kinds and `order` refused with 400, missing `archived`/`slotsLeft`). After: **27 passed (27)** (`pass-after.txt`). The 3 tests added after review were each shown failing with their fix reverted (`review-fixes-fail-before.txt`).

| Behavior | Test | Before | After |
|---|---|---|---|
| Parity, retireField (title, protected email/due date/published link, already retired) | `retireField: title, protected standard fields, already retired` | × | ✓ |
| Parity, restoreField | `restoreField: a field that is not retired` | × | ✓ |
| Parity, reorderFields | `reorderFields: a list that leaves out or repeats a field` | × | ✓ |
| Parity, reorderObjects | `reorderObjects: a list that leaves out an object` | × | ✓ |
| Parity, reorderOptions | `reorderOptions: a missing option, and a field without options` | × | ✓ |
| Parity, archive/unarchive | `archiveObject and unarchiveObject: standard objects, and an object not archived` | × | ✓ |
| Parity, setTitleField | `setTitleField: only a text field, and not the current one` | × | ✓ |
| Parity, unindexed only for text | `addField unindexed: only a text field can skip the index` | × | ✓ |
| Member humans refused (all 7 + impact) | `a member-role person is refused every lifecycle change` | × | ✓ |
| Read-only workspace refuses all | `a read-only workspace refuses every lifecycle change` | × | ✓ |
| Member-role agents refused (all 8 kinds) | `a member-role agent cannot propose any lifecycle kind` | × (400) | ✓ (403) |
| Retire/restore keeps values and slot, audited | `a person retires and restores a field; values were kept and come back` | × | ✓ |
| Agent retire with impact preview, apply, agent restore | `an agent proposes retiring, the person sees the impact, applies, …` | × | ✓ |
| Impact count capped | `impact counting stops at the first 500 records and says so` | × | ✓ |
| Relation retire impact | `a relation field's retire impact names the links that stop showing` | × | ✓ |
| Restore after slot reuse refused (both paths, and at apply), unindexed restore keeps values | `restore is refused when another field now holds its slot, …` | × | ✓ |
| Field reorder in REST, audit `before` | `a person and an agent reorder fields; REST lists the new order` | × | ✓ |
| Retired fields keep place | `retired fields stay out of the list and keep their place after it` | × | ✓ |
| Object reorder in REST and objects.list | `a person and an agent reorder objects; REST lists the new order` | × | ✓ |
| Option reorder in REST | `a person and an agent reorder select options; REST shows them in order` | × | ✓ |
| Archive hides from REST/MCP lists and search, records and links intact, unarchive restores | `archived objects leave agents' lists and search, records and links stay, …` | × | ✓ |
| Archived objects and order | `an archived object keeps its place out of the object order list …` | × | ✓ |
| Title field change, titles follow (both paths), audit `before` | `a person and an agent change the title field; record titles follow` | × | ✓ |
| Unindexed text takes no slot; slotsLeft | `an unindexed text field takes no slot; REST reports slots left per kind` | × | ✓ |
| Review fix 1: no stale title leak | `after the title field changes, a reader who cannot see the old title field never gets its values as titles` | × (fix reverted) | ✓ |
| Review fix 2: impact hides unreadable names | `an admin scoped to one object sees no names of objects or fields hidden from them …` | × (fix reverted) | ✓ |
| Review fix 3: Email subject protected | `Email's subject stays protected after the title moves to another field` | × (fix reverted) | ✓ |

Mutants (`mutants.txt`): 8 of 8 killed (search keeps archived, person.email unprotected, slot holder ignored, agent list shows archived, titles not rewritten, standard objects archivable, proposals not validated up front, unindexed field still takes a slot).

## Full suites (`suites.txt`)

| Suite | Base aa68030 | This branch |
|---|---|---|
| `pnpm test` | 398 tests; with default workers 4 timed out under machine load, all passed alone | **425/425** with `--maxWorkers=3`. With default workers 2 timed out (`gmailSync` 5 s, `Calendar.drag` 15 s); the base timed out on the same tests under the same load, and both pass in the `--maxWorkers=3` run |
| `pnpm typecheck` | clean | **clean** |
| `pnpm test:authority` | 101/101 | **101/101** (inventory covers the 8 new rows) |
| `pnpm verify:release` | 37/37 | **37/37** |
| `pnpm build` | ok | **ok** (usual chunk-size warning) |
| `pnpm --dir packages/mcp test` | n/a | **6/6** |

Not run: `pnpm proof:authority` (SERVICE sweeps). Job C reports it failing at base before reaching the sweeps; I added sweep calls for the new writes but did not run them.

## Screenshots (SERVICE, local backend, synthetic data)

`screenshot.mjs` (Job C's harness: real app in Vite, only `src/lib/identity` swapped for a locally signed JWT, every non-localhost request blocked; log `non-local requests blocked: none`). Log: `screenshot.log`.
- `settings-fields.png`: Navigation order with Archive on custom objects; Venue fields with arrows, title badge, Use as title, Order options open on Kind, an unindexed Notes field, Fax under Retired with Restore, the "Searchable and sortable" toggle and slots left (text 4 of 8, …).
- `suggestions-retire-archive-impact.png`: pending retire-field and archive-object proposals with "What this touches" (2 records of 3 hold a value; 2 records kept), and a reorder-options proposal with its new order.
- `after-archive-nav.png`: after clicking Apply on the archive card; Workshops is gone from the nav.
- The script also clicked "Move Capacity up" (backend order became `name, city, capacity, kind, notes`), captured the retire confirm text (`Retire Capacity? 3 records of 3 hold a value…`), clicked Restore on Fax (back in the live fields), and confirmed an agent proposing to retire person.email gets `400 Email cannot be retired: campaign sending needs it`.

## Independent review

I asked Astra (OpenAI gpt-6-astra via Codex, read-only) to review the diff; raw output in `astra-review.txt`. I checked each finding against the code:
1. Stale title leak after a title-field change (reader allowed the new field but not the old one saw old values while titles were rewritten): **real, fixed** (decision 9) with a test.
2. Impact preview named objects/fields hidden from a scoped admin: **real, fixed** with a test.
3. Moving Email's title then retiring Subject would stop sending: **real, fixed** (subject protected) with a test.
4. Impact inside the Suggestions list could exceed Convex read limits with many pending proposals: **real, fixed** (per-card query, 500-record cap).
5. Retitle pages could exceed the 16 MiB read limit with huge records: **reduced, not eliminated**. Pages are now 50 records; display no longer depends on stored titles; the job can be re-run by hand. A page of 50 records near Convex's 1 MiB document maximum could still fail, leaving search titles stale for that object.

## Rollback compatibility (`rollback.mjs`, `rollback.log`, SERVICE)

- **This release runs on data written by the previous one**: all schema changes are optional fields and new union variants. No new standard objects or fields, so `seed:ensureStandard` is unchanged (and was not retested for idempotency for that reason).
- **A plain rollback to aa68030 is refused once this release has written lifecycle data.** Exercised: pushing aa68030's `convex/` over data written by this build fails with `Schema validation failed … table "authorityAudit" … extra field 'before'`. Any archived object (`objects.archived`) or lifecycle proposal (new `shapeSuggestions.change` kinds) has the same effect. `pnpm deploy:prod --ref` already refuses a ref whose schema rejects the backup.
- **A schema-only rollback build works**: aa68030's code plus this branch's `convex/schema.ts`, `convex/lib/metadata.ts` and `convex/lib/slots.ts` started (`functions ready`), listed the archived object as a normal one (old code ignores the flag), created a record, listed a pending lifecycle proposal (with no summary; applying one under old code would mark it failed, not apply it), and the agent still saw the object. Rolling forward again kept the archive state, the retired field and the pending proposal.

## Owner setup to go live

None. No env vars, no external services. After deploying, existing orgs see the new controls in Settings. Admin agents can use the new proposal kinds right away (MCP clients pick up the new tool text when rebuilt: `pnpm --filter @remold/mcp build`).

## Left undone or uncertain

- Records whose title field is a lookup to an object whose title field changed keep their old stored title until next edited (search index only; display follows `visibleTitle`). Pre-existing behavior for lookup titles, not addressed.
- Retitle byte-limit risk (review finding 5) is reduced, not removed.
- An archived object still appears in Settings pickers for agents' read scopes and in the objects selector in Settings (marked "(archived)"), by design, so it can be managed and unarchived.
- `pnpm proof:authority` not run (pre-existing base failures per Job C).
- Ordering uses up/down buttons rather than dnd-kit dragging; one arrow click is one server call carrying the whole new order.
- `convex/_generated/api.d.ts` was edited by hand to register `lib/lifecycle` (same form codegen writes); a later `convex codegen` will produce the same lines.
