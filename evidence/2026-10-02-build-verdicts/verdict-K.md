VERDICT: PASS

Verifier: Claude Fable 5.1 (claude-fable-5-1). I did not build this. Job K-web, checkout `/home/shakur/work/verify/K-web`, branch `remold-intake` at 2306555, base `origin/main` 9e663ec (there is no local `main`). The diff is two files: `functions/api/intake.js` (+46/-2) and `tests/intake.test.js` (+160). The checkout is untouched (`git status` clean, HEAD unchanged); nothing was committed, pushed or deployed.

## Must-fix

None.

## Should-fix (none blocks deploy)

1. **A throwing `waitUntil` replaces the visitor's answer.** `functions/api/intake.js:214-217` calls `waitUntil(...)` inside `finally` with no guard. Probe P1: a `waitUntil` that throws makes `handleIntake` reject ("waitUntil boom") after the email was already sent, instead of returning 200. I know of no case where Cloudflare's real `context.waitUntil` throws here, so this is hardening, not a live bug. It is the only path I found where the Remold code can change the email path's outcome. Fix: wrap the call in `try { ... } catch {}` and add a test.
2. **The `onRequest` wiring is untested.** Mutation M15 (drop the `context.waitUntil` argument at line 222) survives the suite. On Pages that would let the Remold send be cut off once the response is out. The current code is correct (probe P3: one promise handed to `context.waitUntil`, 200 in 4.5 ms with Remold hanging). Fix: one test that calls `onRequest` with a fake context.
3. **Retry rules are only partly pinned by tests.** These mutations survive: no retry on 429 (M8), Retry-After cap removed (M9), Retry-After ignored (M10), timeout not retried (M13b), no timeout on the Remold fetch (M13c), retry on 500 (M17). The code itself behaves correctly in my probes. Fix: a 429 test, a "500 is one attempt" assertion, and a fake-timer test for the cap and the timeout.
4. **Nothing tests that Remold starts after the email.** M12 (start the Remold send before `sendLead`) survives. Probe P4 shows the real order is right.
5. **A malformed `source` drops the Remold lead.** At line 131, `source: "http://["` makes `new URL` throw. The lead is emailed (200) but never sent to Remold; the log line is `status:"error", message:"TypeError"` (probe P2). The real form always sends `/start?...`, so only a hand-made request hits this. M16 (remove the `.catch`) also survives, since no test reaches this path. Fix: fall back to `/` on a bad URL.
6. **Phones with more than 20 digits get a permanent 400 from Remold.** The site allows 80 characters; Remold (`convex/lib/intake.ts`, branch m6/lead-intake) rejects over 20 digits. Probe P9: "540-555-0100 or cell 540-555-0199 ext 22" is 22 digits, so the lead is emailed but not in Remold. The same happens for an email the site accepts but Remold's regex rejects ("not an email"). Fix: leave the phone out of the Remold body when it has over 20 digits (it is still in the email).
7. **The handover understates the worst case.** It says about 21 s; it is about 25 s (10 s first attempt answering 429/503 late, 5 s capped wait, 10 s second attempt). Measured: hang then hang = 21.0 s; capped wait = 5.0 s.

## What I verified and how

Commands, run by me:
- **Suite:** `bun test` in the checkout gives `25 pass, 0 fail, 71 expect() calls, 2 files`.
- **Pre-deploy checks:** `scripts/sync-dist.sh --check` gives `OK: dist/ in sync`; `bun scripts/check-seo.mjs` gives `check-seo: OK (29 pages, 26 sitemap URLs)`.
- **Fail-before:** base `intake.js` with the new test file, in scratch: all 13 new tests red, 6 old intake tests green. This matches the handover.
- **Scratch:** mutations and probes ran in `/tmp/verify-K-web/mut`, a copy; `cmp` confirmed it matched the checkout before the runs.

Focus areas:
- **Email can't be broken or delayed by Remold.**
  - Remold down, 500, 400, 401 or hanging: the visitor gets 200 and there is exactly one Resend call.
  - Slow Remold (3 s) with a 200 ms email: the visitor is answered in 201 ms, and the Remold fetch starts only after the email finished (P4).
  - Remold hanging forever: the visitor is answered in 1 ms (P6).
  - Email failing (Resend 500 or network throw): the visitor still gets 502 and Remold is still attempted once (P10).
  - Honeypot, failed validation, bad kind, missing key: no background task and no Remold call.
  - The one caveat is should-fix 1.
- **Idempotency key reuse.**
  - The Remold `Idempotency-Key` is the same 64-hex `requestKey` sent to Resend.
  - A resubmitted form with a new `submittedAt`, and the internal retry, send byte-identical bodies and the same key (P7), so Remold replays rather than duplicates.
  - A different form key or kind gives a different key (P7b).
  - I read Remold's handler on branch m6/lead-intake: key format (1-255 visible ASCII), bearer format, field caps (name/company/source/campaign 200, message 5000) and body shape all fit what the site sends.
- **No key or contact data in logs.**
  - Outcomes covered: 201, 400 (with the email echoed in Remold's error body), 401, 500, 503, network error (with the key in the error message), timeout, both skip reasons and the error path, each with the email succeeding and failing.
  - No log line held the intake key, Resend key, name, email, phone or business (P8, P6).
  - Lines carry only event, status, receiptId (a hash prefix already logged by `intake_accepted` on main), attempts and reason.
- **Retry rules.**
  - 429 with `Retry-After: 3600`: second call 5002 ms later, two calls total (P5).
  - 503 with an HTTP-date or no Retry-After: 1 s wait, two calls, then stop.
  - Timeout: 10 s, one retry, stop at 21 s, logged `timeout, attempts 2` (P6).
  - 400, 401, 422, 500: one call.
- **Missing env and phone-only.** Missing env gives one `skipped / not_configured` line and no call. A phone-only lead gives one `skipped / no_email` line and no call.

## Mutations

Caught (14): await Remold inline (M1), fresh idempotency key (M2), log the key (M3), log the email (M4), retry on 400/422 (M5), no retry on 503 (M6), two retries (M7), Remold only on email success (M11), network errors not retried (M13), key-missing check dropped (M14b), wrong bearer (M18), phone-only sent anyway (M19), no log line when unconfigured (M20), Remold failure thrown into the request (M21).

Survived (10): M8, M9, M10, M12, M13b, M13c, M14 (URL-missing check dropped; the test only removes the key), M15, M16, M17. All but M14 are covered under should-fix 2 to 5.

## Decisions for the coordinator (builder's calls, not defects)

- **Phone-only leads are not sent to Remold**, because Remold requires an email. They still arrive by email. The brief did not cover this.
- **When the email fails, Remold still gets the lead** (the brief asked for this). If the visitor then edits the form and resends, the browser reuses the same key (`assets/start.js:188`): Remold answers 422 and keeps the first version. That key reuse exists on main and is outside this job.

## Not verified

- Nothing ran against real Remold, Resend or Cloudflare. All fetches were stubbed.
- I did not confirm that the Pages runtime gives `waitUntil` at least 25 s after the response.
- I did not confirm that workerd names the abort error `TimeoutError`. Either way the code retries; only the log label would differ.
- Remold's contract was read from the unmerged job branch `m6/lead-intake` (5d5cfe9) in `~/work/jobs/C-m6`, not from what is deployed at nautical-viper-899.
- The handover's deploy command matches the repo's CLAUDE.md; I did not run it.

The verdict is written to `/tmp/verify-K-web/verdict.md`.
