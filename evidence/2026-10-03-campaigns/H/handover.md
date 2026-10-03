# Job H handover: bounded bulk changes for agents and people

Builder evidence only, not certification. Levels: unit (convex-test) and SERVICE (an isolated local Convex backend with synthetic data, `ops/authority/local.mjs`). No hosted service, deploy or real email was touched. No push.

- Branch: `remold/bulk`, based on origin/integ/campaigns (aa68030).
- Code commits: 5ff7d69 (feature), 1708421 (delete impact counted after submit, card copy). Final commit (this handover and evidence): `git log -1 remold/bulk`.

## What changed

- `convex/schema.ts`: three new tables, `batches`, `batchItems` and `suggestionLinks`. No field was added to any existing table (see Rollback).
- `convex/agentApi.ts`: link deltas (`links: { field: { add, remove } }`) on `propose` and `change`; `proposeBatch` (submit, per-item validation, summary, Idempotency-Key replay) and `batchStatus` (paged, projected to the agent).
- `convex/batches.ts` (new): human `list`, `items` (paged preview), `apply` (apply all, or resume), `dismiss`; internal `step` (one transaction of up to 25 items, or exactly one), `next`, `failItem`, `count` (delete impact, 100 per transaction), and the `drive` action that runs the steps; `summaryOf`.
- `convex/suggestions.ts`: single suggestions carry link deltas (stored in `suggestionLinks`) through list, apply and adopt; `linksOf`.
- `convex/events.ts`: history entries carry `batchId` and, for a proposal, `proposedByName` (looked up through `batchItems.by_event`).
- `convex/lib/values.ts`: `joined`, a links value after a delta.
- `convex/http.ts`: `POST /api/v1/batches`, `GET /api/v1/batches/<id>?cursor=&limit=`.
- `convex/_generated/api.d.ts`: registers `batches` (codegen needs a deployment; edited by hand to match what codegen writes).
- `packages/mcp/src/client.ts`, `index.ts`: `remold_propose_batch`, `remold_apply_batch` (direct, optional `idempotencyKey`), `remold_batch_status`; `links` on `remold_propose_change` and `remold_apply_change`; the server instructions point agents at batches for many records.
- `src/components/BatchCard.tsx` (new): the batch card. It shows the summary, counts, delete impact, the reason and a paged table (10 rows), plus progress. Buttons: Apply all, Dismiss, Resume, and Skipped and Failed filters.
- `src/routes/Suggestions.tsx`: batch cards in "Waiting for you", plus new "Applying" and "Finished batches" sections. `useWaiting` now counts pending batches (nav badge, Today).
- `src/components/SuggestionCard.tsx`: shows a single suggestion's link delta. `src/routes/RecordPage.tsx`: history adds "proposed by <agent>".
- `ops/authority/inventory.json`: 13 new rows (`inventory-rows.mjs`). `ops/authority/service-sweeps.mjs` and `fixture-sweeps.ts`: readonly sweep calls for `batches:apply`, `batches:dismiss` and `POST /api/v1/batches`; the table dump now includes the batch tables.
- Tests: `convex/batches.test.ts` (new, 33 tests), `packages/mcp/src/client.test.ts` (+1).

## How it works

An agent posts `{ reason, changes: [...up to 1000], direct? }`. Each change is `{ action, object?, record?, values?, links? }`. Every item is checked the way a single proposal is: the same `targetOf` / `proposed` code, read scope, `canPropose`, required fields, value resolution and `agentGuard`. A direct batch checks the agent's grant for each item (`recordGranted`, with the touched field ids). If any item fails, nothing is stored. The response is the first failing item's code (400, 403 or 404) with `items: [{ index, code, message }]` listing every failing item.

