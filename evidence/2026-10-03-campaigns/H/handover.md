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
