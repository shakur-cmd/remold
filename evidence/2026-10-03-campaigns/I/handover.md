# Job I handover: automations agents can define and people switch on

Builder evidence only, not certification. Level: unit (convex-test) plus SERVICE on an isolated local Convex backend with synthetic data. No hosted service, deploy, or real email was touched.

- Branch: `remold/automations`, based on origin/integ/campaigns (aa68030).
- Commits: dc19259 (code and tests), 65b7e20 (evidence, plainer action lines). Final commit: this handover, see `git log -1 remold/automations`.

## What changed

- `convex/lib/standard.ts`: new standard object `automation` (name, when, object, field, equals, offsetDays, schedule, actions, status draft/on/paused, lastRun). Reaches older orgs through `seed:ensureStandard`.
- `convex/schema.ts`: three new tables (additive): `automationState` (who turned it on, at which authority epoch, failure count), `automationRuns` (history and dedupe key), `automationCaps` (daily counters).
- `convex/lib/automation.ts` (new): definition parsing, validation (`check`), the plain sentence, the write rules run inside applyChange, trigger matching and the per-automation queue (`enqueue`).
- `convex/automations.ts` (new): the runner (`run` action, `execute`, `failed`, minute `tick`), templating, dry run, run history, and the app's `view` query and `setOn` mutation.
- `convex/lib/applyChange.ts`: calls the automation rules before an Automation record is written, and the triggers after every write. New option `automation` carries the chain depth.
- `convex/authority/agentGuards.ts`: agents may not set an automation to `on`.
- `convex/lib/emailRules.ts`: only the campaign sender's actor (`Campaign email`) may set Sending/Sent. Before, any `automation`-kind actor could.
- `convex/events.ts`: an automation's writes show as "Automation: <name>" in the timeline.
- `convex/agentApi.ts`, `convex/http.ts`: `GET /api/v1/automations/<idOrRef>/runs`, `POST /api/v1/automations/<idOrRef>/test` (body `{ "record": "<idOrRef>" }`).
- `convex/crons.ts`: "Automations" every minute.
- `convex/_generated/api.d.ts`: registers the two new modules (hand-edited to match codegen, as Job C did).
- `packages/mcp/src/client.ts`, `index.ts`: `remold_automation_runs`, `remold_automation_test`, and instructions on drafting automations and asking a person to turn them on.
- `src/components/AutomationPanel.tsx` (new), `src/routes/RecordPage.tsx`: on an automation's page, the sentence, numbered actions, Turn on / Pause, a note when the daily limit is 0, and run history.
- `ops/authority/inventory.json`, `inventory.test.ts`, `service-sweeps.mjs`: 12 inventory rows; the scheduled target and cron are now checked; readonly and mask sweep calls for the new surface.
- `convex/automations.test.ts` (new, 19 tests); `convex/identity.test.ts`: the standard object list now ends with `automation`.

## How it works, in short

An agent drafts an Automation record through the generic record tools, for example: when `fieldChanged`, object `opportunity`, field `stage`, equals `won`, actions:

```json
[{"type":"createRecord","object":"project","values":{"name":"Delivery: {{record.name}}","company":"{{record.company}}","status":"active"}},
 {"type":"createTask","title":"Kickoff call with {{record.name}}","dueInDays":1,"about":"trigger","values":{"project":"{{created.project}}"}}]
```

Every write checks the definition and refuses what an automation may not do, with the reason. The agent can dry-run it on a real record (`POST .../test`), which returns the sentence ("When an Opportunity's Stage becomes Won, create a Project and 3 Tasks"), each step with resolved values, and any problems. A person turns it on, from the page or by setting status. From then on, a matching create or update queues a run. The minute cron queues `dateReached` and `schedule` runs. Each run executes all its actions in one mutation, through applyChange, as the person who turned it on. Events carry actor `{ kind: "automation", id: <automation record id> }` and the reason `Automation "<name>", turned on by <person>`. Run rows record that person, the trigger record, the event, the depth and the created record ids.

## Decisions and why

