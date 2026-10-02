VERDICT: PASS

I am Claude Fable 5.1 (claude-fable-5-1), the independent verifier for C-m6-r4. I did not build this job. I reviewed `m6/lead-intake` at `5d5cfe96a75eecc0cc47406461d17e52c184325c` against `origin/build/unified-remold-2026-09-24`, VERIFY.md, the job brief, AGENTS.md, the builder handover and the three earlier verdicts. Evidence is **SIM** (convex-test) plus **SERVICE** (isolated local Convex backend, synthetic JWT). Nothing here is LIVE.

No must-fix defect found. The round-3 must-fix is fixed: a `/changes` replay now returns the original record values, not a later human edit, and is still re-authorized. One narrow residue of that same rule remains (should-fix 1); I rate it below must-fix and explain why there.

## Must-fix defects

None.

## Should-fix

1. **Replay re-reads the titles of linked records, so it is not always the original response.** `convex/agentApi.ts:123` passes the stored values through `readable()`, and `convex/lib/values.ts:65` builds each lookup as `{id, ref, title}` from the target's current state. Two reproductions on unchanged code (`lookup-probe.log`):
   - **Renamed target (the builder disclosed this one).** Create a Person with `company: <id of "Original Target">` and key `l1`; a human renames the company to "Later Target"; replay. Original: `"title":"Original Target"`. Replay: `"title":"Later Target"`.
   - **Title hidden at write time, readable later (not disclosed).** Same request with the company name masked for the agent: original `"title":""`. Unmask, replay: `"title":"Original Target"`. The handover's sentence "Fields that were not in the original response cannot appear, because they were never stored" is too broad.
   - **Why not must-fix:** no second write happens, the lookup id is the original, the record's own field values are the original, and the replay shows only what the key may read today through GET anyway. The intake replay is unaffected (it returns only `{id, ref}`). If the coordinator reads the round-4 rule ("never include a field that was not in the original response") as covering embedded titles, treat this as a REVISE item.
   - **Suggested fix:** store the original API-shaped response; on replay drop fields no longer readable, keep an original lookup title only while its target is still readable, and never upgrade a title that was masked originally. Add both cases as regressions.

2. **A website visitor can write onto an existing Person.** `convex/lib/intake.ts:122` fills empty `email`, `phone` and `company` on a match. Probe: existing Person "Victim" with phone `(410) 555-0100` and no email; lead `{name:"Mallory", email:"mallory@evil.example", phone:"4105550100"}` returns 201 and Victim's email is now `mallory@evil.example`. This follows the brief's phone fallback and the builder's disclosed decision 7, and the write is an attributed, reversible event. It is still public input landing on a contact record. Suggest Shakur decide: keep it, or on a phone-only match leave the Person untouched and rely on the Note's `Submitted:` line.

3. **Test gaps shown by surviving mutants.**
   - Copying the phone onto the email-matched Person during a conflict (`phone: conflict ? undefined : phone` → `phone`) passes all 33 supplied tests. Handover decision 8 is untested; assert that the email-matched Person's phone stays empty.
   - Treating an unreadable `REMOLD_INTAKE_DAILY_CAP` as 50 instead of 0 passes all supplied tests. Add `"abc"`, `"-1"`, `"1.5"`, `"0"` cases (my probe covers them and catches it).
   - Removing the field-grant check inside `applyChange({writeOnly})` (`convex/lib/applyChange.ts:87`) passes everything, because the up-front check in `submitLead` masks it. Behaviour is still refused today; the inner check has no test of its own.

4. **The key window is not documented in the repo's API reference.** `docs/spec/agents-v1.md:192` still lists `POST /api/v1/changes` without `Idempotency-Key`, the 422, the 24-hour window or the intake route. The window appears only in a code comment (`convex/lib/idempotency.ts:10`) and in the handover, which lives outside the repo.

