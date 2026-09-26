Fresh Opus 5.5 subagent review of A1 r1, 2026-09-26, read-only. Verdict: REVISE.
Findings (summary of the full reply, all 15 taken in r2):
1 High: draft written against main; on I1 fields ops use requireWriter + requireObjectAdministration, objects.create unrestrictedHuman. Apply must reuse them.
2 High: relation target only tenant-checked; require canReadObject at propose, requireObjectRead at apply; forbid same-proposal targets. Add S15.
3 High: field ops name fields the agent cannot see; require canReadField, same error as missing. Add S16.
4 High: final status (conflicted vs applied vs dismissed) is an oracle; agent sees pending|applied|closed only.
5 High: stale check wrong: mask narrowing bumps epoch not grant; admin epoch meaningless without client value. Use agent epoch equality + liveGrant + opsHash; immutable proposals; double-approve case.
6 Medium: issue() has no setup branch (falls to bindings), within() false. Explicit branch, delegate false, propose mode.
7 Medium: canPropose legacy branch returns true; setup must require concrete grant; S9 covers migrated v1 agents.
8 Medium: no cap on pending proposals (missing cap means zero); bound string lengths.
9 Medium: object.retire/restore has no enforcement anywhere; cut it.
10 Medium: field.restore needs slot rules; S8 barely fails as written.
11 Medium: one-click undo contradicts op list; cut.
12 Medium: basis hash adds friction; replace with per-op preconditions; merge conflicted into dismissed.
13 Medium: banning required:true for humans is a behavior change; limit to agents; seeding exempt or evented; S14 covers every path.
14 Low: metadata read already exists (agentApi.objects); reuse.
15 Low: mask proposals too; restricted admin and cross-agent cases.
Owner decisions: propose-only right (owner-only grant); replace workspace caps with ops-per-proposal and pending-per-agent numbers.