1. **Actions JSON uses `"type"`** (`createRecord`, `updateTrigger`, `createTask`, `inbox`, `linkTrigger`), max 10. This is the most guessable shape for agents. Unknown types are refused with the list. Names that look like delete, send, mail, post, publish, book, webhook, http, sms, message, call or notify get a specific reason ("automations cannot delete anything", "cannot send, publish or book anything; a person does that").
2. **Gated statuses.** Writing `status` on `email`, `post`, `campaign` or `booking` (create or updateTrigger) is refused. Creating or changing `automation` records from an action is refused, and an automation cannot watch the `automation` object.
3. **Templates.** `{{record.<field>}}`, `{{record.id}}`, `{{record.<dateField>±N}}` (whole days from that date, so "the day before the booking" works), `{{today}}`/`{{today±N}}` (UTC midnight), and `{{created.<objectKey>}}` (the record an earlier action created). The brief only had `{{created}}` implicitly. Without the object key, "a project and its three tasks" cannot point every task at the project. A value that is exactly one tag keeps its type (an id, a date, a number); text with tags becomes text, with labels for selects and titles for lookups. A tag reads a field only if the person it runs as can read it. Unknown tags are refused when saved.
4. **createTask** takes `title`, optional `dueInDays` (all-day, from today UTC), `about: "trigger" | "created"`, and optional `values` for any other task field (used for `project`). **linkTrigger** `{field}` points the last created record's lookup (or adds to its links) back at the trigger record. Its field must be able to point there.
5. **Matching.** `recordCreated` fires on create only, filtered by `field` + `equals` when both are set. `fieldChanged` fires when the stored value really changes and, if `equals` is set, the new value matches. A create counts as a change from empty. `equals` matches a select by option id or label, case-insensitively, and anything else as text. `dateReached` fires for records whose date falls on today minus `offsetDays` (negative means before). It uses the date's slot index when there is one, at most 200 records per automation per tick.
6. **Schedules** are `daily HH:MM` or `weekly mon HH:MM`, UTC. Orgs have no time zone field yet, so it is always UTC, as the brief allows. A schedule time from before the automation was turned on does not fire. Turning it on at 15:00 does not run that day's 09:00 slot late.
7. **Dedupe keys:** `<automation>:<eventId>` for record events, `<automation>:<record>:<UTC day>` for dates, and `<automation>:day:<UTC day>` for schedules. A run row exists once per key, and `execute` only acts on a queued run, so a retried job does nothing.
8. **One queue per automation.** Runs execute one at a time, oldest first. Only the first queued run schedules a job; that job works through the queue, 100 per job, then continues in a fresh job. This keeps one big write (an import batch, a bulk edit) from scheduling one job per record; Convex caps scheduled functions per mutation. It also makes "3 failures in a row" mean the same thing every time. The minute cron restarts a queue whose oldest queued run is over 10 minutes old (a crashed job or deploy). This was not in the brief.
9. **All-or-nothing runs.** `execute` runs every action in one mutation. If any action throws, the whole run is undone, and `failed` records the error in a separate mutation. A failed run leaves no half-made project.
10. **No loops, depth 3.** A run carries its chain of automation ids. Its writes never trigger an automation already in the chain, itself included, and there is no history row for that skip. A run that would be depth 4 is recorded as skipped ("Stopped: automations can set each other off at most 3 deep"), so the person can see why.
11. **Caps.** `REMOLD_AUTOMATION_DAILY_CAP` is per workspace per UTC day. Missing or invalid means 0, and nothing runs: runs are kept as skipped with "Automations are off on this server: the daily limit (REMOLD_AUTOMATION_DAILY_CAP) is 0". The per-automation cap is a constant 200 per day. Done and failed runs count; skipped and refused runs do not. A capped day's dateReached or schedule run is skipped, not retried the next day.
12. **Authority at run time.** The state row keeps the member id and authority epoch from when the person turned it on. Each run rebuilds that person through `currentPrincipal`. A role change (which bumps the epoch), removal, or a read-only workspace refuses the run and pauses the automation, with an inbox item ("... no longer has the access they had when turning it on. Turn it on again to run it as you."). A trigger record the person cannot read is refused for that run only, without pausing. Read scopes and hidden fields apply through applyChange and value resolution, as for the person.
13. **Who may turn on.** Any member who can write may turn one on. It then runs with that member's own access, not an admin's, and email approval stays admin-only. Agents can draft, edit and pause, never turn on. That covers direct changes and proposals: a proposal to turn one on is refused at proposal time, like post approval. Editing `when/object/field/equals/offsetDays/schedule/actions` of an `on` automation, by anyone, drops it to paused in the same write. Renaming does not.
14. **Engine bookkeeping is written directly.** `lastRun` and the engine's own pause are patched directly, not through applyChange. The pause writes an attributed event (actor = the automation). This is needed because a pause must work in a read-only workspace, and `lastRun` must not count as editing the automation or trigger anything. It is the one place outside applyChange that writes record values.
15. **Inbox items** from an `inbox` action or a pause come `from` the person who turned it on, `source: "automation"`, audience `author`. They are visible to that person and unrestricted members, and linked to the trigger record or the automation. The `agentInbox.from` union was not widened, because that would break rollback.
16. **Failure count** resets on a successful run. The third failure in a row pauses the automation and leaves an inbox item with the last error.
17. **Dry run is a query.** `POST .../test` is served by an internal query, so it cannot write. It renders and resolves values exactly as a run would, as the calling agent. New records are stood in by "(the new Project)". It is POST, so the agent write rate limit applies; the inventory marks it `not-a-write`.
18. **`emailRules` tightened**, see "What changed". Campaign tests still pass.

