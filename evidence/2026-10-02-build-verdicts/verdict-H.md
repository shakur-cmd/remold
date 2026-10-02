exit 0
VERDICT: PASS

Verifier: Claude Fable 5.1 (claude-fable-5-1), independent, did not build this. Job H-m8, branch `m8/gmail-dates` at `66271ba`, diffed against `origin/integ/m3b` (`4005bb1`, the base the job brief names). Evidence level: SIM only. Nothing was run against real Gmail, Apps Script or a hosted Remold.

No must-fix defects found. One owner decision and several should-fixes below.

## Owner decision (not a builder defect, but it is a gap against the brief)

**The Gmail sync key can read every Activity's title, type, when, about and source.** The brief said the key grants "exactly: read Person email (and title), create Activity" and must not read other objects.

- **Cause, confirmed:** `proposed()` in `convex/agentApi.ts` refuses a create unless the creator can read the object, all its records, and each field it writes. The builder disclosed this.
- **Why it was not fixed:** removing it needs an authority change, which the brief forbids ("do not add a new auth path").
- **Exposure:** if the key leaks from Script Properties, it exposes all people's names and emails plus every activity title and date, not only email ones.
- **Options:** accept it, or open a follow-up for a write-only create grant with H0-style approval.

## Should-fix

1. **The key can also write to the agent inbox.** `POST /api/v1/inbox` with the Gmail key returned 201 and created a pending inbox item. This is inherited behaviour of every agent key (`convex/http.ts:62`), not new code, but the brief did not grant it and no test covers it. The key can also `GET /records/<person>/events`, which shows the human actor's name and timestamps (values are masked to name and email). Suggest: say so in the README, or gate inbox writes for scoped keys in a follow-up.
2. **Idempotency replay ignores what the request is.** `convex/agentApi.ts:113-116` looks the key up by workspace and key only. Any agent with a create grant that reuses a key string gets a 200 with the first record (or `record: null`), and its own write is silently dropped, even for a different object or action. This is from reading the code; I did not run a cross-object case. Suggest: store action and objectId on the row and return 409 on mismatch.
3. **Test gap: owner's own address as a Person.** Mutant G9 (drop the `!owners[address]` check in `ops/gmail-sync/logic.js:56`) survived. If Shakur is a Person in Remold, a regression would log every sent-to-self mail on his own record unnoticed. Add one case.
4. **429 sleeps ignore the run budget.** `ops/gmail-sync/Code.gs:111` sleeps `Retry-After` up to 5 times with no check against the 270 s budget. With `Retry-After: 60` my probe slept 5 x 60 s, which would pass Apps Script's 6-minute kill, and the watermark is only saved at the end of the run (`Code.gs:48`). Remold's limiter is 120 writes a minute, so its `Retry-After` should be about a second and this is latent. Suggest: cap the sleep, and save the watermark after each finished window.
5. **Narrow stall band.** If reading the first window finishes just inside the budget and time runs out before the first post, the run neither advances nor halves `WINDOW_DAYS` (`Code.gs:36-41`). Unlikely to repeat exactly, but nothing forces progress.
6. **Paging race** with more than 100 threads moving during one batch remains, as the builder disclosed (`Code.gs:97`). Not re-tested by me.
7. **Handover is Markdown.** AGENTS.md asks for single-file HTML handovers. The builder flagged it; the coordinator should convert.
8. **README step 5 omits `WINDOW_DAYS`** from the optional properties (it is explained further down). Cosmetic.

Two deviations from the brief I checked and consider sound:
- The Idempotency-Key is `gmail:<messageId>:<personId>` rather than `gmail:<messageId>`. One message to two people would otherwise replay the first Activity. `source` stays `gmail:<messageId>`.
- "Title" was read as the record title (Person name), so the job-title field is not readable.

## What I verified and how

Suites on `66271ba`, run by me in the checkout:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | Test Files 34 passed (34), Tests 158 passed (158) |
| `pnpm test:authority` | Test Files 17 passed (17), Tests 99 passed (99) |
| `pnpm verify:release` | tests 19, pass 19, fail 0 |
| `pnpm build` | built in 1.93s, exit 0 |

No flakes, no reruns needed. `git status` in the checkout is clean afterwards.

**Rollback target `d544ac0`** (in a scratch copy):
- Its diff against base is `convex/schema.ts` only, 2 lines, one new table `idempotency`. The schema change is additive.
- Typecheck exit 0; tests 32 files, 142 passed.
- `ops/release/notes.json` names the full SHA.

**Probes I wrote and ran in a scratch copy** (deleted afterwards):

