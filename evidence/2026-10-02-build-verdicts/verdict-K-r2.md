VERDICT: PASS

Verifier: Claude Fable 5.1 (claude-fable-5-1). I did not build this. Job K-web round 2, checkout `/home/shakur/work/verify/K-web-r2`, branch `remold-intake` at 1f870ef (same as `origin/remold-intake`), base `origin/main` 9e663ec. The diff against base is two files: `functions/api/intake.js` and `tests/intake.test.js` (+377/-4). The checkout is untouched (`git status` clean, HEAD unchanged); nothing was committed, pushed or deployed. All fetches were stubbed.

## Must-fix

None.

## Round-1 should-fixes: all seven are fixed and now pinned by tests

| # | Round-1 finding | Fixed in code | Mutation now caught by |
|---|---|---|---|
| 1 | A throwing `waitUntil` replaced the visitor's answer | Yes, `intake.js:222-224` wraps it in try/catch | Guard removed: "a waitUntil that throws still leaves the visitor with their 200" goes red |
| 2 | `onRequest` wiring untested (M15) | Code was right | "Pages hands the Remold send to context.waitUntil" goes red |
| 3 | Retry rules partly pinned (M8, M9, M10, M13b, M13c, M17) | Code was right | All six go red, plus my extras: cap at 4 s or 6 s, Retry-After forced to 0, timeout at 30 s |
| 4 | Order after the email untested (M12) | Code was right | "Remold is only called once the email has finished" goes red |
| 5 | Malformed `source` dropped the Remold lead | Yes, `intake.js:136` falls back to `/` | Fallback removed: "a malformed source still reaches Remold" goes red |
| 6 | Long phone or bad email got a permanent 400 | Yes, `intake.js:132-134, 140` | Long phone sent anyway, phone always dropped, bad email sent anyway, bad email skipped silently: all red |
| 7 | Handover said 21 s worst case | Handover now says about 25 s | n/a |
| extra | M14 (URL-missing check dropped) | Code was right | "is skipped with one log line when REMOLD_INTAKE_URL is missing" goes red |

## The email path still cannot be broken or delayed

- **Email code is unchanged.** The only lines removed from `intake.js` against base are the `handleIntake` signature and the `onRequest` call. `sendLead` is byte-identical.
- **A throwing `waitUntil` no longer matters.** Email OK gives 200; Resend 500 or a network throw gives 502, the same as main. One email is sent in each case. The new log line holds only `wait_until_failed`, the receipt id and the error name.
- **The visitor's answer never depends on Remold.** For Remold 201, 400, 401, 403, 404, 422, 500, 429 twice, 503 twice and network error twice, each with the email succeeding and failing, the visitor got 200 or 502 as on main, with exactly one Resend call.
- **No delay.** With a 200 ms email and Remold hanging, the visitor was answered in 202 ms and the Remold fetch started at 201 ms, after the email. With Remold hanging forever the visitor was answered in 5 ms; the background task ended at 21.0 s with `timeout, attempts 2`.
- **Rejected requests do no background work.** Honeypot, bad kind, no consent and no idempotency key: zero tasks, zero fetches.
- **Odd payload types don't break the email.** Phone as an object, source as an array, email as a number, ref as an object, details null: visitor 200 and one email each.

## Should-fix (none blocks deploy)

1. **The phone limit's exact edge is not tested.** Two mutations survive: limit raised from 20 to 21, and the leading `+` not counted. The code itself is right: 20 digits is sent, 21 is dropped, `+` with 19 digits is sent, `+` with 20 is dropped, matching Remold's `normalPhone`. One more test case with `+` and 20 digits would pin both.
2. **The `.catch` on the Remold task is untested** (M16 still survives). I found no input that reaches it now that the malformed source is handled, so it is a safety net with nothing to catch today.
3. **Handover count is slightly off.** It says the fail-before run was "31 pass, 4 fail, 35 tests"; I get 32 pass, 4 fail, 36 tests on 2306555. The same four tests fail.

## What I verified and how

- **Suite:** `bun test` gives `36 pass, 0 fail, 100 expect() calls, 2 files`. Three more runs in scratch: 36/0 each time.
- **Pre-deploy checks:** `scripts/sync-dist.sh --check` gives `OK: dist/ in sync`; `bun scripts/check-seo.mjs` gives `check-seo: OK (29 pages, 26 sitemap URLs)`.
- **Fail-before:** new tests with the round-1 `intake.js` (2306555): 4 fail, 32 pass, the four the handover names. With base `intake.js` (9e663ec): 23 fail, 13 pass.
- **Scratch:** mutations and probes ran in `/tmp/verify-K-web-r2/mut`, a copy without `.git`; `cmp` confirmed it matched the checkout afterward.
- **Idempotency:** two form submits plus an internal 503 retry made three Remold calls with one key and byte-identical bodies; the key equals the Resend key and is 64 hex characters.
- **Logs:** across all outcomes above, no line held the intake key, the Resend key, name, email, phone or business, including when Remold's error body or the thrown error contained them.
- **Retry timing on a real clock:** 429 with `Retry-After: 3600` gave a 5002 ms gap and two calls.
- **Remold's rules:** I compared the site's email regex and phone-length rule with `convex/lib/intake.ts` on `m6/lead-intake` (5d5cfe9); they match.
- **Secrets:** the diff holds only the dummy test key `rmk_secret_key` and the `remold.test` URL.

## Mutations

Caught (41):
- **Round-1 survivors:** M8, M9, M10, M12, M13b, M13c, M14, M15, M17.
- **Round-1 caught, still caught:** M1, M2, M3, M4, M5, M6, M7, M11, M13, M14b, M18, M19, M20, M21.
- **Round-2 fixes:** `waitUntil` guard removed, source fallback removed, long phone sent anyway, phone always dropped, phone limit 25, bad email sent anyway, bad email skipped without a log line.
- **Extras:** cap 6 s, cap 4 s, Retry-After forced to 0, timeout 30 s, source always the kind, campaign dropped, company dropped, timeout logged as `network_error`, attempts miscounted.

Survived (3): M16 (`.catch` removed), phone limit 21, leading `+` not counted. See should-fix 1 and 2.

## Not verified

- Nothing ran against real Remold, Resend or Cloudflare.
- Whether the Pages runtime keeps `waitUntil` alive for the 25 s worst case.
- Whether workerd names the abort error `TimeoutError`; either way the code retries, only the log label would differ.
- Remold's rules were read from the unmerged `m6/lead-intake` branch, not from what is deployed at nautical-viper-899. If they change before merge, the site's two copied checks need to follow.
- The deploy command in the handover matches the repo's CLAUDE.md; I did not run it.

The verdict is written to `/tmp/verify-K-web-r2/verdict.md`. The scratch copy `/tmp/verify-K-web-r2/mut` is still there.