## New env vars

- `REMOLD_AUTOMATION_DAILY_CAP`: runs per workspace per UTC day. Missing, 0 or invalid means automations never run.

## Fail before, pass after

- `convex/automations.test.ts` against the base code: `Tests 18 failed (18)`, each failing because there is no `automation` object (`fail-before.txt`). The 19th test ("one write that sets off many runs schedules one job, and a queue whose job died is picked up by the cron") was added after the first implementation. It fails on base for the same reason. Mutants M22 and M23 below show it catches the bug it was written for: one job per run, and no recovery.
- After: `Tests 19 passed (19)`. The tests, one behavior each:
  - new and older workspaces get the Automation object, and a second seed changes nothing
  - a new automation is a draft, an agent can draft and pause but never turn one on, and a person can
  - editing what an on automation does pauses it; renaming it does not
  - only a complete automation can be turned on
  - refuses actions that delete, send, publish or change an approval status, and more than 10 actions
  - when a deal is won, creates the delivery project and its three tasks once, as the automation for the person who turned it on (also: won to won, and lost, do not fire; winning again does)
  - recordCreated fires once per created record, not on updates
  - dateReached fires once on the day the offset lands on, however often the clock ticks
  - a schedule fires once a day at its time, or once a week on its day, and not for times before it was turned on
  - a run happens once even when its job is retried or ticks overlap
  - a run's own writes never trigger it again, and chains stop at depth 3
  - nothing runs without the deployment's daily cap, and runs stop at the workspace cap and at 200 per automation
  - one write that sets off many runs schedules one job, and a queue whose job died is picked up by the cron
  - acts with the permissions of the person who turned it on, and pauses when they lose them or the workspace is read only
  - a run that fails writes nothing, and three failures in a row pause the automation with an inbox item
  - a success between failures resets the count
  - the dry run shows what the actions would write for a record and writes nothing (dumps records, events, runs, inbox, links and state before and after)
  - run history is readable by agents over REST and MCP, attributed to the trigger, the person and what was created (uses the real `RemoldClient` against the real HTTP router)
  - runs from a cron every minute
- Mutants (`mutants.mjs`, output `mutants.txt`): 29 deliberate breaks, one rule each. **29/29 caught.**

## Full suites

