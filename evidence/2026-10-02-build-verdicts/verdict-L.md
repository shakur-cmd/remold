VERDICT: PASS

Job L-polish, branch `polish/2026-10-03` at `6e886b3`, checked against base `origin/release/2026-10-03` (`f113ca7`). I am Claude Fable 5.1 (claude-fable-5-1), the independent verifier; I did not build this. No earlier verdicts were in the handover folder. Evidence level: SIM/local only.

## Must-fix

None.

## Should-fix

1. **Phone rows now show almost none of the task title** (`src/routes/Today.tsx:58-70`). The label is fully visible, as the brief asked, but the title pays for it.
   - At 390px, the title of a row with a funnel chip is 55px wide ("Send t…").
   - At 320px, the first row's title is 0px wide (nothing shown), and the "18 days ago 9:00 AM" label runs 7px past the row's padding (label right edge 298, row 291). It is still inside the card (308), so it is not cut.
   - Suggested fix: hide the funnel chip below `sm` (`hidden sm:inline-block`), or let the row wrap to two lines on phones.
2. **No test covers the intake cap's whitespace trim** (`convex/lib/intake.ts:34`). The brief said to accept only `/^\d+$/`; the builder trims first, so `" 50\n"` counts as 50. That is a reasonable call and is in the handover, but removing `.trim()` leaves all 51 tests green. Add one case for `" 50\n"` either way.
3. **A huge `LOOKBACK_DAYS` still breaks the sync** (`ops/gmail-sync/Code.gs:25`). This was already true on base and is not a regression.
   - `100000000` starts the read in the year -271764 and never saves a watermark; every run ends "No progress".
   - `99999999999999999999` throws `RangeError: Invalid time value` every run.
   - Suggested fix: have `wholeDays` fall back above a sane maximum (say 3650).
4. **The "No progress" text names a watermark that does not exist on a first run** (`ops/gmail-sync/Code.gs:61`). With no `WATERMARK` saved it reads "the watermark stayed at 2026-07-04T06:00:00.000Z", which is the lookback start. The comment above it ("the next one would be too") is also wrong when the same run just halved `WINDOW_DAYS`. Wording only.
5. **An incomplete run that posted inside the one-hour overlap is flagged "No progress"**. Example: watermark 13:30, one post at 13:05 goes through, then a long 429. Result: `posted 1`, watermark unchanged, `LAST_ERROR` = "No progress: read 4 messages and posted 1…". The text is honest and the watermark really did not move, so I am not asking for a change, only noting it.

## What I verified and how

**Suite, run by me on `6e886b3`:**

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0, "Already up to date" |
| `pnpm typecheck` | exit 0 |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | `Test Files 49 passed (49)`, `Tests 318 passed (318)`; no flakes |
| `pnpm test:authority` | `Test Files 17 passed (17)`, `Tests 101 passed (101)` |
| `pnpm verify:release` | `tests 37`, `pass 37`, `fail 0` |
| `pnpm build` | exit 0, `✓ built in 1.31s` |

These match the builder's numbers. `git status` in the checkout is clean after my run.

**Item 1, Today label clipping.** I re-ran the builder's Playwright harness myself in a scratch copy (local Convex backend on 3560/3561, Vite on 5219, Playwright's Chromium 1243 instead of Google Chrome).
- Base `Today.tsx`: all four labels `clipped: true` at 1440px and 390px.
- Branch `Today.tsx`: all four `clipped: false` at 1440, 768, 640 and 390px. Desktop row is now 273–911 inside the card's 256–928 (it was 273–971).
- At 320px one label is flagged (see should-fix 1).
- There is no automated test for this; the builder says so. The proof is the measurement and screenshots.

**Item 2, board `$0`.** `src/components/Board.tsx:67` now shows the total when `sum != null`. The server returns `sum: null` when the caller cannot query the number field (`convex/lib/list.ts:108-123`), so a hidden amount still shows only the count. My harness run printed `"Contacted\n2 · $0"` and `"New\n2 · $6,300"`.

**Item 3, owner cc'd test.** Present at `ops/gmail-sync/sync.test.ts:205`; goes red when `!owners[address]` is removed (mutation M3).

