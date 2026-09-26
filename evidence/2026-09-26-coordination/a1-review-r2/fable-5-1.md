**Verdict: REVISE.** Every r1 finding from both reviewers is addressed in r2, but three of the fixes contradict each other or the code they reuse, and one case cannot fail. I could not compute the file hash, since this session has no shell. The findings below are against the file as read, and I would not sign a hash I have not checked.

Also a count note: the review table has 23 rows, not 14. That is fine, but the cover text should match.

1. **MEDIUM. Renamed-key approval contradicts immutable ops.** The no-oracle section lets the admin approve with a renamed key, but the shapes say ops are immutable and the admin must send the stored hash. There is no path for a rename. It also does not close the oracle: an applied field under a new key tells the agent its key was taken. Fix: cut the rename sentence. "Closed" already covers both dismissal and failure, which is enough.

2. **MEDIUM. What happens when apply fails is undefined.** S3 says a key clash means "agent sees closed", and the no-oracle section says a failed precondition looks like closed. But a Convex mutation that refuses rolls back, so the proposal stays pending. Fix: state that a failed precondition throws, nothing changes, the card shows the reason to the admin, and the admin dismisses. Reword S3, S13 and the no-oracle bullet to "stays pending until dismissed; agent sees pending then closed".

3. **MEDIUM. Slot refusal does not match the human path it reuses.** On I1, when no slot is free, `fields.create` inserts the field with no slot instead of refusing (`allocateSlot` returns undefined and the insert proceeds). If apply runs the same internal, S21 fails as written. An unindexed lookup also breaks the related endpoint. Fix: the shared internal refuses with the slot message on both paths, and the draft says so as a deliberate human-path change.

4. **MEDIUM. Missing attack: retiring a seeded standard field.** The today feed finds task due date, task done and opportunity stage by key, and the won-to-delivery handoff reads standard fields. Retire currently refuses only the title field. An agent proposal plus a quick approve silently empties the feed. Fix: refuse `field.retire` on seeded fields of standard objects on both paths. Add S22: propose retiring opportunity stage, refused at shape time.

5. **MEDIUM. Object proposals are nearly useless as written.** A new object arrives with only its Name field, the proposer gets no grant on it, and field ops need an ids scope on an object that does not exist yet. The agent can never propose the object it actually wants in one card. Fix: under the `'new'` scope, allow `field.create` ops that reference an `object.create` op in the same proposal. Keep refusing relation targets to it. S10 still holds after apply.

6. **LOW. The ops hash is redundant and S4c cannot fail.** Ops are immutable after insert and no mutation patches them, so the hash check has nothing to catch. A case that can never fail proves nothing. Fix: cut `opsHash` and S4c. Keep immutability and replace S4c with a check that no function patches `ops`.

7. **LOW. The two caps live nowhere.** The scope shape has no cap fields, so "missing number means zero" has no place to be missing from. Fix: add `maxOps` and `maxOpen` to the setup scope, validated in `issue()` as safe integers above zero, and treat the recommended 10 and 3 as grants UI defaults. This is the same pattern as the bindings scope.

8. **LOW. Setup event shape is thin.** There is no object or field column, so masking has to parse the meta blob, and the actor is not stated. Fix: add `objectId` and optional `fieldId` with a by-object index. State that the actor is the approving admin and `proposalId` reaches the agent.

9. **LOW. addOptions precondition is missing.** If a person adds the same option id between propose and apply, the merge duplicates it. Fix: add "new option ids absent" to the re-checked preconditions.

10. **LOW. Rollback claim is unverified.** "Rolling back to I1 leaves the two new tables unread" assumes Convex accepts a deploy whose schema omits tables that hold rows. I could not check this read-only. Fix: confirm on a dev deployment before this ships as the rollback target, and record the result.

11. **Decisions are right.** Propose-only with owner-only grant matches AGENTS.md. Ten ops per proposal and three open per agent are the right knobs, once they live on the grant per finding 7.

**r1 resolution:** all 15 of my findings and all 15 of the Opus 5.5 findings are taken. Three of the fixes introduced the problems above: rename (1), slot refusal (3) and the hash (6). Nothing else new appeared.