| Suite | Baseline aa68030 | After |
|---|---|---|
| `pnpm test` | 51 files, 398/398 | 52 files, **417/417** |
| `pnpm typecheck` | clean | **clean** |
| `pnpm test:authority` | 101/101 | **101/101** (inventory covers the 12 new rows, the new cron and scheduled target) |
| `pnpm verify:release` | 37/37 | **37/37** |
| `pnpm build` | ok | **ok** (`✓ built`) |
| `pnpm --dir packages/mcp test` | not run (tests unchanged) | **6/6** |

(`baseline.txt`, `after.txt`, produced with `suites.sh`.)

## SERVICE (local backend, synthetic)

- `I1_SUITES=sweeps pnpm proof:authority` (`service-sweeps.log`): **PASS** "Readonly workspace refuses every public human write and every agent REST write", including `"automations:setOn":"refused: Workspace is read only"`. The mask sweep then stops on `No mask sweep call for events:timeline`. That is pre-existing: `events:timeline` and 10 other public queries exist at base with no sweep call.
- The same suite with that assertion temporarily turned into a log line, then restored (`service-sweeps-masks-narrowed.log`): all three sweeps **PASS**, with `automations:view` and agent `GET automations/<id>/runs` in the mask sweep. The 11 pre-existing gaps are listed as `PREEXISTING`.
- `screenshot.mjs` (`screenshot.log`), against the real runner and scheduler: the agent drafted the automation (status `draft`). Its attempt to turn it on got `403 Only a person can turn on an automation`. The dry run returned 4 steps and 0 problems. A person turned it on and won the deal. The run was `done` and created "Delivery: Acme website, Kickoff call with Acme website, Send the welcome pack, First check-in". The agent read the run `as Sam Rivera`. Clicking Pause set it to `paused`. Non-local requests: none.

## Screenshots

- `automation-record-page.png`: the sentence, the four actions in words, On with a Pause button, and run history (Done, for Acme website, as Sam Rivera, with what it created). The timeline shows the agent creating it and the person turning it on.
- `automation-paused.png`: after clicking Pause. It shows Turn on, the note that it runs as you and that changing it pauses it, and the Paused event in the timeline.
- Identity is a local JWT stub (WorkOS is not used locally), as in Job C.

## Rollback compatibility

The schema change is additive: three new tables and one new standard object through the idempotent seed. No existing table or field changes. Exercised (`rollback.mjs`, `rollback.log`, SERVICE local backend):

1. This build seeded the Automation object. An agent drafted an automation, a person turned it on, and a won deal ran it.
2. The previous release's `convex/` (aa68030) was pushed over the same data: `functions ready`. The old code listed all objects including `automation`, read the project the automation created and its history (actor shown as the raw automation id), and created and edited records. Agent `/me` worked. `/automations/<id>/runs` returned 404, as expected.
3. Forward again: the automation is still `on` and its run history is intact.

So yes, the previous release runs against data written by this one. While rolled back, automation records are plain records: nothing runs, and the old code does not enforce the turn-on rule. If an agent set status `on` under the old release, the record would say "on" with no state row, and it would not run until a person pauses it and turns it on again under this build.

## Owner setup to go live

1. Set `REMOLD_AUTOMATION_DAILY_CAP` on the production deployment, for example 200. Until then every run is skipped with a reason, and the automation page says the limit is 0.
2. `pnpm deploy:prod`, then run `seed:ensureStandard` for each existing org so it gets the Automation object (the same step as for earlier standard objects).
3. Nothing else: no new accounts, providers or secrets.

## Left undone or uncertain

- Time zones: schedules and dates are UTC because orgs have no time zone field.
- No query or "for each matching record" action. The brief's third example ("every Monday, put deals quiet for 14 days in the inbox") can only be a fixed inbox reminder on a schedule. A list of the quiet deals would need a new action kind.
- A run's history row keeps the `enabledBy` from when it was queued. If someone else turns the automation on again before it runs, it runs as the new person, but the row still names the earlier one.
- `dateReached` reads at most 200 matching records per automation per tick. A field without a slot scans up to 5000 records of that object each minute; standard date fields have slots.
- Stuck-queue recovery can start a second job on a long queue that is still being worked (oldest queued run over 10 minutes old). Both jobs only execute queued runs, so nothing runs twice. Only the ordering of failures across the two could interleave.
- The per-automation cap (200/day) is a constant, not a setting.
- The Actions field in the generic field list shows raw JSON. People edit it there; the panel above it is the readable version.
- `api.d.ts` was hand-edited (codegen needs a deployment).
- The pre-existing SERVICE mask-sweep gaps above.
- Not independently verified.