**Item 4, intake cap.** I evaluated the parsing expression on 24 inputs. Zero for: `1e3`, `0x10`, `+5`, `-1`, `2.0`, `1_000`, `1,000`, `0b11`, `Infinity`, Arabic and full-width digits, `5 0`, `50\n60`, `9007199254740992`, empty, missing. Accepted: `50`, `007` (7), ` 50\n` (50), `9007199254740991`.

**Item 5, Gmail day counts and `LAST_ERROR`.** Scratch probes against the real `Code.gs`:
- `WINDOW_DAYS` of `٣` and `5 5` fall back to 14; `5\n` and `007` read as 5 and 7.
- First window too slow: `WINDOW_DAYS` halves to 7 and `LAST_ERROR` starts "No progress".
- An incomplete run that advanced the watermark clears `LAST_ERROR`.
- A one-day window too slow still throws and records the error.
- A completed run clears it.

**Item 6, docs.** Each claim checked against the code:
- No "Clerk" left in `README.md`, `ops/deploy/README.md` or `.env.example`.
- `VITE_WORKOS_CLIENT_ID` and `VITE_WORKOS_REDIRECT_URI` are in `.env.example`; `convex/auth.config.ts` reads `WORKOS_CLIENT_ID`.
- `deploy:prod`, `backup:prod`, `backup:drill` exist in `package.json`; `--dry-run`, `--ref`, `--snapshot` exist in `ops/deploy/prod.mjs`.
- The rollback claim is true: `fcff97e`'s `convex/identity.ts` has no `purpose` check, while its schema accepts `purpose: "intake"`. The "Website intake key" and "Revoke" controls exist in `src/components/AgentsCard.tsx`.

**Safety hunt.** No schema change (`convex/schema.ts`, `ops/release/notes.json` and `packages/` are untouched). No secrets in the diff. No new network or email path; the Gmail tests run in a `vm` with stubbed Google services. Nothing in the diff touches permissions, workspaces or write paths beyond the intake cap becoming stricter.

## Mutations

Run in `/tmp/verify-L-polish/mut`, one at a time, original restored after each.

| # | Mutation | Result |
|---|---|---|
| M1 | Board: back to `!!total?.sum` | caught (1 failed) |
| M2 | Board: show total when sum is null | caught (1 failed) |
| M3 | Gmail: remove `!owners[address]` | caught (1 failed, the new test only) |
| M4 | Intake: drop the digits regex | caught (4 failed) |
| M5 | Intake: drop the safe-integer check | caught (1 failed) |
| M6 | Intake: drop `n > 0` | survived; equivalent, since `"0"` returns 0 either way |
| M7 | Intake: drop `.trim()` | **survived** (should-fix 2) |
| M8 | Gmail: `wholeDays` back to `Number() \|\| fallback` | caught (6 failed) |
| M9 | Gmail: `wholeDays` drops `> 0` | caught (1 failed) |
| M10 | Gmail: `WINDOW_DAYS` call site reverted | caught (5 failed) |
| M11 | Gmail: `LOOKBACK_DAYS` call site reverted | caught (1 failed) |
| M12 | Gmail: `LAST_ERROR` always cleared | caught (1 failed) |
| M13 | Gmail: `moved = complete` only | caught (1 failed) |
| M14 | Gmail: `moved` ignores `complete` | survived; differs only when `WATERMARK` is in the future |

A fifteenth mutant was a syntax error of mine and is discarded.

## What I could not verify

- **Real Apps Script.** Gmail sync was exercised only in the `vm` harness, same as the builder.
- **Real browsers and devices.** Layout was measured in headless Chromium only; no Safari or real phone.
- **The other three Today cards.** Unpaid invoices, Posts today and Gone quiet got the same class changes, but the harness seeds no data for them, so I did not measure them. Unpaid invoices on a phone has an amount, a due label and a "Mark paid" button all set not to shrink, so its title may be squeezed the same way as in should-fix 1.
- **What a scoped intake key can read under `fcff97e`.** I confirmed the old code has no purpose check; I did not test what such a key could reach. The README does not claim more than that.
- **Production.** Nothing here touched production, a hosted service or real email.

The verdict is saved at `/tmp/verify-L-polish/verdict.md`; my screenshots are in `/tmp/verify-L-polish/shots/`.
