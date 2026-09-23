**Astra second-pass verification: REVISE**

Reviewed commit `a945fe06011ea44149f1552bcfe3f673dae5c70c`, confirmed with git log -1 on 2026-09-23. Compared with first-pass commit `3038e586687fb8fec0092af352a195c79ccbef6a`.

Source remained read-only; no fixes, commits, checkouts or deployments. Fresh reproductions used disposable convex-test databases loaded through Vite. To establish the deletion regression, I loaded the previous applyChange source from git show through an in-memory loader, then ran the same scenario against the current implementation. No repository files were changed. The local decision log remains absent.

**Required checks**

| Command | Exit | Result |
|---|---:|---|
| pnpm typecheck | 0 | PASS; no diagnostics |
| pnpm test | 0 | **46 passed, 0 failed; 19 files passed** |
| pnpm --filter @remold/mcp test | 0 | **2 passed, 0 failed; 1 file passed** |

**48 passing tests total**, up from 42 in the first pass. MCP source was unchanged; I did not repeat the prior build/stdio check.

**Re-check of all six original blockers**

| Original blocker | Result | Deciding source and fresh evidence |
|---|---|---|
| 1. Body keyHash overrides header | **PASS: fixed** | [convex/http.ts:22](/private/tmp/remold-astra-1/clone/convex/http.ts:22)–23 now spreads authenticated keyHash last. One shared database: header A plus body hash B returned 201, added one inbox item to **A**, added none to **B**, and attributed it to A. Unknown header plus valid B hash returned **401**. |
| 2. Required fields not checked at proposal time | **PASS: fixed for the reported cases** | [convex/agentApi.ts:78](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:78) checks all required fields on create and touched required fields on update. Missing company name and name:null update each returned **400**, fieldKey **name**, with all five observed tables unchanged. |
| 3. Impossible dates silently normalize | **PASS: reported calendar-date bug fixed** | [convex/lib/values.ts:36](/private/tmp/remold-astra-1/clone/convex/lib/values.ts:36) round-trips calendar components. Task dueDate **2026-02-31** returned **400**, fieldKey **dueDate**, with all five tables unchanged. Previously it returned 201 and March 3. |
| 4. Deleting a target leaves canonical links | **FAIL: normal case fixed, retired-field regression introduced** | [convex/lib/applyChange.ts:71](/private/tmp/remold-astra-1/clone/convex/lib/applyChange.ts:71)–76 clears active inbound links through attributed updates. Normal blockedBy became [], with an update event and reason “Linked Blocker was deleted.” A retired inbound links field makes deletion fail at line 89; reproduction below. |
| 5. Suggestion serialization loses nulls/readable values | **PASS: fixed for exercised cases** | [convex/lib/values.ts:70](/private/tmp/remold-astra-1/clone/convex/lib/values.ts:70); [convex/agentApi.ts:39](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:39)–40. Proposed date and lookup clears remained explicit nulls; before contained a readable date and expanded lookup. Date conflicts returned readable expected/actual dates. |
| 6. Required safety regression coverage | **FAIL: substantially improved, not fully closed** | [convex/agentSafety.test.ts:5](/private/tmp/remold-astra-1/clone/convex/agentSafety.test.ts:5) shares one database. Lines 18–55 exercise identity, denial, conflicts and repeated application; 58–100 cover validation, serialization, inbox completion and ordinary link cleanup. Two previously identified frozen-contract cases remain absent: cross-org person applying a suggestion, and explicit inbox resolve with suggestionId. Both passed fresh local probes, but have no committed regression test. |

The “five tables” snapshots above include **records, events, suggestions, agentInbox and links**.

**Fresh local evidence**

| Scenario | Observed |
|---|---|
| Forged body hash with header A | 201; A inbox count 1; B count 0; actor A |
| Unknown header with active body hash | 401 |
| No-grant update with invalid city:number | 403 before value validation; five tables unchanged |
| Create missing required name | 400 VALIDATION, fieldKey name; five tables unchanged |
| Update clearing required name | 400 VALIDATION, fieldKey name; five tables unchanged |
| Impossible date | 400 VALIDATION, fieldKey dueDate; five tables unchanged |
| Clear date and lookup | 201; values exactly {about:null, dueDate:null} |
| Readable before | dueDate “2026-10-01”; about expanded to {id, ref, title} |
| Date changed by person before apply | conflicted; records/events unchanged; expected “2026-10-01”, actual “2026-10-03” |
| Create suggestion applied twice | applied, then already; record delta +1; event delta +1; second apply leaves five tables unchanged |
| Apply suggestion associated with inbox | Inbox resolved and linked to that suggestion |
| Delete ordinary links target | Canonical links []; attributed update with deletion reason |
| Cross-org person applies foreign suggestion | NOT_FOUND; five tables unchanged |
| Explicit POST /inbox/{id}/resolve with suggestionId | 200; resolved; correct suggestion link; pending queue empty |

The last two checks establish current behaviour, not durable repository coverage.

**New regression: retiring a links field prevents deletion of its target**

Reproduction, entirely local:

1. Create task Target.
2. Create task Source with blockedBy=[Target].
3. Retire task.blockedBy using fields.retire, an allowed admin operation.
4. Delete Target with records.remove.

| Same scenario | Previous applyChange | Current applyChange |
|---|---|---|
| Target deletion | Succeeded | **Failed** |
| Error | None | VALIDATION: “Unknown or retired field” |
| Target remains | No | **Yes** |
| Current-version failed call changed records/events/suggestions/inbox/links | — | No; transaction rolled back |

The old implementation still had the previously reported dangling-value defect; this comparison only establishes that deletion itself newly fails.

