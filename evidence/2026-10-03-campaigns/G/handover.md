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

---

# Round 2 (after independent verification: REVISE on 050abad)

Verdict: `~/work/briefs-1003/iv-G-verdict.md` (Claude Fable 5.1). Coordinator decisions 1–6 carried out on `remold/shape-lifecycle`. Commits: merge `2b8263e` (integ/campaigns 4bce955), then the round 2 commit that carries this section. Not pushed. Evidence level unchanged: tests are convex-test (SIM); screenshots ran on an isolated local backend (SERVICE, synthetic data).

## What changed in round 2

- **Merge (decision 4)**: `git merge origin/integ/campaigns` (4bce955). Conflicts in `convex/schema.ts`, `convex/agentApi.ts`, `packages/mcp/src/index.ts`.
  - `schema.ts`: integ's `authorityAudit.by_target` index and G's `before` field are both kept.
  - `agentApi.ts`: `/objects` keeps integ's per-field `withTime`, `protectedFromAgents` and `write {create, update}` alongside G's `includeArchived`, `archived`, `retiredFields` and `slotsLeft`. `me` is integ's. `proposeShape` keeps integ's idempotency replay with G's `indexed` and `order` args. `markReplied` is integ's.
  - MCP: `remold_objects` describes write modes and archived/slots, and takes `includeArchived`. `remold_propose_shape` has integ's `writeKey` with G's 12 kinds, `indexed` and `order`. The server instructions keep both additions.
  - Every inventory entry from both sides is kept (269 rows).
- **Stale search index (decision 1)**: `objects.retitling` (optional `{from, cursor, at}`, index `by_retitling`).
  - `setTitleField` sets `retitling` with every earlier title field and rewrites the first 50 stored titles in the same transaction. Each later page advances `cursor`/`at`, and the last page clears the field. A second change during a rewrite adds to `from` and restarts from the top.
  - **Choice: restricted, not refused.** While an object is retitling, its stored titles are used for search (`lib/search.ts` `storedTitlesReadable`) and title matching for lookups, CSV and capture (`lib/find.ts`) only when the caller can query every field in `from`. Anyone else gets no title matches from that object until the rewrite ends. Why: a caller who can read both the old and new title fields learns nothing from a stale match, so blocking them (often the admin who made the change) would only take search away. A caller who cannot read an old field would learn that field's values from which record matched, so they get nothing. Display was already correct (`visibleTitle` reads the current field).
  - **Resume**: new minute cron "Resume title rewrites" runs `lib/lifecycle:resumeRetitles`. It picks up any object whose rewrite has not advanced for 2 minutes and continues it in pages of 10, so a page that failed on the read limit is retried smaller. Up to 20 objects per minute.
- **Probes and mutants (decision 2)**: P1–P5 adopted into `convex/lifecycle.test.ts` (P3 covers both the human and apply paths; P3b also checks apply re-checks unrestricted access). **Verifier mutants: 6/6 killed** (`round2-mutants.txt`).
- **Impact previews (decision 5)**:
  - Counts stop at 500 records or about 3 MB read and then say "500+".
  - An indexed field's "hold a value" count reads only records through its slot index; the total, and unindexed fields, scan `by_object` under the same cap. Convex allows one `.paginate()` per function, so both use bounded async iteration.
  - Settings: the retire and archive handlers run inside `attempt`. If the preview fails, a toast shows the error and the confirm still opens with "Could not count what this touches: …".
  - Suggestions: each card renders its preview inside its own error boundary. A failing preview shows that message in its card, and the other proposals still render. Tested in `src/routes/Suggestions.test.tsx`.
- **Decision 6**:
  - `opportunity.stage` is protected: "Stage cannot be retired: Today's quiet deals and agent guards need it".
  - An archived object takes no new records: human create, agent `POST /changes` create, agent `POST /suggestions` create, and CSV `importRows` all refuse with "Unarchive Venues to add records" (`requireLive` in `lib/metadata.ts`, checked in `applyChange`, `agentApi.propose` and `csv.importRows`). Updates and reads still work.
  - Archived objects are hidden from both agent scope pickers in `AgentsCard`. This is display only, so access an agent already has to an archived object is not dropped on save.
  - Email preview and campaign report names (recipient and audience rows, the campaign name) now come from `visibleTitle`, never the stored title. The merge-tag `{{name}}` used for sending reads the current title field's value.
- **Tests changed elsewhere (setup only, assertions untouched)**:
  - `convex/intake.test.ts` retired `opportunity.stage`, and integ's `convex/jobE.test.ts` ("REST Today uses the app selection for retained done values") retired `task.done`. Both are now refused by design, so both tests put the workspace into the retired state with `t.run`, as an older workspace could be.
  - `convex/lifecycle.test.ts`: the 500-record fixture now writes slot projections like `applyChange` does.

## Fail before, pass after (round 2)

- `round2-fail-before.txt`: before the fixes, 8 new tests failed for the intended reasons:
  - P1: a reader got 50 records for `q=Secret`.
  - The lookup by title matched hidden "Secret110".
  - No `retitling` field (×3 tests).
  - Stage was retirable.
  - Archived objects took new records (null message).
  - The preview and report contained "Secret Ava".

  The 500+ impact test also failed against the old "first 500" wording. P2–P5 and P3b passed on the unfixed code, as the verifier found; they are there to kill the verifier's mutants.
