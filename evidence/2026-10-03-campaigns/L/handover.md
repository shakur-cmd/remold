# Job L: daily work queue, owners, readiness, workspace time zone

Branch `remold/work-queue`, based on origin/integ/campaigns 4bce955. Final commit: see `git log -1` on the branch (the handover is in the same commit as the code, so its own hash cannot be written here).
Builder: Claude Sonnet 5.5. Level: SIM (convex-test) plus SERVICE for screenshots (local Convex backend). Nothing LIVE, nothing deployed, nothing pushed. **Awaiting independent verification.**

## What changed
- `convex/lib/zone.ts` (new): `validZone`, `localDate`, `zoneDay(zone, instant)`, and the helpers for automations: `orgZone(ctx, orgId)` and `orgDay(ctx, orgId, instant)` returning `{ zone, day, start, end }` (`day` = local date as UTC midnight, `start` = local midnight, `end` = next local midnight minus 1 ms, so DST days are 23 or 25 h). No automation code touched.
- `convex/schema.ts`: `orgs.timeZone` optional string. `convex/orgs.ts`: `setTimeZone` (admin, validated, canonical spelling saved, refused names fail with VALIDATION).
- `convex/lib/standard.ts`: Task gains `assignee` (text, indexed slot), appended last. Reaches old orgs through `seed:ensureStandard`.
- `convex/lib/assignee.ts` (new): resolve an assignee by id or unique name, render `{ id, name, kind }`, list assignable people and active agents. Agents may take a task, clear it, or hand it to a person; giving it to another agent is FORBIDDEN.
- `convex/lib/values.ts`, `convex/lib/applyChange.ts`: assignee validated on every write path (REST/propose resolve names; applyChange refuses ids that are not members or active agents in the org). REST reads render the assignee as an object. Suggestion payloads too.
- `convex/lib/queue.ts` (new): `myQueue` returns the caller's open tasks as ready (every blockedBy task done; chains work because only direct blockers are checked and they stay open until done) and waiting (with open blockers named). Ready order: dated by due, then undated. Respects record scopes and hidden fields like the rest of Today.
- `convex/today.ts`: `daily(ctx, principal, zone, today, span)` now adds `mine`, `waiting`, `days` (local due date per task). `today.get` takes the workspace day from `orgDay`, returns `day: { zone, today, start, end }`, and ignores the old `today/start/end` args (still accepted, now optional). Existing sections unchanged in content.
- `convex/agentApi.ts`, `convex/http.ts`: `GET /api/v1/today` adds `day`, `mine`, `waiting: [{ task, waitingOn }]`; new `GET /api/v1/my-tasks?limit&cursor` (paged, own ready tasks).
- `convex/reminders.ts`: "today", overdue/due-today split, due-time text and once-per-day claim all use the workspace zone.
- `convex/queue.ts` (new): `queue.assignees` for the UI picker.
- `convex/lib/importCheck.ts`: `assignee` is a known task key for client imports.
- MCP: `remold_my_tasks` (paged), `remold_today` description rewritten, server instructions mention it; `client.myTasks`; spec list in `docs/spec/agents-v1.md`.
- UI: Today shows Mine and Waiting on others (Follow-ups kept) with day boundaries from the workspace zone; assignee picker (people and agents) on task records, shown by name everywhere including the timeline; Settings > Organisation time zone field (admin).
- Tests infra: `convex/_generated/api.d.ts` edited by hand (codegen needs a deployment; entries added in sorted order). `ops/authority/inventory.json` +4 rows (agentApi:myTasks, HTTP GET /api/v1/my-tasks, queue:assignees, orgs:setTimeZone); `inventory.test.ts` route parser now accepts hyphens in a route name. `convex/jobE.probe.test.ts` P-F16 now expects the new Today keys (`day, mine, quiet, tasks, waiting`); an additive contract change.

## Decisions
1. Assignee stored as the raw id (text), rendered as a name. Writes accept an id or an exact, unique name (case-insensitive); ambiguous names are refused.
2. "Waiting on others" lists the caller's own blocked tasks with the open blockers named (a blocker the caller cannot read shows as "A task you cannot see"). Unassigned tasks stay in Follow-ups only.
3. Mine includes future-dated ready tasks after the due ones, in date order, then undated. Capped at 50 shown, 200 read.
4. Deleted blocker = no longer blocks (deletes already strip it from blockedBy).
5. Handoff event needs no new code: assignee changes already write an attributed `update` event with before/after; the timeline renders names.
6. The old client args `today/start/end` are ignored: the workspace, not the browser, owns the day. The calendar posts query is unchanged and the page feeds it the workspace day.
7. Time zone validated with `Intl` (names only; offsets like +05:00 and blanks refused), saved in canonical case.
8. Reminder cron still fires at 11:00 UTC; only what "today" means changed.

## New env vars
None.