- **Gmail key over the REST routes.**
  - Person read returns only `{name, email}` on list, get, search and event history.
  - Search for the phone number and for "CTO" returns nothing.
  - Filter by `phone` and sort by `title` return 404.
  - A company record and its related list return 404.
  - `POST /authority/grant` and `POST /operations` return 400.
  - Create with an extra field returns 400; lookup by name on `about` is refused.
  - Exceptions: the inbox write and event history in should-fix 1.
- **Idempotency.**
  - A failed validation does not burn the key (400, then 200 with the same key).
  - An empty header returns 400.
  - A body field `idempotencyKey` without the header is ignored (two records), matching "header wins".
  - After a human deletes the record, a replay returns `record: null` and creates nothing.
- **lastContact.**
  - Another workspace's member passing this workspace's person id gets `{}`.
  - Querying the foreign org is refused ("Membership required").
  - Anonymous is refused.
- **End to end, SIM.** I loaded the real `logic.js` and built its people map from the real `GET /api/v1/records?object=person&limit=100` response, using a real Gmail sync key. I then posted its `planPosts` output to the real `POST /api/v1/changes` in convex-test.
  - Three posts returned 200 and a rerun returned the same three record ids.
  - Three activities exist, and `lastContact` showed the newest instant for both people.
  - So the script's request shape matches the server's contract.
- **Script edge cases.**
  - A quoted display name holding a person's address is not matched.
  - A comma inside a quoted name parses correctly; upper-case addresses match.
  - Third-party mail produces nothing.
  - A 500 mid-run and a 302 both stop the run and leave `WATERMARK` unset; on the 500, `LAST_ERROR` is written without the key.
  - A trigger event object as first argument works.
- **Secrets and network.** No secrets in the diff. The script tests use stubs only; no network path is reachable from tests.

## Mutations (mine, 32 total: 28 caught, 4 survived)

**Caught, server** (`convex/gmailSync.test.ts`):
- Preset also grants Person phone; update on Activity; delete on Activity; read on Company.
- Agent not scoped.
- Idempotency replay disabled; header not passed through; replay checked before the grant (probe leak).
- lastContact counts future activities; ignores When field permission; ignores person read permission; returns oldest; always uses the index fast path.

**Caught, script** (`ops/gmail-sync/sync.test.ts`):
- Reads subject (10 tests fail); reads plain body (10).
- Watermark advanced on failure; watermark passes an unfinished window; no lookback floor.
- Direction inverted (7); received mail counts cc'd people; drafts not skipped.
- Key without person id; key unstable; Idempotency-Key header dropped.
- 4xx swallowed; key leaks into the error.
- `after:` in milliseconds; unsafe email allowed into the query.

**Survived:**
- **S3, preset's own owner check relaxed to any member.** Equivalent: `issue()` enforces owner and the mutation is atomic, so an admin is still refused and no agent is left.
- **S6b, fast-path future bound removed.** Equivalent: the `at` filter also drops future values.
- **S11, Activity object read check removed.** Other checks in the same query still return nothing in the tested case.
- **G9, owner's own address matched as a person.** Real test gap, see should-fix 3.

Every "Done when" behaviour has a test, and the mutations above turned red for:
- direction both ways;
- no subject or body read;
- rerun uses the same keys;
- watermark only after success;
- 4xx stops and reports;
- key scope;
- last contact newest-of-several and hidden when unreadable.

The handover includes the exact setup steps. It states plainly that installing and authorizing the script needs Shakur's Google sign-in and that minting the key needs a Remold owner sign-in.

## What I could not verify

- **The UI.** The Create Gmail sync key button, the Person header "Last contact", and the People list column have not been seen running by the builder or by me. Sign-in is hosted and there is no local bypass. Only typecheck, build and the backend queries prove them. Awaiting a look in a browser.
- **Real Apps Script and Gmail.** The script has never run in Google. Gmail search semantics (`after:`/`before:` in epoch seconds, OR groups of 40 terms, `-in:chats`, thread ordering) are assumed from documentation; the stub only approximates them. The first real run needs Shakur's sign-in and should be watched.
- **Builder's fail-before files.** I did not rerun the tests on the pre-fix commits; my own mutations stand in for that.
- **Diff base.** I used `origin/integ/m3b` because the job brief names it; VERIFY.md's default base is `origin/build/unified-remold-2026-09-24`.
- **Decisions log.** I did not append to the shared decisions log; that is left to the coordinator.

Scratch: `/tmp/verify-H-m8/` holds my suite logs, `mutate.py`, `mutations.log` and `verdict.md`. The scratch repo copy was removed. The folder also contains files I did not create (`full.diff`, `inherited-review.diff`, `mutations.py`, `probes.log`, `mutant-*.log`), which I left untouched. I did not check whether a `verdict.md` was already there before writing mine.