A proposal shows up as one card on Suggestions. Apply all hands the batch to a background driver. The driver runs `step` mutations of 25 items. Each item is marked in the same transaction as its write, so a repeated or concurrent step never applies an item twice. If a whole chunk throws, the next 25 items are retried one transaction each, and an item that still throws is recorded as failed with its message. An item whose record changed since review is skipped and reported as conflicted. For an update, that means any field it touches changed; for a delete, any field at all, except a lookup or links value that only lost records deleted since. Link deltas never conflict: they are applied to the links as they are at apply time.

The card shows progress. Resume (or the agent replaying its Idempotency-Key, for a direct batch) restarts a driver that died, and is safe to repeat.

## Decisions and why

1. **Who writes a proposal: the agent, approved by the person, with the person named as actor.** The brief says "the person as actor". The first build passed the person as principal. The independent review found that this skipped `agentGuard` on reference cleanup: deleting a company cleared a protected lookup elsewhere. It now calls `applyChange(agent, change, { approvedBy: person, actor: person })`, the same authority as an approved single suggestion: both the agent's and the person's scopes, and the agent's guards on cascades. Events show the person as actor, the batch reason as reason, `batchId`, and "proposed by <agent>".
2. **Attribution without touching `events`.** Adding `batchId` to events would make the previous release refuse to deploy over new data. Convex validates existing documents against the schema, and the rollback harness checks for exactly that. The item stores its `eventId`, and history finds the batch through the `by_event` index. For the same reason, a single suggestion's link delta lives in `suggestionLinks`, not in `suggestions.change`.
3. **Chunks are mutations driven by an action.** Convex has no savepoints. A throw inside `applyChange` after a write (email rules, a guard during cascade cleanup) cannot be caught safely inside a mutation, so a failing chunk is rolled back whole and retried item by item. Chunk size is 25, capped at 100 per step.
4. **Visibility and apply gate for people.** A person sees a batch only with all-record scope on every object it touches, and every field it writes readable on all records in that scope. That rules out combining a field seen on some records with records seen without it, which the review flagged. A member who cannot write all of it cannot see it, apply it or dismiss it (404). Each item is then authorized again for the person inside `applyChange`.
5. **Revocation.** A batch from an agent that was revoked, fired or had its epoch bumped cannot be applied. If it happens mid-run the batch stops ("This agent's access changed since it asked. Dismiss the rest of the batch.") and Resume is refused. Dismiss is allowed on pending and stopped batches. A change in the approver's membership epoch also stops it; anyone allowed to apply can resume, and they become the approver.
6. **Read-only workspace.** Submit and apply are refused. A running batch stops before writing anything and can be resumed later. Dismiss still works, as a reduction.
7. **Delete impact** is the count of incoming links rows plus lookup referrers. It is counted after submit, by a scheduled `count` in chunks of 100 items. In the first build it ran inside the submit, and a 1000-delete submit hit Convex's 1s limit on the local backend. The card says "Counting what deleting would clear…" and Apply is refused (409) until the count is done. The count includes records the reader may not see, so it is shown only to unrestricted people (`unrestrictedHuman`). Agents never get it, and direct batches skip it.
8. **The summary is stored with a `{record}` placeholder.** Each reader gets the record title they are allowed to read ("a record" otherwise). Examples: "Update Stage on 60 Opportunities", "Add 6 People to Spring webinar", "Add 2 and remove 1 People on Spring", "Delete 2 Companies and 1 Person".
9. **One change per record per batch.** A second change to the same record is refused ("This record already has a change earlier in the batch"). Values and link deltas for one record go in one item.
10. **Rate limit.** One batch POST costs one REST write token, so a 1000-item batch is one call.
11. **Idempotency** works on both proposals and direct batches (ADR 002 store, keyed to route and body). Replaying a direct batch returns the same batch, and restarts the driver if it was stopped or applying.
12. **Agent reads** (`GET /batches/<id>`) are limited to the submitting agent, which sees only its own batches. Values, links and conflicts are projected through what it may read now; conflicts on hidden fields are dropped and record-gone conflicts show no values.
13. **"Email rules" at submit** are the agent limits that single proposals use (`agentGuard`: agents cannot approve or edit approved emails, or start campaigns). `emailRules` itself runs at apply time inside `applyChange`, as for single suggestions; an item it refuses is recorded as failed.

