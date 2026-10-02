VERDICT: PASS

Job L-polish, round 2, branch `polish/2026-10-03` at `a6723bd`, checked against the brief's base `origin/release/2026-10-03` (`f113ca7`). I am Claude Fable 5.1 (claude-fable-5-1), the independent verifier; I did not build this. One earlier verdict was in the handover folder (`verdict-r1.md`, PASS with five should-fixes). Evidence level: SIM/local only.

## Must-fix

None.

## Should-fix

None that should hold the branch. Three small notes:

1. **The tightest one-line row is at 768px** (`src/routes/Today.tsx:107-110`). The sidebar appears there, and the title of a row with a funnel chip gets 105px ("Send the sig…"). This is the same as round 1 and base, and it passes the builder's own 96px rule, so it is not a regression. Raising the wrap point from `sm` to `md` would fix it if it bothers you.
2. **Gone quiet and Posts today are still unmeasured.** The harness seeds no data for them. They have one short label each, so the risk is low.
3. **A `WATERMARK` holding garbage reads "no watermark is saved yet"** (`ops/gmail-sync/Code.gs:61`). The sync already treats it as absent, and the builder disclosed it. Wording only.

## Round 1 should-fixes: are they closed?

| # | Round 1 should-fix | Status | How I checked |
|---|---|---|---|
| 1 | Phone rows show almost no title | Closed | My harness run: titles are 288px at 390px and 218px at 320px (were 55px and 0px) |
| 2 | No test for the intake cap trim | Closed | Removing `.trim()` now fails 1 test (M7) |
| 3 | Huge `LOOKBACK_DAYS` breaks the sync | Closed | `wholeDays` falls back above 3650; four mutants on the limit all caught (R1–R4) |
| 4 | "No progress" names a watermark that does not exist | Closed | First-run text is "no watermark is saved yet"; reverting it fails the test (R5) |
| 5 | Posted-inside-overlap run flagged "No progress" | Left alone, as round 1 asked | n/a |

## What I verified and how

**Suite, run by me on `a6723bd`:**

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0, "Already up to date" |
| `pnpm typecheck` | exit 0 |
| `pnpm test --maxWorkers=2 --testTimeout=15000` | `Test Files 49 passed (49)`, `Tests 322 passed (322)`; no flakes |
| `pnpm test:authority --maxWorkers=2 --testTimeout=15000` | `Test Files 17 passed (17)`, `Tests 101 passed (101)` |
| `pnpm verify:release` | `tests 37`, `pass 37`, `fail 0` |
| `pnpm build` | exit 0, `✓ built in 1.34s` |

These match the builder's numbers. `git status` in the checkout is clean after my run, and HEAD is still `a6723bd`.

**Today layout (item 1 and should-fix 1).** I ran the builder's Playwright harness myself in a scratch clone: local Convex backend on 3560/3561, Vite on 5219, Playwright's Chromium 1243. I added five widths (360, 639, 640, 768, 1024) and a page-overflow check.

- Round 1 `Today.tsx` (`6e886b3`): `ROWS SQUEEZED` at 390, 360 and 320px. Titles at 320px were 0, 94, 18, 27 and 0px.
- Branch `Today.tsx`: `ROWS ALL READABLE` at all eight widths, with all five rows found each time.
  - 390px: titles 288, 288, 288, 288 and 226px (invoice).
  - 320px: titles 218, 218, 218, 218 and 156px.
  - 640px and up: one line per row, 32px high, same title widths as round 1.
- Every due label is `clipped: false` at all eight widths.
- The page never scrolls sideways (`scrollWidth` equals the viewport at every width).
- "Mark paid" stays inside the row's padding at every width.
- I looked at the 390px and 320px screenshots: the title has its own line, with the chip and the full due label under it. At 320px the label drops to a third line.
- There is still no automated test for layout; the proof is the measurement and screenshots.

**Board `$0` (item 2).** My harness run printed `"Contacted\n2 · $0"` and `"New\n2 · $6,300"`. Unchanged since round 1.

**Intake cap (item 4, should-fix 2).** The parsing line is unchanged since round 1 (`convex/lib/intake.ts:34`). The new test stubs `" 2\n"` and expects 201, 201, 429.