5. **Handover inaccuracies.**
   - The header still says "Final commit: `0d9da8d`"; the real one is `5d5cfe9`. Decisions 4, 6 and 10 are superseded by later rounds.
   - The contract table omits 404 (intake returns it when a needed object or field is missing or retired). The website should treat it like 400: do not retry.
   - The rollback section says the key is inert under rollback code. On a real rollback I saw it can still `POST /api/v1/inbox` (201, an agent inbox item) and read `/api/v1/me` (agent and workspace name). No record data, no record writes.

6. **Only limit trips alert the operator.** A 403 (a grant expired or was revoked), a 400 (someone added a required field) or a 404 drops every lead silently on the Remold side; only the website's logs show it. The brief asks for alerts on limits only, so this is a suggestion.

7. **Lower-priority notes.**
   - Each lead scans every Person and, when a company is given, every Company (`convex/lib/intake.ts:58-74`). The builder disclosed this; it will hit Convex read limits at tens of thousands of records.
   - The conflict Note embeds the other Person's name and ref (`convex/lib/intake.ts:129`), visible to anyone who can read notes.
   - Expired `idempotencyKeys` rows, which hold record values for `/changes`, are swept only by later keyed writes (`convex/lib/idempotency.ts:29`). In a quiet workspace they outlive 24 hours, though they are never replayed after expiry.
   - AGENTS.md says a missing numeric cap means zero; the brief says default 50. The builder followed the brief and said so. Flagging it for Shakur's awareness.
   - Not from this job: with 20 parallel `/changes` calls on one key, one returned 500 from the existing `rateLimit:take` limiter (OCC retries exhausted). No duplicate write. Intake does not use that limiter and did not 500 at 25 parallel.

## What I verified and how

All required commands, run by me in the checkout, first attempt, no timeout flakes (logs in `/tmp/verify-C-m6-r4/`):

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0, "Already up to date" |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | Test Files 27 passed (27), Tests 127 passed (127) |
| `pnpm test:authority` | Test Files 17 passed (17), Tests 97 passed (97) |
| `pnpm verify:release` | tests 19, pass 19, fail 0 |
| `pnpm build` | exit 0 (chunk-size warning; `VITE_CONVEX_URL=https://release-fixture.invalid`) |

Done-when items, each with a supplied test in `convex/intake.test.ts` that goes red under mutation:

| Done-when | Supplied test (line) | Mutant that turns it red |
|---|---|---|
| Same lead twice, one Person + one Opportunity | 157 | 01, 11 |
| Two concurrent identical calls give one | 184 (SIM), plus my SERVICE run below | 01, 11 |
| Same key, different body refused | 33, 192 | 02, 31 |
| `Shakur@X.com ` and `shakur@x.com` reach one Person | 210, 217 | 05 |
| Failure mid-way leaves nothing | 299, 312 | not mutated; also confirmed by my probe P11 |
| Intake key cannot read | 326 | 06 |
| A burst hits the limit | 385, 402, 412, 425 | 07, 14, 15, 17 |
| Removing the idempotency check fails a test | — | 01: 12 supplied tests fail |
| Contract with placeholder-key curl in handover | present | — |

**SERVICE: real concurrency (this was unproven in rounds 1–3).** Isolated local backend, real HTTP, `service-occ.log`:
- 20 parallel identical intake calls, one key: all 201, one opportunity id, counts person 1 / company 1 / opportunity 1 / note 1 / events 4 / idempotency rows 1.
- 8 parallel leads with different keys for the same new person and company: 3 × 201 and 5 × 429 (per-email limit), exactly one new Person and one new Company.
- Same key with two different bodies in parallel: one 201, one 422, one opportunity.
- 20 parallel identical `/changes`: one company written (19 × 200 with the same id, 1 × 500 from the pre-existing limiter noted above).
- 25 parallel leads over the per-key limit: records written equal the number of 201s; the rest 429.
- Intake key gets 403 on `GET records`, `/me`, `/search`, `POST /changes`, `/suggestions`; a normal key gets 403 on intake.