## Round 2 (after Fable's REVISE on 9137dc0)

Commits: b929988 merges origin/integ/campaigns (4bce955) and covers S1 and S2. The next commit has the rest; see `git log -1 remold/automations`. Level: unit plus SERVICE (local backend) for rollback. Not independently re-verified.

### Fixes

- **B1 (blocker), the hidden-field oracle.** New `triggerAccess` in `convex/lib/automation.ts`. The person an automation runs as must read every record of the watched object (all-record scope). They must also read the field it watches, for fieldChanged and dateReached, or matches on, for recordCreated with field and equals.
  - At turn-on, a person who cannot is refused with `To turn this on you need to see every opportunities and their amount, because it runs as you`.
  - Every run re-checks this in `runAs` (`convex/automations.ts`). A run that fails the check is refused, and the automation pauses.
  - The verifier's probe P1 is now a test: Ben, with amount hidden, cannot turn on `fieldChanged amount equals 1000000`. The same goes for recordCreated matching on amount, dateReached on a hidden closeDate, and an object outside his scope (P4).
  - The old per-record `canReadRecord` check in `step()` (verifier mutant M-a) was removed. It was dead code: all-record scope is now required on every run, and mutants R3 and R4 test that requirement.
  - Templates still read hidden fields as empty. That is now tested; mutant R5 is the verifier's M-b.
- **S4, refused means paused.** Every refusal (access changed, read-only workspace, cannot read what it watches) records the run as refused, pauses the automation at once and leaves one inbox item. Runs already queued behind it are then skipped with "The automation was not on". It never stays on refusing.
- **S1, merge with 4bce955.** Six conflicts resolved. `emailCheck` now treats only the actor `{ kind: "automation", id: "Campaign email" }` as the sender, for both Sending/Sent and the admin-approval bypass, so an automation record's actor is not the engine. The automation hooks are back in the merged applyChange. The inventory keeps all 259 rows from integ/campaigns plus my 12 (271).
- **S2, the chain through nested writes.** The withdraw write (an approved email edited goes back to draft) carries `options.automation`. So do the reference and link cleanup writes on delete. The test: an automation fires on email status and appends " (checked)" to the body. Approving sets it off once; the withdrawal it causes does not set it off again. The body has one " (checked)" and the email is back to draft.
- **S3, proven, no new gate.** Test: an automation adds a stranger to an active campaign after its first email was approved. Over three days of ticks only Ava and Ben are sent to, and the report shows `added: 1`. The approval snapshot holds.
- **Dry run.** While an automation is on, the dry run renders as the person who turned it on. As a draft or paused, it renders as the caller. The response says which: `renderedAs: { who: "enabler" | "caller", name }`. If the enabler would be refused, the dry run says so. The MCP instructions and tool description say this, and that a person needs full read on the watched object and field to turn one on.
- **`lastRun` is a direct patch, with no event and no `updatedAt` change** (verifier probe P5). It is engine bookkeeping, like the email sender's counters. This is the one record-value write outside applyChange. The engine's pause is also a direct patch, but it writes an attributed event. Shakur should accept this knowingly; the alternative is an event on every run.
- **Tick scans bounded and indexed.**
  - Schedules: each state row keeps `dueAt`, the next due time. The tick reads only due rows through index `by_due` (on, when, dueAt), at most 200 per minute, then moves `dueAt` to the next occurrence. A tick that runs late fires once, not once per missed day.
  - Dates: the tick takes the 100 date automations scanned longest ago through `by_scan` (on, when, scannedAt). It stamps them, then reads each date's slot index for one day, at most 200 records per automation.
  - A dateReached on a date field without an index slot is now refused when saved, which removes the 5,000-record scan.
  - Schema change: two optional fields on `automationState` and two indexes replacing `by_when`. This is additive for data.

