VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, the independent verifier for C-m6-r3. Reviewed `m6/lead-intake` at `ca29e145fb3fe0eeb1a75e11f5ffde9ac1585f39` against `origin/build/unified-remold-2026-09-24`, VERIFY.md, the brief, project rules and builder handover. Evidence is **SIM and static inspection**, not SERVICE/LIVE certification.

**Must-fix defects**

1. **P2 — `/changes` replay returns later record contents instead of the original result.** [convex/agentApi.ts:113](/home/old-mac-pro/work/verify/C-m6-r3/convex/agentApi.ts:113) loads the current record; line 115 returns it alongside the original event ID. Line 117 stores only a marker, losing the original response.

   Independent reproduction, with permissions unchanged throughout:

   - POST `/api/v1/changes`, `Idempotency-Key: original`, body `{"action":"create","object":"company","values":{"name":"Original Company"},"reason":"intake"}` → **200**, name/title `Original Company`.
   - The owner updates that Company's name to `Later Human Edit` through `api.records.update`.
   - Repeat the identical POST/key → **200**, name/title **`Later Human Edit`**, later `updatedAt`, but the **original event ID**.

   Expected: the original successful result, subject to current authorization and redaction. No duplicate write occurs, but this violates build item 1 and ADR 002's original-result contract. The supplied replay test passes because it never changes the record between requests.

   **Suggested fix:** retain an immutable representation of the original result and project it through current record/field permissions on replay. Preserve revoked-read refusal and hidden-field masking; never return an unfiltered cached snapshot. Add the intervening-edit regression and retain the existing permission regressions.

   Evidence: [independent probe source](/tmp/verify-C-m6-r3/probe-source.txt:8), [reproduction and response diff](/tmp/verify-C-m6-r3/probes-final.log). Reproduced twice on unchanged implementation.

**Should-fix**

- Promote the independent cross-workspace, final-Note-failure/retry and concurrent-`/changes` probes into regression tests. These pass now but cover useful cases absent from the supplied intake suite.

**What I verified and how**

Both round-three changes work: crowded Company matching reuses the exact normalized title, and the new revoked-intake-grant replay test catches removal of the upfront grant check. Earlier normalization, replay permission and UTC-cap regressions also pass.

Ran every required command myself. Logs are in `/tmp/verify-C-m6-r3/`:

| Command | Result / summary |
|---|---|
| `pnpm install --frozen-lockfile` | Exit 0; `Already up to date` |
| `pnpm typecheck` | Exit 0; `tsc -b && tsc --noEmit -p convex` |
| `pnpm test` | **27 files, 121 tests passed** |
| `pnpm test:authority` | **17 files, 97 tests passed** |
| `pnpm verify:release` | **19 passed, 0 failed** |
| `pnpm build` | Exit 0; built successfully; chunk-size warning |

No timeout flakes occurred. Commands used `TMPDIR=/tmp/verify-C-m6-r3`; build used the synthetic `VITE_CONVEX_URL=https://release-fixture.invalid`.

Every Done-when behavior has a supplied test in `convex/intake.test.ts`:

| Requirement | Test line / evidence |
|---|---|
| Same lead/key gives one Person and Opportunity | 107; also checks stage, links, Note, source/campaign and attributed events |
| Concurrent identical intake calls give one | 134; `Promise.all`, SIM |
| Same key/different body refused | 33, 142; 422 and unchanged CRM counts |
| Email case/spacing reaches the same Person | 160, 167; existing phone formatting at 179 |
| Midway failure leaves no partial records | 236; records, events and idempotency remain unchanged |
| Intake key cannot read or use `/changes` | 250; normal-key refusal/explicit grants at 262 |
| Burst hits limit | 309; 429, unchanged CRM counts, operator notice; email/day tests at 326, 336, 349 |
| Removing idempotency makes tests fail | Independently demonstrated: eight failures |
| Full suites and exact website contract | Results above; handover includes placeholder-key curl, payload, statuses and retry guidance |

Final scratch run: **27 supplied tests passed; 10 independent probes passed; one independent probe failed** on the must-fix above. Command: `pnpm --config.verifyDepsBeforeRun=never exec vitest run convex/independent.test.ts convex/intake.test.ts --maxWorkers=2 --testTimeout=15000`.

Passing independent probes covered workspace isolation of matching/idempotency/caps; rollback after final Note validation failure and successful same-key retry; rejection of injected targets/fields; canonical JSON ordering, mismatch and malformed keys; daily cap shared across keys; revoked key/grant refusal; zero/malformed caps; additional denied read surfaces; crowded normalized Company matching; and concurrent `/changes` deduplication. An initial probe setup used an invalid custom-field key; I corrected that scratch fixture before the final run.

Reviewed the 19-file diff, Settings wiring, authority checks and request contract. No added embedded credential was found. Schema changes are additive and byte-identical to rollback target `0398a6addeb8ebba1787f599f3eedc9b0d65a59b`. `git diff --check` passed. [Integrity evidence](/tmp/verify-C-m6-r3/integrity.txt).

**Mutations caught / survived**

Each mutation was applied separately in scratch, tested against all 27 supplied intake tests, then restored. Command: `pnpm --config.verifyDepsBeforeRun=never exec vitest run convex/intake.test.ts --maxWorkers=2 --testTimeout=15000`.

| Mutation | Failing tests |
|---|---:|
| Disable idempotency replay | 8 |
| Remove payload mismatch check | 2 |
| Remove intake-purpose gate | 1 |
| Remove upfront intake-grant check | 1 |
| Disable abuse limits | 4 |
| Compare raw stored email | 1 |
| Compare raw stored phone | 1 |
| Remove UTC window anchor | 1 |
| Overwrite existing Person fields | 3 |
| Make Company lookup always miss | 2 |
| Omit Note creation | 3 |
| Clear hidden-field masks on replay | 1 |

**All 12 caught; none survived.** [Mutation summary](/tmp/verify-C-m6-r3/mutation-summary.txt). Restored implementation bytes matched the checkout before the final test run and cleanup.

**What I could not verify**

- Actual Convex OCC interleaving: concurrent SIM calls may serialize in convex-test.
- Deployed rollback, authenticated Settings interaction, or operator alert delivery. Static wiring, schema comparison and queued notices provide narrower evidence.
- The separate website's email-first ordering, outage isolation, secret installation and retries.

No production/hosted-service calls, deployments, real email, project commits or tracked-file edits were performed. Scratch test/copy files were deleted after preserving sources and logs as text. The checkout remains clean. Verdict saved at `/tmp/verify-C-m6-r3/verdict.md`.