- `round2-ui-fail-before.txt`: the Suggestions test fails with the round 1 card (one failing preview takes the page down). It passes now.
- `round2-pass-after.txt`: `convex/lifecycle.test.ts` + `src/routes/Suggestions.test.tsx`: **41 passed (41)**.
- `round2-mutants.txt`:
  - Verifier mutants M-a, M-c, M-h, M-d, M-i and the P3 apply path: **6/6 killed**.
  - Round 2 guards R1–R14 (search and matching ignoring retitling, flag never cleared, sweeper idle or ignoring the stall threshold, second change forgetting fields, stage unprotected, archived creates through each of the 3 paths, stored titles in preview and report, no card boundary, slot count ignored): **14/14 killed**. R5 and R11 survived the first run, and I strengthened those tests before recording.
- `round2-verifier-probes.txt`: the verifier's own probe file run on this branch. P1–P6 pass. P7 now fails **by design**: it asserted that an agent's create proposal on an archived object returns 201, and decision 6 makes it 400 "Unarchive Venues to add records".

## Full suites, round 2 (`round2-suites.txt`)

| Suite | Result |
|---|---|
| `pnpm test --maxWorkers=2 --testTimeout=60000` (machine loaded by other jobs) | **510/510** |
| `pnpm test` (default workers, load ~5) | 507/510. 3 timeouts (`gmailSync` 5 s, two `Calendar.drag` 15 s), the same tests that time out on the base under load. All pass in the run above. |
| `pnpm typecheck` | clean |
| `pnpm test:authority` | **101/101** (inventory adds `lib/lifecycle:resumeRetitles` and `cron Resume title rewrites`; `inventory.test.ts` cron list updated) |
| `pnpm verify:release` | **37/37** |
| `pnpm build` | ok |
| `pnpm --dir packages/mcp test` | **8/8** |

Job E's MCP probes (`convex/jobE.probe.test.ts`) are part of `pnpm test` and pass.

Screenshots retaken on the final code (`screenshot.log`, `non-local requests blocked: none`). `suggestions-retire-archive-impact.png` shows the per-card previews loading.

## Rollback (decision 3: no code here)

The coordinator ships one schema expand commit for the release. These are the exact schema lines G needs on top of aa68030's schema (all additive; integ's own lines are not listed):

In `convex/schema.ts`:
```ts
// Set while stored record titles still hold earlier title fields' values (lib/lifecycle.ts).
const retitling = v.object({ from: v.array(v.id("fields")), cursor: v.union(v.string(), v.null()), at: v.number() });
// authorityAudit: add the field
before: v.optional(v.string())
// objects: add the fields and the index
archived: v.optional(v.boolean()), retitling: v.optional(retitling)
.index("by_retitling", ["retitling.at"])
```
In `convex/lib/metadata.ts` (imported by the schema for `shapeSuggestions.change`):
```ts
// fieldSpec: add
indexed: v.optional(v.boolean())
// shapeChange union: add these variants
v.object({ kind: v.literal("retireField"), objectId: v.id("objects"), fieldId: v.id("fields") }),
v.object({ kind: v.literal("restoreField"), objectId: v.id("objects"), fieldId: v.id("fields") }),
v.object({ kind: v.literal("reorderFields"), objectId: v.id("objects"), fieldIds: v.array(v.id("fields")) }),
v.object({ kind: v.literal("reorderObjects"), objectIds: v.array(v.id("objects")) }),
v.object({ kind: v.literal("reorderOptions"), objectId: v.id("objects"), fieldId: v.id("fields"), optionIds: v.array(v.string()) }),
v.object({ kind: v.literal("archiveObject"), objectId: v.id("objects") }),
v.object({ kind: v.literal("unarchiveObject"), objectId: v.id("objects") }),
v.object({ kind: v.literal("setTitleField"), objectId: v.id("objects"), fieldId: v.id("fields") }),
```
Round 1 showed old code runs on these declarations (`rollback.log`). One caveat for code older than this branch: it ignores `retitling`. If an older build runs while an object is mid-rewrite, nothing restricts search on that object, and no cron resumes the rewrite. Rolling forward again resumes it via the sweeper, because the marker is still on the object.

## Still open or uncertain

- The resume cron retries pages of 10. A single record close to Convex's 1 MiB document limit is still read within budget, but a page of 10 such records is about 10 MiB, under the 16 MiB limit. I have not tested real byte limits; convex-test does not enforce them.
- The impact byte budget is estimated from `JSON.stringify` length, not Convex's own accounting.
- Archived objects still show in the Settings object selector (marked "(archived)") so they can be managed. They are hidden from both agent scope pickers.
- Records of other objects whose title is a lookup to a retitled object keep their stored lookup-derived title until edited (pre-existing behavior for lookup titles; display follows `visibleTitle`).
- `pnpm proof:authority` was not run (pre-existing base failures per Job C). The new public writes already have sweep calls from round 1; no new public writes were added in round 2.
