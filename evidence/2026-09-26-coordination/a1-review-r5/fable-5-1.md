All ten findings checked against r5 and the I1 worktree at 4cb4671. Writing the verdict now.

**Verdict: APPROVE.** All six of my r4 findings and all four of Opus's are resolved in r5, and I found nothing new that changes behavior. I could not compute the sha256 in this session, which has no shell. My approval is on the content I read at `docs/unified-launch/h0-amendment-agent-setup.html`, which the header identifies as draft r5 on base 4cb4671. That commit is still the tip of `wip/i1-authority` and the worktree at `../remold-i1` is checked out on it.

**Resolution check, Fable r4:**

1. Approving bullet now says "slot available for a lookup field". Resolved.
2. Event op union is `SetupOp['op'] | 'field.releaseSlot'`, FieldMeta carries `slot?: { kind, index }`, and the Slots bullet names the operator release as the one exception. Resolved. Matches the comment in `convex/lib/slots.ts:31`.
3. "Lookup field" in the Operations table and "a field that points at one related record (a lookup)" in Your calls. Resolved.
4. S21 now has the agent submitting two separate proposals. Resolved.
5. Review card simulates ops in order and marks a lookup that would get none as "approval will fail". Resolved.
6. Scope bullet adds "so only object.create and field.create by ref can appear". Resolved.

**Resolution check, Opus r4:** 1 and 2 are the same fixes as mine. 3: "open proposal" is defined once, in the Scope bullet, and the Proposing bullet, S5 and S26 all defer to it. 4: same as my finding 2. All resolved.

**Code cross-check.** Every named function exists with the claimed behavior: `kindFor` and `capacity` in slots.ts give 8/8/4/4 with links unslotted, `records.related` is the only reader that requires a slot and only for lookup, `releaseStandardSlots` and `ensureStandard` exist in seed.ts, `seedStandard` already adds an unslotted field when allocation returns nothing, `canPropose` has the legacy branch the Proposing bullet avoids, `unrestrictedHuman` gates object create, `applyChange` already refuses writes to retired fields (S8), and the operator actor kind is an existing pattern in the schema.

**One low note, not blocking:**

1. **LOW.** Your calls says "3 open proposals per agent", but the limit is per grant, and S26 tests that an agent with two grants has two independent limits. A builder or the owner reading the summary could take the wrong number. Fix: "3 open proposals per grant" and "You set them on each grant".

I did not append to the decisions log because this round is read-only.