## Fail-before / pass-after
Base = 4bce955 code (tests written first). Saved: `zone-before.txt`, `queue-before.txt`.
- `convex/zone.test.ts` (8 tests: spring-forward 23 h day, fall-back 25 h day, local date vs UTC date, Kolkata half hour, default UTC + canonical save, invalid zones refused, admin only, Today boundary moves): before = file failed to load (`./lib/zone` missing, "no tests"); after = pass.
- `convex/queue.test.ts` (17 tests): before = 17 failed / 17; after = 17 passed. Covers: assignee field once and idempotent `ensureStandard` (also repairs an older org), name render and filter by name or id, picker list, out-of-workspace assignee refused, agent rules (self, person, clear OK; other agent 403 by id and by name), handoff events (user and agent), Mine ordering and isolation, agent sees only its own, readiness through a chain C->B->A, multiple blockers, done tasks excluded, agent waiting list with named blocker, paged `/my-tasks`, 22:00 New York task after UTC rollover, spring-forward day split of two tasks one minute apart, agent REST day.
- `convex/reminders.test.ts` new test (zone, local date, due time text, once per local day, mails again after local midnight): passes; with the zone forced to UTC (`reminder-mutant.txt`) it fails, so it can fail.
- `packages/mcp` client test for `my-tasks`: 9/9.

## Full-suite summary (after)
- `pnpm typecheck`: clean.
- `pnpm test:authority`: 101/101 (after adding the inventory rows; before that, 1 failed on the unknown route).
- `pnpm verify:release`: 37/37.
- `pnpm build`: built.
- `pnpm test`: with `--maxWorkers=4` (`test-final.txt`): 492 passed, 3 failed, 495 total. All three are 5 s/15 s timeouts, none an assertion: `gmailSync last contact` fails the same way on the untouched base (`test-base.txt`, which also had 10 timeouts under default parallelism), and the two `Calendar.drag` tests pass when run alone (second run 4/4; the first lone run showed the same two failing, so they are load-sensitive and I could not make them pass reliably in this environment). I did not touch calendar or posts code. Default `pnpm test` here (56 parallel workers) showed 8 failures at first, 4 of them real and fixed (imports key list, P-F16 keys); the rest were timeouts.
- Baseline from COMMON.md (329 / 101 / 37) is for a different commit; this branch has more tests.

## Screenshots (SERVICE: local Convex backend, Vite, headless Chromium, sign-in replaced by a self-signed JWT)
`ui-harness.mjs` makes them (`today-mine.png`, `settings-time-zone.png`, `task-assignee.png`). The browser logged three 403 resource loads I did not trace; pages rendered. I looked at today-mine and task-assignee; settings-time-zone was captured but I did not view it.

## Rollback compatibility
Schema is additive (`orgs.timeZone` optional; Task `assignee` is a new field row). The previous release can run on this data: it ignores the extra field and org column. Its Today would treat an assignee as plain text.

## Owner setup to go live
Deploy with `pnpm deploy:prod`, then `seed:ensureStandard` per existing org to add Task.assignee. Set each workspace's time zone in Settings (default UTC, so nothing changes until then). Give agents a task grant (create/update) if they should take or hand off tasks.

## Left undone or uncertain
- (Corrected in Round 2) `ensureStandard` does not fail when Task has no free text slot: it adds `assignee` without a slot. See Round 2, S1.
- Automations are not wired to `orgZone`/`orgDay`; the helpers are ready for that branch.
- `ops/authority/service-sweeps.mjs` (service-level mask/readonly sweeps) not extended with the new functions.
- Calendar page, invoices `pastDue` and other client-day features still use whatever `today` the client sends; only Today, the agent Today and the reminder were moved to the workspace zone. The Today page passes the workspace day to posts and unpaid invoices.
- `Intl.supportedValuesOf` feeds the zone list in Settings; the Convex runtime's ICU support for zone names was exercised in convex-test (Node) and the local backend, not on a hosted deployment.
- Assignee picker saves on the Save button, not instantly, so a custom text field named "assignee" on another object is not saved per keystroke.


## Round 2 (after independent verification REVISE on b990224)