### Scale limits (stated)

Per minute: 200 due schedules; 100 date automations (each reached about every N/100 minutes when there are N); 200 matching records per date automation per day; a stuck-queue sweep over 100 rows. Per automation: runs one at a time, 100 per job before handing on, 200 per day. Per workspace: `REMOLD_AUTOMATION_DAILY_CAP` runs per day. Per write: one scheduled job per automation it sets off.

### Fail before, pass after

- `round2-fail-before.txt`: the three new automation tests run against the pre-fix code (automations.ts, lib/automation.ts and schema.ts from b929988) give `3 failed | 19 passed (22)`. After: `22 passed (22)`.
  - a person cannot turn on an automation whose trigger reads what is hidden from them
  - a run is refused and the automation paused at once when the person can no longer read what it watches
  - fields hidden from the person it runs as read as empty in its templates and its dry run
- Three new tests in `convex/campaigns.test.ts` ("automations and campaign email"). S1 and S2 were fixed inside the merge commit, so their fail-before is shown by mutants R9 and R10 rather than a run on older code:
  - people an automation adds to an active campaign never get an email approved before they were added
  - an automation that edits an approved email withdraws the approval once and is not set off again by the withdrawal
  - an automation record's actor is never the sender: it cannot set Sending or Sent, nor approve as a member