Cause: [convex/lib/applyChange.ts:76](/private/tmp/remold-astra-1/clone/convex/lib/applyChange.ts:76) routes cleanup through applyChange with clearingReference:true. [convex/lib/applyChange.ts:89](/private/tmp/remold-astra-1/clone/convex/lib/applyChange.ts:89) rejects retired fields without considering that internal cleanup flag. Since retirement preserves field metadata and stored links, retiring a relationship makes its existing targets undeletable through this path.

Smallest fix: allow known retired fields specifically during trusted internal reference cleanup, while preserving rejection for ordinary user/agent edits; retain canonical/index cleanup and attributed events. Add the retire-then-delete regression alongside [convex/agentSafety.test.ts:91](/private/tmp/remold-astra-1/clone/convex/agentSafety.test.ts:91).

**Remaining coverage gap**

Frozen requirements remain at [docs/spec/agents-v1.md:220](/private/tmp/remold-astra-1/clone/docs/spec/agents-v1.md:220)–221:

- A member of another org applies a foreign suggestion: NOT_FOUND and no writes.
- Explicit POST /inbox/{id}/resolve with suggestionId stores the link and removes the item from the pending queue.

[convex/suggestions.test.ts:5](/private/tmp/remold-astra-1/clone/convex/suggestions.test.ts:5) and [convex/agentSafety.test.ts:34](/private/tmp/remold-astra-1/clone/convex/agentSafety.test.ts:34) apply only within the same org. [convex/inbox.test.ts:11](/private/tmp/remold-astra-1/clone/convex/inbox.test.ts:11) resolves with note only. The new auto-resolution test at [convex/agentSafety.test.ts:80](/private/tmp/remold-astra-1/clone/convex/agentSafety.test.ts:80) exercises a different path from explicit inboxResolve.

The new tests are meaningful: reverting the HTTP spread would fail the A/B inbox assertions at lines 28–31; removing required-field rejection would fail line 62. I did not independently run the builder's claimed “four of six red on old code” test-suite experiment. My before/after evidence comes from the first pass and the fresh reproductions described here.

**Optional fixes checked**

- **PASS:** Grant precedence moved before value resolution at [convex/agentApi.ts:83](/private/tmp/remold-astra-1/clone/convex/agentApi.ts:83). Fresh invalid-value/no-grant request returned 403 with no writes.
- **PASS:** Plain keys stay in the action. [convex/agents.ts:21](/private/tmp/remold-astra-1/clone/convex/agents.ts:21)–23 separates key from stored arguments; the internal mutation at line 31 accepts only hash/prefix and returns an agent ID. createAs follows the same pattern.
- **PASS for the requested text change:** [src/components/AgentsCard.tsx:76](/private/tmp/remold-astra-1/clone/src/components/AgentsCard.tsx:76) now shows a node command instead of npx. It still contains a placeholder path that users must replace; I did not execute that displayed string.
- Other optional items from pass one were not reclassified as fixed by this review.

**Live probes**

Base: https://gallant-pika-581.convex.site/api/v1.

I first confirmed org **kh74gfj79fms7mk2x7w3fx56ts8ewy52**, agent **astra-verifier**, role **member**, grants **[]**.

Every HTTP status observed in this pass:

| # | Request | Status |
|---:|---|---:|
| 1 | GET /me | 200 |
| 2 | GET /records/brisk-ember-oyster, baseline | 200 |
| 3 | POST /changes, city=X, reason “astra probe” | 403 |
| 4 | GET /records/brisk-ember-oyster, after denial | 200 |
| 5 | GET /me, after denial | 200 |
| 6 | POST /suggestions, city=X, reason “Astra pass 2; please dismiss” | 201 |
| 7 | GET /records/brisk-ember-oyster, after proposal | 200 |
| 8 | GET /me, after proposal | 200 |
| 9 | GET /me, malformed key | 401 |

| Evidence | Before | After denied change | After suggestion |
|---|---|---|---|
| city | Fabletown | Fabletown | Fabletown |
| updatedAt | 1790099147010 | Same | Same |
| Returned events | 4 | Same 4, deep-equal | Same 4, deep-equal |
| Entire record/event response | Baseline | Deep-equal | Deep-equal |
| pendingSuggestions | 2 | 2 | 3 |

The authorized live suggestion remains pending: **kx783f4f1bnx0rbmbnm4g2hvyh8ezp4f**, reason **“Astra pass 2; please dismiss”**. I did not apply or dismiss it.

These live statuses match the expected behaviour. They do not certify which source commit is deployed or prove the hash-substitution fix live; that exploit was tested only in the local shared database. No new live probes beyond the requested flows and their before/after reads were performed.

Independent checker: **Astra, this session**. No source changes or deployments. The deletion regression remains unfixed.

**VERDICT: REVISE**

1. **Deletion regression — [convex/lib/applyChange.ts:76](/private/tmp/remold-astra-1/clone/convex/lib/applyChange.ts:76) and [convex/lib/applyChange.ts:89](/private/tmp/remold-astra-1/clone/convex/lib/applyChange.ts:89).** A target referenced through a retired links field cannot be deleted. Proven to succeed under the previous deletion implementation and fail under the current one. Permit trusted cleanup of known retired fields while retaining ordinary-write validation, and add a retire-then-delete behaviour test.
2. **Remaining required regression coverage — [convex/suggestions.test.ts:5](/private/tmp/remold-astra-1/clone/convex/suggestions.test.ts:5), [convex/inbox.test.ts:11](/private/tmp/remold-astra-1/clone/convex/inbox.test.ts:11), [convex/agentSafety.test.ts:80](/private/tmp/remold-astra-1/clone/convex/agentSafety.test.ts:80).** The frozen cross-org person-apply and explicit inbox-resolve-with-suggestionId cases are still absent. Current behaviour passed my local probes; add those two durable assertions, using one database and before/after snapshots for the denied apply.