**SERVICE: rollback to `0398a6a`** (`service-rollback.log`). After landing leads and tripping a limit on HEAD, I swapped the backend's functions to the rollback target:
- It loaded with no schema validation error and every count was unchanged.
- The intake route returned 404.
- The intake key got 404 on every record read and on `/changes` and `/suggestions`; `/search`, `/objects`, `/today` and `/inbox` returned empty lists. No record data leaked and no record was written (see should-fix 5 for the inbox item).
- Rolling forward again, the original key replayed to the same opportunity id.
- `convex/schema.ts` is byte-identical between `0398a6a` and HEAD.

**SERVICE: readonly sweep** (`I1_ONLY='Readonly workspace' node ops/authority/service.mjs`): PASS; intake route 403, `agents:createIntake` refused.

**SIM: 14 independent probes, all pass** (`probe-source.txt`, `probes.log`):
- A body cannot inject `idempotency` or `keyHash`.
- The intake key is refused on 14 other routes with no record data in any response.
- A 429 is not remembered and the same key lands once later.
- Caps of `abc`, `-1`, `0`, `1.5`, `1e400` refuse everything and write nothing; an empty value means 50.
- Two intake keys share the daily cap but not keys.
- A revoked key gets 401 on new and replayed leads.
- Malformed keys get 400; JSON key order does not matter.
- Extra or targeting fields (`stage`, `orgId`, `person`) and bad values get 400 with nothing written.
- An email match never overwrites phone, company, email or name, and all events are attributed to the intake agent.
- A replayed delete returns the same result; reusing a `/changes` key on intake is refused.
- 15 failed leads consume no limit.
- Expired rows are swept.
- A title hidden after the write is blanked on replay.

Also checked: all 19 changed files read; `git diff --check` clean; no credentials in the diff; cross-workspace scoping of matching, keys and limits (supplied test plus mutant 04); `createIntake` is owner-only; checkout is clean at `5d5cfe9`, nothing committed or edited.

## Mutations

33 mutants, each applied alone in a scratch copy, run against the 33 supplied tests and my 14 probes, then restored (`mutation-summary.txt`, `mutlogs/`).

**Caught by the supplied suite (27):** replay disabled (12 tests fail); hash mismatch check removed; expiry ignored; key not scoped to the agent; email normalization removed; purpose gate removed; all limits removed; per-email limit removed; daily cap removed; per-key limit removed; operator alert removed; overwrite Person fields; up-front grant check removed; intake result not remembered; phone beats email; source missing from Note; key not required; phone fallback removed; `/changes` result not remembered; replay reads current values; replay read check removed; store all values; company match case-sensitive; Opportunity not linked to Person; stage not "new"; request hash ignores body; UTC anchor removed.

**Survived the supplied suite (6):**

| Mutant | Meaning |
|---|---|
| 13 conflict copies phone onto the email match | Real gap (should-fix 3) |
| 30 unreadable cap becomes 50 | Real gap; caught by my probe P4 (should-fix 3) |
| 10 `writeOnly` skips the field-grant check | Masked by the up-front check (should-fix 3) |
| 33 `writeOnly` accepts legacy grants | Same masking |
| 28 `grantIntake` asks for admin, not owner | Redundant: `issue()` still refuses a non-owner |
| 29 `submitLead` skips the read-only check | Redundant: `applyChange` still refuses |

## What I could not verify

- The Settings UI in a real signed-in browser. I read the component and the build passes; the builder's screenshots come from a mock harness.
- Delivery of an intake-limit notice to the operator webhook. I saw the notice row queued (SIM and SERVICE), not sent.
- A hosted Convex deployment, production rollback, or anything LIVE.
- The website side (separate repo): email-first ordering, the secret, timeout and retries, and "Remold down, email still arrives".
- `pnpm proof:authority` beyond the readonly sweep.

Housekeeping: `/tmp/verify-C-m6-r4/probes-confirm.log` and `probes-final.log` were already in the scratch folder before my first command (timestamps 02:13–02:14; my run started 02:15). They are not my evidence. The first one pointed at the lookup-title behaviour; I reproduced it myself before reporting it (`lookup-probe.log`). Scratch copies and local backends are removed; sources and logs are kept as text. No production or hosted calls, no deploys, no email, no commits, no tracked-file edits.

Verdict saved at `/tmp/verify-C-m6-r4/verdict.md`.