- Mutants (`mutants.mjs`, `mutants-round2.txt`): **38/38 caught.** That is 28 from round 1, updated to the new code, and 10 new: R1 to R4 (B1 at turn-on, at run time, field, record scope), R5 (template masking, the verifier's M-b), R6 (S4 pause), R7 (dry run as the enabler), R8 (schedule due time), R9 (S1) and R10 (S2). Round-1 M17 is replaced by R6. Verifier M-c (the person check in automationRules) is still redundant with agentGuard on every path, so it is not in the list.

### Suites (round 2)

| Suite | integ/campaigns 4bce955 | After |
|---|---|---|
| `pnpm test` | 469 (488 after the merge, minus my 19) | **494/494** (55 files) |
| `pnpm typecheck` | clean | **clean** |
| `pnpm test:authority` | 101/101 | **101/101** |
| `pnpm verify:release` | 37/37 | **37/37** |
| `pnpm build` | ok | **ok** |
| `pnpm --dir packages/mcp test` | 8/8 | **8/8** |

(`after-round2.txt`)

### Rollback (round 2)

`BASE=4bce955 node evidence/2026-10-03-campaigns/I/rollback.mjs` (`rollback-round2.log`) ran against the integ/campaigns head. The old functions loaded ("functions ready"), the old code read and wrote records, and runs returned 404. Forward again: the automation is still on and its run is intact. `rollback.mjs` now raises git's output buffer, because the convex/ archive grew.

### Still open

- The screenshots are from round 1 and were not retaken. The page is unchanged apart from the refusal message on Turn on.
- `GATED` names `booking`, which does not exist yet. When Job B merges, check which booking fields an automation must not write (verifier N4).
- Not independently re-verified.

## Round 3 (after Fable's round 2 REVISE on 61643da)

Level: unit. Not independently re-verified.

### Fixes

- **B2 (blocker): the dry run showed the caller fields hidden from it.** The dry run still renders as the person who turned the automation on while it is on, so it stays faithful. What it returns is now limited to what the caller can read (`viewer` in `perform`, `convex/automations.ts`):
  - A template tag that reads a field the caller cannot read shows `(hidden from you)` instead of its value, whether the tag is the whole value or part of a text.
  - Step values are shown through the caller's `readableMap`. Any written field the caller cannot read shows `(hidden from you)`.
  - Lookup titles and the updated record's reference are read as the caller.
  - The caller must still be able to read the record it names; otherwise it gets 404, as for a record that does not exist. That check is mutant D1.
  - The verifier's probe P8 is now a test: amount is masked from the agent, and no `5000` appears anywhere in the response. The test covers an inbox step, a created record and an update step.
- **S5: a narrowed enabler queues nothing.** `enqueue` (`convex/lib/automation.ts`) compares the stored member epoch with the member's current one. If the role, scope or masks changed, or the member is gone, it queues no run and pauses the automation with the inbox item. There is no run row at all, so nothing records which record matched.
  - A run already queued when access changes is still refused at run time, as before.
  - A refused run now drops `triggerRecordId` and `eventId` from its row, and `history` never shows a trigger on a refused row.
  - The verifier's probe P7 is now a test: after amount is hidden from Ben, "Secretly big" is not in anything Ben can see, there are no runs, and the automation is paused.
- **Behavior change:** demotion or removal after turn-on now pauses at the next matching write without a refused row. A refused row appears only when the change lands between queueing and running. The permissions test now covers both paths.
- `pause` and `patchValues` moved to `convex/lib/automation.ts` so `enqueue` can pause. `lastRun` is unchanged: still a direct patch with no event.

### Fail before, pass after

- `round3-fail-before.txt`: the current tests against the round 2 code (automations.ts and lib/automation.ts from 61643da) give `3 failed | 21 passed (24)`. After: `24 passed (24)`.
  - the dry run never shows the caller a field or record it cannot read, even when it renders as the person who turned it on
  - once the person it runs as has narrower access, matching writes queue no run and the automation pauses without naming the record
  - acts with the permissions of the person who turned it on, and pauses when they lose them or the workspace is read only (updated for S5)
- Mutants (`mutants.mjs`, `mutants-round3.txt`): **43/43 caught.** The five new ones:
  - D1: no caller read check on the record
  - R11: templates use the enabler's reads
  - R12: step values use the enabler's reads
  - R13: a stale enabler still queues runs
  - R14: a refused row keeps its trigger

  Two mutants were adjusted to the moved code: M20 now targets the lib, and R6 the new refuse line. M15 (epoch snapshot ignored at run time) survived the first run, because the new enqueue check made its only test path unreachable. It is caught now by the queued-then-demoted case.

### Suites (round 3)

| Suite | Result |
|---|---|
| `pnpm test` | 55 files, **496/496** |
| `pnpm typecheck` | **clean** |
| `pnpm test:authority` | **101/101** |
| `pnpm verify:release` | **37/37** |
| `pnpm build` | **ok** |
| `pnpm --dir packages/mcp test` | **8/8** |

(`after-round3.txt`)

### Not redone

- Rollback: round 3 has no schema change, and the round 2 rollback stands.
- Screenshots: the page is unchanged.

## Round 4 (after Fable's round 3 PASS, small items before merge)

- **S6:** the dry run now checks that the caller can read the named record before it checks the record's object. An unreadable record of any object, and a record that does not exist, all get `404 Record not found`. Only a caller who can read the record learns that it is of the wrong object (400). This is probe P9.
- **S7:** `pause` re-reads the state row and does nothing if it is already off. A tick that meets several due records for a stale enabler now pauses once, with one inbox item and one event. This is probe P11.
- **V5:** probe P10 was adopted as a test. Lookup titles and date arithmetic from fields or objects the caller cannot read stay masked in the dry run.
- Fail before (`round4-fail-before.txt`): with the three new tests on the round 3 code, the result is `2 failed | 25 passed (27)`. The P9 and P11 tests fail. The P10 test passes there, because the masking it covers was already in place; mutant V5, which renders titles as the enabler, turns it red. After: `27 passed (27)`.
- Mutants: **46/46 caught** (`mutants-round4.txt`). That includes R15 (S6 order), R16 (S7) and V5. D1 was retargeted at the new read check.
- Suites (`after-round4.txt`):

| Suite | Result |
|---|---|
| `pnpm test` | 55 files, **499/499** |
| `pnpm typecheck` | **clean** |
| `pnpm test:authority` | **101/101** |
| `pnpm verify:release` | **37/37** |
| `pnpm build` | **ok** |
| `pnpm --dir packages/mcp test` | **8/8** |
