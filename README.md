# Remold

A customizable CRM on Convex, built for service businesses and agents working as team members. AGPL-3.0-only.

**Status: Step 0 benchmark spike. There is no usable CRM yet.** No records design has passed the Cloud gate. The full approved roadmap is in [docs/build-plan.html](docs/build-plan.html).

## Local checks

Implementation is isolated on `spike/records`. Check out that branch first. Node 24+ and pnpm 11.23.0:

```sh
git checkout spike/records
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

## Cloud benchmark (dedicated development project only)

```sh
pnpm exec convex login
pnpm exec convex dev --configure new --once
# Select a new project named remold and a Cloud dev deployment.
pnpm seed
pnpm bench
```

The seed is deterministic and resumable, writes 50,000 records per candidate (plus 600,000 per-field rows for the value candidate), and reconciles every record against the independent TypeScript fixture before writing `bench/expected.json`. Check the deployment's available storage first. The seed never resets or deletes existing data. Use only a dedicated empty Cloud development project.

`pnpm bench` orchestrates all three runs, each with 20 samples per query, plus 20 recovery samples for each candidate. It refuses production configuration and checks the exact starting inventory. Raw server logs and measurements go to `bench/results-<timestamp>*`. Unique sample arguments avoid query-cache measurements. Engine times and document counts come from Convex completion logs; index-range requests are instrumented at each indexed pagination and primary-key read. These counts are application instrumentation, not a native engine range counter. Missing evidence fails the run.

The benchmark temporarily inserts synthetic source ID 50001 with score 10000 and removes only that fixture in `finally`. If the process is killed during recovery, explicitly run the internal `bench:removeRecovery` function for that candidate with orgId `remold-benchmark` and objectKey `customJob` before rerunning. There is no broad reset command.

The benchmark CLI has not yet been run end to end against Cloud. The telemetry parser is tested against fixtures shaped from Convex 1.46.0's log API type; actual live logs still need validation. The local `convex-test` runtime proves query behavior only, not engine performance or production limits.

## Review

See [handover.html](handover.html) for baseline, current evidence and gaps. An independent session must repeat the Cloud check on the same deployment; p50/p95 should match within the plan's 20% tolerance. Then record the selected candidate in the records ADR before implementing identity or application features.

No Clerk keys, real contact data, outbound messages, paid provisioning or EspoCRM migration are part of this spike.
