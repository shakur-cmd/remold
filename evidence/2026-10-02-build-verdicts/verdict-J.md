VERDICT: PASS

Verifier: Claude Fable 5.1 (claude-fable-5-1), independent of the builder. Job J-rel2, branch `release/2026-10-03` at `e903fa4`, compared against the live base `origin/release/2026-10-02` (`e4775f0`). No tracked file was edited and nothing was committed; `git status` is clean after all runs.

No must-fix defect found. One decision needs the coordinator's sign-off before deploy (should-fix 1).

## Must-fix

None.

## Should-fix

1. **Rollback target is not what the brief specified; coordinator must accept it.** The brief asked for a schema-only commit on top of `3c4e789`. `fcff97e` is built on `e4775f0` (the live code) and also changes `convex/alerts.ts` (two lines: the `intake-limit` kind and its notice text). The builder disclosed both. I think the builder's choice is the right one: `3c4e789` code would drop the live invoices, funnels and import features, and the `alerts.ts` widening is needed for the typecheck against the final schema. Everything I could check on it holds (see "Schema and rollback target" below). It is still a deviation from an explicit instruction, so confirm it rather than inherit it.
2. **Rollback leaves intake keys partly usable.** On the `fcff97e` code, a key with `purpose: "intake"` and the intake field grants reads no records and writes none (`POST /changes` and `/suggestions` → 404, record list → 404, search → `[]`). But `GET /api/v1/me` returns 200 with the workspace name and `POST /api/v1/inbox` returns 201, so a leaked website key could fill the agent inbox. The handover says "revoke any intake keys" after a rollback; make that a required rollback step, not advice.
3. **One Gmail mutant survives.** Removing the `!owners[address]` check in `contactsOf` (`ops/gmail-sync/logic.js:56`) leaves all 16 sync tests green. The new owner-as-Person test passes only because the owner's address is left out of the search. The real code is correct: with the owner as a Person, mail from the owner to Ada with the owner cc'd posts only `gmail:x1:p_ada`. Add that case as a test.
4. **Cap parsing is looser than "positive whole number".** `convex/lib/intake.ts:34` uses `Number()`, so `"1e3"`, `"0x10"` and `"+5"` are accepted as 1000, 16 and 5 (each returned 201). `"50abc"`, `"Infinity"` and `"9007199254740993"` are refused (429). Low risk since the operator sets it; a `/^\d+$/` test would match the spec wording.
5. **`WINDOW_DAYS` is not validated (inherited from verified m8).** With `WINDOW_DAYS=-3` the run loops over empty backward windows until the budget ends, posts nothing, reports `complete:false` and leaves `LAST_ERROR` empty, every day. Fall back to the default for anything that is not a positive number.

## What I verified and how

**Suites on `e903fa4` (run by me):**

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Already up to date |
| `pnpm typecheck` | exit 0 |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | Test Files 48 passed (48), Tests 300 passed (300) |
| `pnpm test:authority` | Test Files 17 passed (17), Tests 101 passed (101) |
| `pnpm verify:release` | tests 37, pass 37, fail 0 |
| `pnpm build` | built, exit 0 |

No flakes, no reruns needed. These match the handover's numbers.

**1. Merges.**
- Merge parents are `5601b36`, `5d5cfe9`, `66271ba`, in the brief's order.
- Every test title on the live base and on m5 is present at HEAD. From m6, one title is gone (the old "fills only empty person fields", replaced by the 2a behaviour). From m8, three are gone: the workspace-idempotency test (replaced by the m6-rules replay test) and two renamed sync tests.
- Idempotency: only m6's `idempotencyKeys` is used. m8's `idempotency` table and code are gone. The Gmail key format `gmail:<msg>:<person>` is kept and replays under m6's rules (`convex/gmailSync.test.ts:81`).
- `src/lib/pages.ts`: `usePinnedPages` is unchanged from live; only `useAllPages` is added.
- `vite.config.ts` includes the union of the test globs.

**2a. Intake never modifies a Person.** `convex/lib/intake.ts:117-120` only links a match. My probe: a lead with a matching email (different case and spacing), a new phone and a different company returned 201, and the existing Person and its Company were byte-identical afterwards (values, title, `updatedAt`, event count). The `update person` grant is gone from the key.

**2b. Mutant-killing tests.** Present and effective; see the mutation table.

**2c. Spec.** `docs/spec/agents-v1.md` documents the header, 422 on mismatch, the 24-hour window, the intake route and its status table. I checked the table against the running code: 201; 400 for a missing key, bad email, empty name, unknown field and non-JSON body; 401 for an unknown key; 403 for an intake key on eight other routes; 404 for `GET /intake/lead` and `POST /intake/lead/x`; 422; 429.