## New env vars

None.

## Fail before, pass after

All 33 tests in `convex/batches.test.ts` fail at aa68030 (`fail-before.txt`: `Tests 33 failed (33)`; reasons in `fail-before-reasons.txt`, e.g. route 404, `Could not find module for: "batches"`, `client.proposeBatch is not a function`). After: 33 passed. The MCP client test failed before (`fail-before-mcp.txt`, `TypeError: client.proposeBatch is not a function`, 1 failed of 7) and passes after.

The tests that cover each Done-when item:

| Done when | Test(s) |
|---|---|
| one invalid item refuses the batch with its index and message | refuses the whole batch when one item is invalid, naming its index and message; refuses more than 1000 changes, an empty batch and the same record twice |
| agentGuard and protected fields per item | enforces agent guards and protected fields per item; refuses items outside the agent's proposal scope; still holds the agent's limits at apply time...; holds the agent's limits on reference cleanup when a person applies its delete |
| conflicted items skipped, the rest applied | skips items whose record changed since review and applies the rest; records an item that fails at apply time as failed and still applies the others |
| resumes after an interrupted chunk without double-applying | resumes after an interrupted run without applying anything twice (runs a chunk, cancels the driver, repeats a chunk, resumes twice; exactly one batch event per record); stops an applying batch when the workspace turns read only and resumes it later |
| link deltas never drop a concurrently added link | adds people to a campaign without dropping a person a teammate added meanwhile; applies a single suggestion's link delta on top of the current links; keeps a suggestion's link delta when a person adopts it; applies a direct change's link delta and refuses a non-links field or the same person twice |
| delete impact counts correct | counts the links each delete would clear (4, 1, 0; total 5); deletes records in one batch even when an earlier delete cleared their links |
| direct batch refused if any item lacks a grant | refuses a direct batch when any item lacks a grant, naming the item |
| idempotent replay | applies a granted batch at once, replays its Idempotency-Key, and is attributed to the agent (same id, one record, 422 for a different body) |
| attribution on events | shows one card..., applies in chunks with the person as actor, and attributes every event; a member-role person with full access applies, and the events name them |
| member-role humans cannot apply batches on objects they cannot write | a member-role person cannot see or apply a batch touching an object they cannot write; a person with a hidden field the batch writes cannot apply it; a person who sees a field only on some records cannot see a batch writing it on others |

Other tests: the 1000-change batch end to end, dismiss, a revoked agent's batch (pending and mid-run), read-only refusal, agent-only reads, conflict masking, title masking in summaries, and the MCP client against the real REST router.

**Mutants** (`mutants.mjs`, output `mutants.txt`): 29 deliberate breaks, each run against the batch tests, **29/29 caught**. They include the conflict check, link joining, step re-reading applied items, the grant check, agent guards, visibility, impact, idempotency, attribution, the size limit, chunk fallback, read-only stop, revocation, the counting gate, and one mutant reverting each of the seven review fixes. That last group is the fail-before evidence for behaviors added after the first build. Mutant runs leave out the 1000-item test for time.

**Independent review.** Astra (gpt-6-astra via Codex, read-only; `astra-review.txt`) reported seven issues against the first build. I checked each and all were real: cascade guards, revocation mid-run, mixed-scope visibility, conflicts leaking hidden fields, raw titles in summaries, a batch's own cleanup causing conflicts, and delete impact revealing hidden links. All are fixed, each with a test and a reverting mutant. This was a builder-commissioned review, not the job's independent verification.

## Full suites (after, at 1708421)

