VERDICT: REVISE

I am Claude Fable 5.1 (claude-fable-5-1), independently verifying I-m10 round 4 at `285252f35b439ddcf690858a5ddc77706c7aa963` on `m10/first-customer`. I did not build it.

Round 4 was not built. The three commits since round 3 (`bb339db..HEAD`) add three unused optional fields to `orgs` and repoint the rollback target; nothing else changed. `convex/workspace.ts`, its tests, the UI, the legal text, the gate document and the handover are byte-identical to round 3. All three round-3 must-fix defects are still present, and I reproduced each on the local Convex backend at this HEAD. Nothing in the branch charges money, publishes or emails.

Evidence levels: suites and mutations are **SIM** (convex-test, vitest, node). The limit probes are **SERVICE** (local Convex backend, loopback only, synthetic sign-in). Nothing is SANDBOX or LIVE.

## Must-fix

### 1. The round-4 ruling is not implemented

- **Evidence:** `git diff --stat bb339db..HEAD` shows only `convex/schema.ts` (5 lines) and `ops/release/notes.json` (1 line).
- **Unused fields:** `exportingAt`, `exportedAt` and `importingAt` appear in `convex/schema.ts:25` and nowhere else in `convex`, `src` or `ops`.
- **Missing from `round4-prompt.txt`:**
  - staged export under a write fence
  - staged import with a publish step
  - delete that does not read the whole workspace
  - purge with a cursor over parents
  - the tests round 3 listed as missing
  - `ops/workspace/limits.mjs` (the directory does not exist)
  - updated legal and gate text
  - a Round 4 section in the handover (`handover.md` and `handover.html` end at round 3)
- **Fix:** build the round-4 ruling as written, then hand over with the local-backend output.

### 2. An export inside the stated limit cannot be imported above about 4,000 records (round-3 must-fix 1, unchanged)

- **Where:** `convex/workspace.ts:158-181`; `importAll` inserts each record blank and then patches it.
- **Input:** 4,200 people (8,451 rows, 2.0 MB export), imported into a fresh workspace on the local backend.
- **Wrong output:** `Too many reads in a single function execution (limit: 4096)` at `workspace.ts:179`.
- **Still claimed:** `docs/first-customer-gate.html` marks "Restore from an export, all or nothing" as done, and the limit is stated as 15,000 rows.
- **Fix:** staged import that writes each record once with final values, as the ruling describes; set the stated limit from what the local backend accepts.

### 3. A workspace with more than about 16 MiB stored can be neither exported nor deleted (round-3 must-fix 2, unchanged)

- **Where:** `convex/workspace.ts:44-47` (`snapshot` reads everything) and `:196` (the DELETE WITHOUT EXPORT path calls `snapshot` first).
- **Input:** 3,000 people with 3 KB of text each.
- **Wrong output:**
  - `exportAll`: `Too many bytes read in a single function execution (limit: 16777216 bytes)`.
  - `confirmDelete` with the right name and `DELETE WITHOUT EXPORT`: the same server error; the workspace stays.
- **Still claimed:** `src/routes/Legal.tsx:20` and `:36` say an owner can delete the workspace at any time.
- **Fix:** paged export; a delete path that uses a bounded budget read at most.

### 4. Deletion never finishes with about 5,000 childless integration parents (round-3 must-fix 3, unchanged)

- **Where:** `convex/workspace.ts:209-211` (`under` walks every parent in one mutation) and the purge loop at `:227-234`.
- **Input:** 5 people and 5,000 `safetyTargets` with no receipts; export, then `confirmDelete` with the sha256.
- **Wrong output:** `workspace:purge` fails with `Function execution timed out (maximum duration: 1s)` after a `Many reads (actual: 3694, limit: 4096)` warning. After 180 s the org still had `deletingAt` set, with records, events, objects and safety targets in place.
- **Reach:** integrations are gated off in production today, so no live workspace has these rows; the brief still requires bounded batches.
- **Fix:** carry a cursor over parents between runs, and delete a bounded number of parents with their children per step.

## Should-fix

- **The round-4 schema commit claims a gate that does not exist.** The message of `a4f3091` says the deploy rollback "refuses while a backup shows a deletion or an import in progress". `ops/deploy/prod.mjs:59` checks only `deletingAt`. Nothing sets `importingAt` yet, so this is harmless today; the gate must check it once staged import lands.
- **`purge` on a workspace that is not being deleted is still untested.** Changing `if (!org?.deletingAt) return` to `if (!org) return` (`workspace.ts:226`) passes all tests. The ruling asked for this test by name.
- **Export link-value counting and both byte limits are still untested.** Three mutants survive (below).
- **Byte limits still count characters, not UTF-8 bytes** (`workspace.ts:71`, `:84` use `.length`).
- **The delete form's phrase wiring is still untested.** Sending the phrase as `sha256` (`src/components/WorkspaceCards.tsx:66`) passes all tests.
- **Carried from earlier rounds, accepted as stated:** the timeline rescans a record's history per page; Stripe subscriptions are not cancelled on deletion (pending gate row).