Merged origin/integ/campaigns (761de78, saved views and automations) into the branch first (merge 07934a1). Conflicts were in `api.d.ts` (kept both sides), `packages/mcp/src/index.ts` (kept the other side's text plus my one sentence) and `ops/authority/inventory.json` (took the other side whole, re-added my rows: agentApi:myTasks, HTTP GET /api/v1/my-tasks, queue:assignees, orgs:setTimeZone, and now queue:status). Every entry from both sides is in.
Evidence: `round2-before.txt` (new tests against the pre-fix code: 12 failed), `round2-after.txt` (queue, zone, reminders, automations: all pass), `test-final2.txt`.

| Finding | Fix | Test (fails before, passes after) |
|---|---|---|
| B1 Mine empty after 200 done tasks | `convex/lib/queue.ts` filters `done` before anything is capped. Indexed path reads the person's tasks newest first, keeps only open ones, stops at 200 kept or 5000 rows read. Record-scoped path filters then slices. | `B1 shows an open task however many finished tasks...` (1201 done + 1 open), `B1 holds for a member who can read only some tasks` (205 done + 1 open, record-scoped) |
| S1 no free Task text slot | `ensureStandard` still adds `assignee` (unindexed) and writes one pending workspace inbox note, "Task assignee needs a free text slot: retire or unindex a Task text field. Until then the work queue only looks at the 2000 most recently updated open tasks." (not repeated on later runs). `queue.status` reports `assigneeNeedsSlot`; Settings shows "Task assignee needs a free text slot: retire or unindex a Task text field." in the Organisation card. `myQueue` without a slot scans `by_object_updated` newest first: at most **2000 open tasks and 8000 rows read** (finished tasks cost rows but not the 2000). I used the inbox note, not an ops alert (the alert cron is for operator signals, not per-workspace setup). | `S1 ... still gets an assignee field, an inbox note once, and a status`, `reports no problem when the slot exists`, `builds Mine from a scan... skipping finished ones`, `looks only at the 2000 most recently updated open tasks` |
| S2 Today crash with hidden dueDate | `today.get` returns `taskKey` independent of the due field; Mine and Waiting links use it (no `task!`). | `S2 Today names the task object when the member cannot read the due date` |
| S3 read filter hit the handoff rule | `resolveAssignee` has a mode; the REST list filter passes "filter", so no agent-to-agent refusal. Writes unchanged. | `S3 an agent may filter tasks by another agent` (by id and name) |
| S4 CSV assignee by name | `csv.ts` resolves Task.assignee through `resolveAssignee`; an unknown name is reported on its row ("Mars" is not a person or agent in this workspace). | `S4 a CSV assignee column takes a member's or an agent's name...` |
| N2 zone spelling | `validZone` saves what was typed; only capitalisation is taken from Intl (`america/new_york` becomes `America/New_York`; `Asia/Kolkata`, `Europe/Kyiv`, `US/Pacific` stay as typed). | `keeps a zone's spelling as typed...` |
| N1 Calendar and record page days | New `src/lib/zone.ts` holds the workspace zone (set by `OrgLayout`, UTC if unset). `localToday`, `localDay`, `dayRange`, `timeOfDay`, calendar `localSpan` and `moveToDay` use it, and the shared helpers in `convex/lib/zone.ts`. RecordPage's "today" uses `localToday`. Outside the app (a bare component test) the browser zone still applies. | `src/lib/calendar.test.ts`: byDay, 23 hour spring-forward span, and moveToDay in Auckland while the browser is New York |
| Automations | `nextDue(text, from, zone)` finds the wall clock time on local days (DST safe, `wallTime`); the tick's once-per-day key, `dateReached` day window and `{{today}}` / `dueInDays` use the workspace's local date; the sentence and error text say "workspace time zone" instead of UTC. The reminder and automations share `convex/lib/zone.ts`. | `schedules and dates follow the workspace time zone, through the spring-forward change` (daily 09:00 at 13:00Z after the clock change, not 14:00Z; a date that stays "today" until local midnight) |

### Suites (Round 2)
This machine's load average was about 10 (other sessions), so default timeouts fail unrelated tests. I used `--testTimeout=60000 --maxWorkers=2` where noted.
- `pnpm typecheck`: clean. `pnpm build`: built. `pnpm verify:release`: 37/37.
- `pnpm test:authority`: 101/101 with `--testTimeout=60000 --maxWorkers=2` (with default settings one run had 2 timeouts in different tests each time: inventory, masks, h0-parity).
- `pnpm test` with `--testTimeout=60000 --maxWorkers=2`: 562 passed, 1 skipped, 2 failed (`test-final2.txt`). The two failures are `Calendar.drag.test.tsx` tests that set their own 15 s timeout, so the flag does not reach them. They fail the same way, alone, on the untouched origin/integ/campaigns checkout under this load (verified in a scratch worktree, since removed), and I did not change calendar paging. The slow `automations` "daily cap" test also passes only with the longer timeout. I could not get these to pass here; the verifier reported the full suite green on an unloaded machine.

### Still true / left
- If a workspace changes its time zone, schedule automations already on keep their next due time until they fire once (then use the new zone). Not recomputed on change.
- Rollback: unchanged (additive; the previous release ignores `orgs.timeZone` and the extra field).
- The unindexed-assignee fallback limit (2000 open tasks) and the indexed path's 5000-row read limit are real limits: a person with more than 5000 newer finished-or-open assigned tasks ahead of an open one would not see the older open one. Fixing that needs an index on assignee plus done.
- Screenshots were not retaken; the UI change is two lines in Today (link key) and a Settings notice.