| Suite | Baseline aa68030 | After |
|---|---|---|
| `pnpm test` | 398 tests, 397 passed; 1 timeout (gmailSync) under machine load | 52 files, **431/431** |
| `pnpm typecheck` | clean | **clean** |
| `pnpm test:authority` | 101/101 | **101/101** (inventory covers the 13 new rows) |
| `pnpm verify:release` | 37/37 | **37/37** |
| `pnpm build` | ok | **ok** (`✓ built`) |
| `pnpm --dir packages/mcp test` | 6/6 | **7/7**; `tsc` build clean |

The final run used default settings at load average ~1. Earlier, while other sessions loaded the machine (load 8 to 10 on 8 cores), three existing tests timed out. They are `gmailSync` (5s), `rateLimit`, and two `Calendar` paging tests with their own 15s limits. The same tests timed out on a clean aa68030 checkout under the same load (`base-timeouts-under-load.txt`), so they are not caused by this job.

## SERVICE (local backend, synthetic)

- **Screenshots** (`screenshot.mjs`, `screenshot.log`): the real app in Vite against the isolated backend. Only `src/lib/identity` is swapped for a locally signed JWT; non-local requests blocked: none.
  - `batch-cards.png`: three pending cards (delete with "clears 1 link", "Add 6 People to Spring webinar", "Update Stage on 12 Opportunities" with the paged table).
  - `batch-card-page-2.png`: the second page.
  - `batch-card-finished.png`: after clicking Apply all, with one deal a person had moved meanwhile: "Applied 11 of 12, skipped 1 changed since review". The backend afterwards: 11 deals `qualified`, Board dinner still `proposal`.
- **Scale** (`scale.mjs`, `scale.log`): 1000 stage updates were submitted in 2.3s wall time over REST and applied in 15s, all 1000 applied. 1000 company deletes were submitted in 2.0s, impact counted in 11.7s (250 = 200 people + 50 campaign links), and applied in 32s, all 1000 applied. No function timed out in the backend log.
- **Rollback** (`rollback.mjs`, `rollback.log`): see below.
- I did not rerun `pnpm proof:authority`. Job C recorded that it fails at base for reasons unrelated to this job; the sweep rows added here are untested at SERVICE level.

## Rollback compatibility

The schema change is additive: three new tables and nothing changed on existing tables. No standard objects or fields are new, so `seed:ensureStandard` is untouched. Exercised on the local backend (`rollback.log`):

1. This build wrote two finished batches (one direct), one pending batch, and a suggestion with a link delta.
2. The previous release's `convex/` (aa68030) was pushed over the same data and reported `functions ready`. Old code read records and history, listed suggestions and updated records. `/api/v1/batches` returned 404, as expected.
3. Forward again, the batches were intact (`{"pending":1,"done":2}`). The direct batch's key replayed to the same id, and the batch left pending across the rollback then applied.

**Caveat:** under the previous release, applying a suggestion that carries a link delta marks it applied without the delta, because the old code does not know `suggestionLinks`. In the run, Spring's people stayed `[Ada]` and Ben was not added. Nothing breaks, but the person must redo that one change by hand.

## Owner setup to go live

None beyond a normal `pnpm deploy:prod`. Agents use their existing keys. Direct batches need the same grants as single direct changes.

## Left undone or uncertain

- **Submit time margin.** A 1000-update submit fit within Convex's 1s mutation limit on the local backend, but I could not read the exact execution time. The 2.3s wall time includes HTTP and the rate limiter. A production deployment under load could be closer to the limit. If so, lower `MAX_BATCH`, or validate in chunks.
- Apply chunks of 25 deletes run cascade cleanup per item. On the local backend none timed out; if one does, the driver falls back to one item per transaction, which is slower but correct.
- `batches.list` reads the 50 newest batches per status and filters by visibility in memory. For a restricted reader the cost depends slightly on batches they cannot see (count-level timing only), as with Job C's shape proposals.
- Delete impact is counted at submit time. Links added between the count and apply are not reflected in the card.
- Concurrent drivers are safe but not prevented. The UI offers Resume only for a stopped batch, or one with no progress for a minute.
- The readonly service sweep (`service-sweeps.mjs`) has the new entries but was not run (see above).
- Screenshots use a local identity stub, not WorkOS sign-in.
- Not independently verified by the coordinator's verifier.