**2d. Gmail sync.**
- Owner as a Person: nothing logged for sent-to-self, and no search names the owner. With the owner as the only Person, zero searches run.
- Retry-After: a 10000 s wait on the first post causes no sleep, `posted:0`, `LAST_ERROR` empty, and the watermark stays at the last finished window. A 100 s wait sleeps twice then stops, inside 270 s.
- Watermark is saved after each finished window (`Code.gs:49-50`).
- README lists `WINDOW_DAYS`.
- Dedup read against the real REST route with the sync key: 119 activities in a 14-day window came back over 2 pages with none missing. Both bounds are inclusive and rows 1 ms outside are excluded, so the read is a superset of what the window posts.

**3. Schema and rollback target.**
- Schema diff against live is additive only: the `intake-limit` alert kind, the `idempotencyKeys` table, optional `agents.purpose`.
- `fcff97e` is an ancestor of HEAD, its parent is `e4775f0`, and it changes only `convex/schema.ts` and `convex/alerts.ts`. Its schema is byte-identical to HEAD's (`cmp`).
- On the `fcff97e` tree: typecheck exit 0; 41 files, 200/200 tests; authority 99/99; `verify:release` 37/37. (My first release run there showed 2 failures because my scratch copy had a detached HEAD; on a named branch it is 37/37.)
- `validateReleaseNotes` on the real `e4775f0..HEAD` file list returns class `expand` with `fcff97e`; `authorityFloorCheck(fcff97e)` is `true`.

**Hunt list.**
- Cross-workspace: idempotency keys are per agent key; matching is per org; the existing test covers it and I found no leak.
- Permission bypass: the write-only path in `applyChange` refuses members, ungranted fields and ungranted objects; an intake key gets 403 everywhere else.
- Partial writes: existing rollback tests pass; a rate-limited lead writes no records.
- Secrets: none in the diff (only a dummy `rm_aaaa…` in a test).
- Network in tests: none; Gmail, UrlFetch and Remold are stubbed.

## Mutations (scratch copy, 26 run)

**Caught (25):**

| Area | Mutation | Tests red |
|---|---|---|
| Intake 2a | email match patches the Person's phone | 1 |
| Intake 2a | phone match fills the empty email | 3 |
| Intake 2b | conflict copies the phone onto the email-matched Person | 1 |
| Intake 2a | phone-only match creates a new Person | 2 |
| Intake 2a | submitted details dropped from the Note | 2 |
| Cap | unreadable falls back to 50 | 6 |
| Cap | `isFinite` instead of `isSafeInteger` ("1.5") | 1 |
| Cap | absolute value ("-1") | 1 |
| Cap | zero means unlimited | 6 |
| applyChange | inner `fieldGranted` check removed | 2 |
| applyChange | write-only allowed for members | 1 |
| applyChange | touched fields ignored | 1 |
| Intake | `submitLead` grant check removed | 1 |
| Identity | purpose key usable on other routes | 1 |
| Idempotency | mismatch not refused | 2 |
| Idempotency | no expiry | 1 |
| Idempotency | replay disabled | 13 |
| HTTP | 422 mapping removed | 2 |
| HTTP | `/intake/leads` accepted | 1 |
| Gmail | owners not excluded from the search | 1 |
| Gmail | Retry-After cap removed | 1 |
| Gmail | no per-window watermark save | 2 |
| Gmail | dedup removed | 1 |
| Gmail | no Idempotency-Key sent | 6 |
| Gmail | partial window still saves its end | 2 |

**Survived (1):** `contactsOf` owner check removed (should-fix 3).

## What I could not verify

- Real Gmail and Apps Script behaviour: only the stubbed world and the Convex test REST route were exercised.
- Production state: that the live schema is exactly `e4775f0`'s and that m8's `idempotency` table never reached production. I checked the repo only.
- The UI screenshots and the builder's `ui-harness`: I did not rerun the harness or drive the app. UI coverage is the passing Calendar and list tests plus reading the merged `ObjectList.tsx` and `Today.tsx`.
- The m5 calendar and m8 last-contact merges were not mutated; I relied on their inherited tests passing and the title comparison.
- `pnpm deploy:prod`, `seed:ensureStandard` on real orgs, and the WorkOS sign-in path: not run, by the rules.
- VERIFY.md names `origin/build/unified-remold-2026-09-24` as the diff base; I reviewed against `origin/release/2026-10-02`, the base the job brief gives, since that is what is live.

The verdict is written to `/tmp/verify-J-rel2/verdict.md`; suite logs, mutation output and probe results are alongside it. The scratch repo copies and probe tests are deleted.