**Gmail day counts (item 5, should-fix 3).** I called `wholeDays` directly on 22 inputs.
- Default for: `3651`, `99999999999999999999`, `0`, `-3`, `+5`, `1e1`, `0x10`, `1.0`, `5 5`, Arabic and full-width digits, empty, null, `true`, `3650.5`.
- Accepted: `1`, `3650`, `03650` (3650), `007` (7), ` 30\n` (30), the number `30`.

**"No progress" text (should-fix 4).** Read at `ops/gmail-sync/Code.gs:59-62`. The test checks the exact text in three cases: with a watermark and a halved window, after a long rate limit (no window note), and on a first run. The comment above it now matches the code.

**Docs (item 6).** Unchanged since round 1, where I checked each claim against the code. The Gmail README's new lines (1–3650 range, "No progress" contents) match the code.

**Safety hunt.**
- No schema change: the diff for `convex/schema.ts`, `ops/release` and `packages/` is empty.
- No secrets in the diff.
- No new network or email path; the Gmail tests run in a `vm` with stubbed Google services.
- Round 2 touches only layout classes, one test, one parsing limit and one status string. Nothing touches permissions, workspaces or write paths.

## Mutations

Run in a scratch clone, one at a time, original restored after each. All 20 were caught.

| # | Mutation | Result |
|---|---|---|
| M1 | Board: back to `!!total?.sum` | caught (1 failed) |
| M2 | Board: show total when sum is null | caught (1 failed) |
| M3 | Gmail: remove `!owners[address]` | caught (1 failed, the owner-cc test only) |
| M4 | Intake: drop the digits regex | caught (4 failed) |
| M5 | Intake: drop the safe-integer check | caught (1 failed) |
| M7 | Intake: drop `.trim()` | caught (1 failed); survived in round 1 |
| M8 | Gmail: `wholeDays` back to `Number() \|\| fallback` | caught (9 failed) |
| M9 | Gmail: `wholeDays` drops `> 0` | caught (1 failed) |
| M10 | Gmail: `WINDOW_DAYS` call site reverted | caught (8 failed) |
| M11 | Gmail: `LOOKBACK_DAYS` call site reverted | caught (1 failed) |
| M12 | Gmail: `LAST_ERROR` always cleared | caught (1 failed) |
| M13 | Gmail: `moved = complete` only | caught (1 failed) |
| R1 | Gmail: `wholeDays` drops `<= 3650` | caught (4 failed) |
| R2 | Gmail: limit becomes `< 3650` | caught (1 failed) |
| R3 | Gmail: limit becomes `<= 3651` | caught (2 failed) |
| R4 | Gmail: clamp to 3650 instead of the default | caught (4 failed) |
| R5 | Gmail: first run names the lookback start as a watermark | caught (1 failed) |
| R6 | Gmail: halved-window note dropped | caught (1 failed) |
| R7 | Gmail: halved-window note always added | caught (1 failed) |
| R8 | Gmail: `WINDOW_DAYS` not saved after halving | caught (2 failed) |

I did not rerun round 1's two surviving equivalents (M6, M14); that code is unchanged.

## What I could not verify

- **Real Apps Script.** Gmail sync was exercised only in the `vm` harness, same as the builder.
- **Real browsers and devices.** Layout was measured in headless Chromium only; no Safari or real phone.
- **Gone quiet and Posts today cards.** Not seeded, not measured.
- **What a scoped intake key can read under `fcff97e`.** Unchanged from round 1; the README does not claim more than "no purpose check".
- **Production.** Nothing here touched production, a hosted service or real email.

One process note: `VERIFY.md` names `origin/build/unified-remold-2026-09-24` as the default diff base. That shows 133 files, because it includes the whole live release. I used the brief's base, `origin/release/2026-10-03`, which shows this job's 12 files.

The verdict is saved at `/tmp/verify-L-polish-r2/verdict.md`. My harness output is in `ui-before.txt` and `ui-after.txt` there, screenshots in `shots/`, mutation output in `mutations.txt`.