## Round 2 (merge)

Merged `origin/integ/campaigns` at df22614 into `remold/bulk` (merge commit: `git log -1 remold/bulk`). Integ's new work since aa68030 includes: campaign email fix rounds, defect fixes (F3 stale deletes, row-atomic CSV, MCP idempotency keys), agent object access, saved views, automations and shape lifecycle.

### Conflicts and how each was resolved

- `ops/authority/inventory.json`: took integ's file and reran `inventory-rows.mjs`, which only adds missing rows. Result: 303 unique rows; every row from both sides is present (checked by id).
- `convex/agentApi.ts`, imports: both sides' imports kept. `targetOf` keeps integ's `objectForId(..., retained)` for deletes and my per-batch cache, now keyed by object and action. `propose` takes integ's version (Idempotency-Key replay, `requireLive` on create) plus `links`; integ's `remember(...)` is kept, and the link delta goes to `suggestionLinks`. The end of the file keeps my batch functions and integ's saved-view functions.
- `convex/events.ts`: integ's automation actor naming, plus `batchId` and `proposedByName`.
- `convex/_generated/api.d.ts`: both `automations` and `batches`.
- `ops/authority/service-sweeps.mjs`: both `batches` and integ's `view` in the sweep workspace.
- MCP `client.ts`: integ's `request()` reads `idempotencyKey` from the body and sends it as the `Idempotency-Key` header. `proposeBatch` and `applyBatch` now use that same path; my separate headers argument is gone. `index.ts`: integ's template-literal instructions with my batch sentence; `changeShape` has integ's `idempotencyKey` and my `links`; `batchShape` takes `idempotencyKey` too. `client.test.ts`: both sides' tests.
- `src/routes/Suggestions.test.tsx` (integ's) mocks `useQuery` and returned `undefined` for unknown queries, so the page waited on `batches:list` forever. The mock now returns `[]` for `batches:list`.

### Making batches respect the new rules

- **Archived objects.** The batch submit now calls `requireLive` on every create item, so the batch is refused with that item's index ("Unarchive Venues to add records"). This applies to both proposals and direct batches. Previously it was accepted at submit and only failed at apply. `applyChange` (integ) still refuses at apply as well.
- **Status rules for email, post, booking and automation.** Each item goes through `agentGuard` at submit and through `applyChange` at apply. Since the merge, `applyChange` also runs `emailRules` before writing, plus `automationRules` and the gated statuses. Nothing batch-specific was needed: the rules apply per item, and an item refused at apply is recorded as failed.
- **Stale deletes (F3), one rule.** `convex/lib/conflicts.ts` (new) has `staleFields`. An update conflicts on the fields it writes; a delete conflicts on any field, except a lookup or links value that only lost records deleted since. `suggestions.apply` and the batch engine both call it.
  - Behavior change for single suggestions: a delete suggestion whose only difference is a reference cleared because the linked record was deleted now applies instead of conflicting. I judged that cleanup isn't an edit by a person. Integ's F3 tests still pass.
- **Audience snapshot.** An approved email's recipients are fixed as `emailSends` rows at approval (integ). A batch that adds people to an active campaign only changes the campaign's People. The approved email's rows and status are unchanged, and later emails pick the new people up at their own approval.
- **Automations.** Each batch item is one `applyChange` with one event, so integ's trigger queues one run per item (key `automationId:eventId`). Batch writes are not automation runs, so each run starts at depth 1 and the chain-depth limit applies as usual.

### Tests added (round 2)

In `convex/batches.test.ts`, under "batches and the rest of the workspace":

- refuses a batch creating records on an archived object, naming the item (proposal and direct). Fail before: `expected 201 to be 400` (`round2-fail-before.txt`).
- refuses a batch in which an agent approves an email, proposed or direct (403, item 0, "Only a person can approve an email").
- adding people to an active campaign in a batch never adds them to an approved email's recipients (fetch stubbed to throw, nothing is sent).
- fires an automation once per batch item, each run at depth 1 (3 items give 3 runs and 3 inbox items).
- uses one stale-change rule for suggestions and batches. With integ's inline rule in `suggestions.apply` it fails (`applied` expected, `conflicted` got); it passes with the shared rule.

The email, audience and automation tests passed as soon as they were written. They pin behavior the merge already provides through `applyChange`; they did not drive a change.

Mutants: 2 new (archived create accepted at submit; suggestions keep their own stale rule), both caught. Two older mutants were repointed to `convex/lib/conflicts.ts` and rerun after the merge, both caught. Total 31/31 (`mutants.txt`).

### Suites after the merge (`round2-after.txt`)

| Suite | Result |
|---|---|
| `pnpm test` | **604/604** with `--testTimeout=60000 --maxWorkers=2`. At default parallelism, 602/604: `gmailSync` "newest past activity" (5s limit) and Calendar "keeps every post" (15s limit) time out. Both pass alone (9/9). These are integ's timing-bound tests on an 8-core machine shared with other jobs. |
| `pnpm typecheck` | clean |
| `pnpm test:authority` | 101/101 |
| `pnpm verify:release` | 37/37 |
| `pnpm build` | ok |
| MCP tests | 10/10 |
| `pnpm --dir packages/mcp build` | ok (tsc clean) |

### Not redone in round 2

The SERVICE runs (screenshots, rollback, scale) were not repeated after the merge. The rollback target is now df22614 rather than aa68030; the batch tables are still additive, and no existing table changed in this round. During the merge I briefly lost the merge parent: a temporary "wip" commit was reset. I restored `MERGE_HEAD` to df22614 before committing, so the final commit is a real two-parent merge.

## Round 3 (independent verification: REVISE on 4ef1f92)

Sol 6.1's verdict is in `~/work/briefs-1003/ivH/iv-H-verdict.md`. First, `origin/integ/campaigns` at e19eeef was merged as **c6b085d**. There were three conflicts:

- `inventory.json`: integ's file plus my rows script, giving 310 unique rows with every row from both sides.
- `agentApi.ts` imports: union of both sides.
- MCP instructions: integ's template literal, which now starts with remold_map, plus a sentence on remold_propose_batch, remold_apply_batch and remold_batch_status.

The fixes below were all made failing-first. Before: `round3-fail-before.txt`, 8 of Sol's repros plus 3 counting tests failing. After: `round3-after.txt`.

1. **Stale deletes: the conservative rule (blocker).** `convex/lib/conflicts.ts` `staleFields` now treats any difference between the reviewed snapshot and the current record as a conflict. That includes a reference cleared by cascade cleanup; the exemption is gone. Single suggestions and batch items both use it, and a person re-proposes.
   - Sol's three repros are adopted in `convex/batches.iv.test.ts`: human unlink of a lookup, human removal from a links field, and the batch version. Sol's positive control ("deleted after actual cascade cleanup applies") is inverted to expect `conflicted`, per the decision.
   - Two of my own tests changed with the rule. A batch `[delete Acme, delete Ada (company Acme), delete Spring (links Acme)]` now applies 1 and conflicts 2. Listing the referrers before the record they point at applies all 3; both cases are tested. The MCP `remold_propose_batch` description now tells agents to order deletes that way.
2. **Batch reasons (blocker).** `reasonFor` returns the free-text reason only to a viewer who can read every field of every object the batch touches, on all records; anyone else gets `""`. It is used by the human list and by every agent response: submit, Idempotency-Key replay and `GET /batches/<id>`. Both of Sol's repros are adopted. One more test covers an agent with a hidden field on submit and on replay; the human owner still sees the reason. The card shows no quote when the reason is empty.
3. **BatchCard.**
   - A timer (`useStale`) re-renders the card one minute after the last progress, so Resume appears for a stalled batch without a database write.
   - Stopped batches, including a revoked agent's, show Dismiss.
   - Sol's two UI repros are adopted in `src/components/BatchCard.test.tsx`, plus a test for Retry and "N+".
4. **Bounded impact counting.**
   - `batches:count` is one bounded step. It reads at most `BUDGET` (400) units, and every query costs at least one unit. It resumes from a cursor `{ phase, field, index, source, after: _creationTime }`. It pages incoming `links` and each indexed lookup's slot index with `.gt("_creationTime", after)`, so no `collect()` remains.
   - An unindexed lookup is never scanned whole. Its source object is read up to `SCAN_CAP` (500) records, once per batch, using the new `batchItems.by_batch_record` index to find the deleted item. If there are more records, the total is marked partial and the card reads "N+ links".
   - `batches:countDrive` (action) runs the steps. If a step throws, `batches:countFailed` sets `countError`. The card then shows "Could not count what deleting would clear." with a **Retry** button (`batches:recount`, public), and Apply is refused with 409 until the count succeeds.
   - Retry bumps `countRun`; steps from an older run change nothing. A test caught the double count without this: two drivers produced 2204 instead of 1204.
   - Tests: the count spans several steps (the first step is not done and has at most 400) and reaches the exact total, 1204; the unindexed cap gives `impact: 500, impactPartial: true`; a failed count shows Retry, refuses Apply, and counts again after Retry.

Schema (all within the new tables): `batches.impactPartial`, `countRun`, `countError` (optional) and `batchItems.by_batch_record`. Inventory: 3 new rows (`batches:countDrive`, `batches:countFailed`, `batches:recount`; 12 `batches:*` rows in total). The readonly sweep calls `batches:recount`, which is reduction-only: it changes only batch bookkeeping.

**SERVICE (local backend, `round3-scale.log`).** The first rerun of `scale.mjs` found a real problem. A count step over 1000 company deletes hit Convex's 1s limit, because empty index queries were not charged against the budget. With every query costing at least one unit, the rerun passed:
- 1000 updates: submit 2.3s wall, applied 1000.
- 1000 deletes: impact counted in 16.9s (250), applied 1000.
- No function timeouts in the backend log.

The screenshots and the rollback run were not repeated this round.

**Mutants (`mutants.txt`).** 7 new, 6 caught: reason check skipping fields, deletes ignoring lookup changes, old count runs still counting, a failed count leaving counting on forever, the count cursor lost between pages, and Apply ignoring a failed count. 1 survived: scanning the whole object for an unindexed lookup gives the same result, and only the read cost differs, which convex-test does not enforce. The minimum query charge has the same limit; the SERVICE run above is the evidence for both. A no-op mutant I wrote by mistake was dropped.

**Suites (final code):**

| Suite | Result |
|---|---|
| `pnpm test` | **676/676** with `--testTimeout=60000 --maxWorkers=2`. At default parallelism, 675/676: gmailSync "newest past activity" timed out at its 5s limit, as in earlier rounds. |
| `pnpm typecheck` | clean |
| `pnpm test:authority` | 101/101 |
| `pnpm verify:release` | 37/37 |
| `pnpm build` | ok |
| MCP tests | 12/12 |
| `pnpm --dir packages/mcp build` | ok (tsc clean) |

**Left for the next verification:**
- Sol noted that booking is not a standard object on this branch, so booking status rules cannot be exercised here.
- Rollback against df22614 or e19eeef was not rerun. The schema changes this round are optional fields and an index on the new tables only.

## Round 4 (independent verification round 2: REVISE on 8ebb40b)

Sol's verdict is in `~/work/briefs-1003/ivH2/iv-H2-verdict.md`. Sol's three probes are adopted in `convex/batches.iv2.test.ts`. The history probe now reads every path, and the MCP check runs over stdio and hosted /mcp instead of the removed `RemoldClient`. Before: `round4-fail-before.txt` (2 failed: history leak, item impact `[1, 0]`). After: `round4-pass-after.txt`, `round4-after.txt`.

**Merge gate first:** `origin/integ/campaigns` at 3b9f8a8 was merged as **99663c7**.
- **Conflicts:**
  - `inventory.json`: integ's file plus my rows script, giving 327 unique rows with every row from both sides.
  - `api.d.ts`: both `batches` and `blueprints`.
  - `agentApi.ts` imports: union of both sides.
  - `Suggestions.tsx`: batch cards plus integ's blueprint cards.
  - MCP `client.ts`, `index.ts`: integ's versions; `RemoldClient` is gone.
- **Batch tools in the shared registry** (`packages/mcp/src/tools.ts`, served by both stdio and hosted /mcp):
  - `remold_propose_batch` posts `/batches`; `remold_apply_batch` posts `/batches` with `direct: true`; `remold_batch_status` gets `/batches/<id>` with `cursor` and `limit`. The batch shapes take `idempotencyKey`, which `callTool` turns into the header.
  - `links` is on the single-change schema, so `remold_propose_change` and `remold_apply_change` accept link deltas.
  - The instructions and both batch tool descriptions tell agents to list referrers first when deleting.
  - Blueprint tools are untouched.
- **Tests on the shared helpers:**
  - `packages/mcp/src/client.test.ts` (`httpSend` + `callTool`): exact routes, bodies, the Idempotency-Key header and `direct: true`; link deltas on single changes; malformed batches refused before any request; the tools are listed with the referrer-first text.
  - `convex/batches.test.ts` "MCP batches": one end-to-end test runs over stdio (`mcpTool`) and hosted `/mcp` (JSON-RPC `tools/call`). It proposes, applies directly, replays the key, pages status and checks per-item validation.

1. **Batch reasons in history (blocker).** The batch-wide rule now lives in `convex/authority/reads.ts`: `readableEverywhere` and `batchReason` (`batches.reasonFor` is the same function). `projectEvent` finds an event's batch through `batchItems.by_event` and shows its reason only under that rule; otherwise the reason is withheld (`undefined`), as for restricted single events. Every history path projects there: `events.forRecord`, `timeline`, `forOrg`, REST `/records/<id>` and `/records/<id>/events`, and MCP `remold_record_events` over both transports. All are asserted in the adopted repro. The owner still sees the reason, and the batch id stays on the events.
2. **Scan-phase impact.** Entering an item in the items phase no longer resets its count to 0; it sets 0 only if nothing was counted yet. Retry clears every item's count first, so Retry twice still gives batch 1, item 1, with no double counting (tested).

**Correction to round 3.** "At most 400 units per step" was too broad. `BUDGET` bounds the index reads of the items phase; every query costs at least one unit, and moving to the next item costs one. A scan-phase step reads up to 501 source rows plus one batch-item lookup per row. Object and field metadata is read outside the budget. All paths are bounded, but not by 400.

**Mutants:** 3 new, 3 caught (history raw reason, items phase erasing scan counts, Retry keeping old item counts). The runner now includes both `batches.iv*.test.ts` files.

**Suites (final code, `round4-after.txt`):**

| Suite | Result |
|---|---|
| `pnpm test` | **733/733** with `--testTimeout=60000 --maxWorkers=2`. At default parallelism, 731/733: gmailSync (5s limit) and the Calendar paging test (15s limit) timed out, as in earlier rounds. |
| `pnpm typecheck` | clean |
| `pnpm test:authority` | 101/101 |
| `pnpm verify:release` | 37/37 |
| `pnpm build` | ok |
| `pnpm --dir packages/mcp test` | 17/17 |
| `pnpm --dir packages/mcp build` | ok (tsc clean) |

**Not redone this round:** SERVICE runs (scale, rollback, screenshots). This round's changes are a read-side projection, a count bookkeeping fix and MCP registration, with no schema change.