## What I verified and how

I read `VERIFY.md`, the job brief, `AGENTS.md`, the handover (all rounds present), `verdict-r3.md` and `round4-prompt.txt`. I reviewed `bb339db..HEAD` in full and re-read `convex/workspace.ts` at HEAD.

| Command | My result |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | 39 files, 188 passed |
| `pnpm test:authority --maxWorkers=2 --testTimeout=15000` | 17 files, 99 passed |
| `pnpm verify:release` | 42 passed, 0 failed |
| `pnpm build` | exit 0, built in 1.23s |
| `ONLY='^(T2\|S6\|S7)' node limits.mjs` (round-3 probe, repointed at this checkout) | 3 scenarios, all three defects reproduced |

No test flaked. The base in `VERIFY.md` (`origin/build/unified-remold-2026-09-24`) is far behind this branch, so I reviewed the job diff against the brief's base `origin/integ/m3b` and the round diff against `bb339db`.

**Schema and rollback**

- The schema change is additive: three optional numbers on `orgs`.
- `a4f3091` is an ancestor of HEAD, is named in `ops/release/notes.json`, and its `convex/schema.ts` is identical to HEAD's.
- `a4f3091` is `a315d89` plus only that schema change.
- In a scratch clone at `a4f3091`: typecheck exit 0; 35 files, 151 tests passed.

**Local-backend probe (SERVICE)**

| Scenario | Export | Next step |
| --- | --- | --- |
| 4,200 people | ok, 8,451 rows | import fails with `Too many reads`; delete with sha256 and purge finish |
| 3,000 people, 3 KB text each | fails with `Too many bytes read` | delete with the phrase fails with the same error |
| 5 people, 5,000 safety targets | ok | delete confirmed; purge times out and is not finished after 180 s |

**Other checks**

- **Billing:** unchanged from round 3. Live keys, live-mode events and unsigned events are still refused (mutants caught).
- **Isolation and permissions:** unchanged code. Export for admins, export for restricted owners and the `deletingAt` fences are each still caught by a mutant.
- **Secrets:** a pattern scan of `convex`, `src`, `ops`, `docs` and `packages` for Stripe and Resend key shapes found none. This is not a full audit.
- **Tree:** I edited no tracked files and made no commits; `git status` is clean at `285252f`. Scratch copies are restored and match the checkout.

## Mutations

21 mutants, each applied alone in a scratch copy and restored (`/tmp/verify-I-m10-r4/mut` for vitest, `/tmp/verify-I-m10-r4/clone` for node tests). This is a subset of round 3's 43, because the code under test is unchanged.

**Caught (16):**

- **Purge (3):** `under()` capped at 100 parents; batch unbounded; members skipped.
- **Deletion confirm (2):** name not checked; sha256 not checked.
- **Export and import (3):** restricted owner allowed; admins allowed; import writes no `links` rows.
- **Fence (2):** `currentPrincipal` ignoring `deletingAt`; `billing.apply` ignoring `deletingAt`.
- **Billing (3):** live key accepted; live-mode events accepted; signature not verified.
- **Legal (1):** draft marker removed.
- **Rollback gate (2):** unreadable backup passes; `deletingAt` ignored (survives `prod.test.mjs`, caught by `deploy.test.mjs`).

**Survived (5), the same five as round 3:**

| Mutation | Meaning |
| --- | --- |
| `purge` runs on a workspace without `deletingAt` | Real gap |
| Export does not count link values | Real gap |
| Export has no byte limit | Real gap |
| Import has no byte limit | Real gap |
| Delete form sends the phrase as `sha256` | Real gap in UI wiring |

## What I could not verify

- Anything the round-4 ruling asked for, because it does not exist: staged export and import, the export write fence, cursor purge, `ops/workspace/limits.mjs` and its 10,000-record, 30 MB and 10,000-parent runs.
- Hosted Convex. The local backend enforces the documented limits, but its timeouts depend on the machine.
- Simultaneous imports under real OCC.
- Real Stripe test-mode delivery and the Checkout request against Stripe.
- The Settings cards in a browser with a signed-in session.
- A deployed rollback to `a4f3091`, or the gate against a real backup.
- Legal wording, price, live billing and the remaining gate rows stay pending with Shakur.

Files are in `/tmp/verify-I-m10-r4`:

- verdict.md
- limits.mjs
- limits.log
- limits.json
- limits-backend.log
- mutate.mjs
- mutate.out
- mutations.log
- mutations.json
- test.log
- authority.log
- release.log
- build.log
- typecheck.log
- target-test.log
