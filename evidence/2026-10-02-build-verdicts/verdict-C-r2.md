VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, the independent verifier for C-m6-r2. Reviewed `m6/lead-intake` at `b9bd7ac3080148b203a321b1c7fdee2b40427e22` against `origin/build/unified-remold-2026-09-24`, the job brief, project rules, and builder handover. Evidence is **SIM and static inspection**, not SERVICE/LIVE certification.

**Must-fix defects**

1. **P2 — Company find-or-create can mistake a truncated search for absence and create a duplicate.** [convex/lib/intake.ts:109](/home/old-mac-pro/work/verify/C-m6-r2/convex/lib/intake.ts:109) calls the inherited `findByTitle`, which takes only 20 search results before checking exact equality at [convex/lib/find.ts:11](/home/old-mac-pro/work/verify/C-m6-r2/convex/lib/find.ts:11). Independent reproduction: create Companies `Acme Branch 0` through `Acme Branch 24`, then `Acme`; submit a valid lead with `company: "Acme"`. Intake returns **201**, but Company count rises from **26 to 27**, linking the lead to a newly created duplicate. Expected: reuse the existing `Acme`, leaving 26 Companies. The supplied reuse test has only one candidate and misses this case.

   This counterexample is **SIM**: convex-test search ordering differs from native Convex relevance ranking, so I have not established that this exact dataset fails on a service. The implementation nevertheless treats “not among the first 20 search hits” as “does not exist,” without an exhaustive exact-match fallback. That does not establish the absence required for safe find-or-create.

   **Suggested fix:** use a workspace/object-scoped exact normalized-title lookup, or an exhaustive exact-match fallback before creating a Company. A scan is consistent with the current-scale Person implementation. Preserve stored titles and add the crowded-search regression. Replacing only this intake lookup in scratch with an exact scoped scan changed the independent probes from **1 failed / 8 passed** to **9 passed**; the scratch change was then restored.

   Evidence: [probe source](/tmp/verify-C-m6-r2/probe-source.txt), [unmodified result](/tmp/verify-C-m6-r2/probes.log), [scratch fix result](/tmp/verify-C-m6-r2/company-fix-check.log).

**Should-fix**

- Add the independent revoked-intake-grant replay regression to the supplied suite. Removing the upfront grant check at `convex/lib/intake.ts:91` leaves all **25 supplied tests passing**, but permits replay after a required grant is revoked. My additional test catches it: expected **403**, received **201**. Current code correctly refuses this request; this is a coverage gap, not an unfixed permission bypass. [Mutation evidence](/tmp/verify-C-m6-r2/mutant-no-grant-precheck-probe.log).

**What I verified and how**

All three round-one must-fixes and its alert should-fix are addressed: replay checks current read permissions and masks hidden fields; existing CRM email/phone values match after normalization without changing their stored formatting; the daily cap remains enforced until UTC midnight; alert keys identify the workspace without contact data. Tests passed and targeted mutations were caught.

Ran every required command myself:

| Command | Result / summary |
|---|---|
| `pnpm install --frozen-lockfile` | Exit 0; “Already up to date” |
| `pnpm typecheck` | Exit 0; `tsc -b && tsc --noEmit -p convex` |
| `pnpm test` | Initially **117 passed, 2 timed out** at the default 5 seconds |
| `pnpm test convex/alerts.test.ts` | Isolated rerun: **20 passed** |
| `pnpm test convex/rateLimit.test.ts` | Isolated rerun: **2 passed** |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | **27 files, 119 tests passed** |
| `pnpm test:authority` | **17 files, 97 tests passed** |
| `pnpm verify:release` | **19 passed, 0 failed** |
| `pnpm build` | Exit 0; built successfully; chunk-size warning |

The two initial timeout failures were `counts each failed run exactly once across page boundaries` and `limits writes per key without starving reads or other agents`. Both passed alone with their default timeout. Logs are under `/tmp/verify-C-m6-r2/`.

Every Done-when behavior has a supplied test in `convex/intake.test.ts`:

| Requirement | Test line / coverage |
|---|---|
| Same lead/key produces one Person and Opportunity | 107; also checks stage, links, Note, source/campaign and attributed events |
| Concurrent identical calls produce one | 134; `Promise.all`, SIM |
| Same key/different body refused | 33 and 142; 422, unchanged record/event counts |
| Email case/spacing reaches the same Person | 160; existing CRM formatting regressions at 167 and 179 |
| Midway failure leaves no partial records | 225; required Opportunity field fails after earlier writes; records/events/idempotency unchanged |
| Intake key cannot read or use `/changes` | 239; normal-key refusal and explicit authorization at 251 |
| Burst hits limit | 287; 429, no additional CRM writes, one alert; email/day coverage at 304, 314 and 327 |
| Removing idempotency makes tests fail | Independently reproduced: eight failures |
| Full suites; exact website contract | Results above; handover includes placeholder-key curl, payload, statuses and retry guidance |

Eight additional independent probes passed on unchanged code: cross-workspace isolation of matching/idempotency/caps; revoked intake-grant refusal on replay and new requests; rejection of caller-selected targets/extra write fields; rollback after final Note validation fails followed by a successful same-key retry; canonical JSON ordering and payload mismatch; zero/invalid cap refusal; separate keys in one workspace; and intake-key refusal on additional read/domain routes.

Reviewed all 19 changed files, Settings wiring, authority checks and the request contract. No added embedded credential was found. Schema changes are additive; `convex/schema.ts` is byte-identical to rollback target `0398a6addeb8ebba1787f599f3eedc9b0d65a59b`. `git diff --check` passed.

**Mutations caught / survived**

Each mutation was applied separately in a scratch copy, tested, and restored. Command: `pnpm --config.verifyDepsBeforeRun=never exec vitest run convex/intake.test.ts --maxWorkers=2 --testTimeout=15000`.

| Mutation | Supplied-suite result |
|---|---|
| `replay()` always returns null | **Caught: 8 failed** |
| Remove intake-purpose gate | **Caught: 1 failed** |
| Remove abuse limits | **Caught: 4 failed** |
| Compare raw stored email | **Caught: 1 failed** |
| Compare raw stored phone | **Caught: 1 failed** |
| Remove UTC window anchor | **Caught: 1 failed** |
| Overwrite existing Person fields | **Caught: 3 failed** |
| Remove explicit replay read check | **Caught: 1 failed**; status changes from 403 to downstream 404 |
| Clear field masks during replay | **Caught: 1 failed**; hidden-field regression |
| Remove workspace from alert key | **Caught: 2 failed** |
| Remove upfront intake-grant check | **Survived: 25 passed**; caught by the independent revoked-grant replay probe |

[Mutation summary](/tmp/verify-C-m6-r2/mutation-summary.txt); individual `mutant-*.log` files include the additional mask and independent-probe runs. After restoration, the implementation matched the checkout and all **25 intake tests passed** again.

**What I could not verify**

- Actual Convex OCC interleaving or native search ranking. Concurrent tests here can serialize in convex-test; the company reproduction is SIM only.
- Actual rollback deployment, authenticated Settings interaction, or operator alert delivery. Schema comparison, wiring, queued notices and local tests are narrower evidence.
- The separate website’s email-first ordering, outage isolation, secret installation and retries.

No production/hosted-service calls, deployments, real email, project commits or tracked-file edits were performed. Scratch tests/copy were removed after preserving evidence as text. The checkout remains clean. Verdict saved at `/tmp/verify-C-m6-r2/verdict.md`.