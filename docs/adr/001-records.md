# Records storage: proposed, not selected

Step 0 compares two implemented candidates. Builder Cloud measurements now pass for both candidates; independent performance review remains pending. Neither is approved for production. See ../../convex-setup.html for results and raw evidence. The third option is rejected for this multi-tenant product unless later evidence changes the decision.

| Option | Benefits | Cost and constraints | Spike |
| --- | --- | --- | --- |
| Typed indexed slots on one records table | A page reads record documents directly. No secondary-row hydration. Index count and update work remain bounded. | Metadata must allocate a finite number of typed searchable slots. Arbitrary conjunctions, multiple sorts and slot exhaustion need explicit UI limits or additional index designs. | `slotRecords`, `n0` mapped to score, `s0` mapped to stage; remaining custom values in the payload. |
| Records plus per-field value rows | New fields require metadata and rows, without schema deployment. One generic value index orders arbitrary number/string fields. | Twelve extra documents per record in this fixture, plus writes/index storage and a record lookup per result. Composite filters still require a bounded query planner; this spike does not prove arbitrary joins. | `valueRecords` plus twelve `recordValues` rows per record; copied record creation time and ID preserve record tie order. |
| Schema regeneration per org | Native typed fields and purpose-built indexes. | Customer edits become schema deploys and backfills. Deployment-level schema is shared, with operational and index/table limits. This conflicts with no-code custom objects in one multi-tenant deployment. | Not implemented. |

Working preference is slots for fewer reads and writes, **conditional** on the measured results and a later explicit slot-allocation contract. Do not treat this preference as the decision.

Both candidates use the same fixture of 50,000 custom Job records with 12 values. The score generator uses a fixed 32-bit seed and numbers in 0..9999. The stage distribution is exactly 40/30/15/10/5 percent, shuffled deterministically. Source IDs are fixture identities; `_id` and `_creationTime` are captured from each deployed candidate. The independent oracle sorts the fixture and uses those captured system fields only for tie breaks. It never calls the database query implementation.

The explicit order is score descending, then record `_creationTime` descending, then record `_id` descending. Known risk, checked 2026-09-22: Convex documents that every index key ends with the document's creation time and ID, but not that creation times are unique within a mutation, nor that the engine's ID order equals the string order of `_id`. The oracle assumes string order. If the Cloud run disagrees, the correctness assertion fails closed and the tie-break rule (not the timings) is what needs revisiting. Stage equality queries use record creation time and ID descending. The value index copies record creation time and ID because value-row creation order must not change a record's position. Built-in index suffixes apply only after that unique record ID. Cursor page 2 must return IDs 51..100 from the independent oracle.

The runner reconciles the starting inventory, performs three runs of twenty samples for each query, inserts score 10000, checks the entire new top 50, then removes only that recovery fixture. Log output includes raw engine document reads and execution times, and instrumented database index-range calls. Engine-native index-range telemetry is not exposed in the installed SDK's completion-log type. Independent review must accept the instrumentation or obtain engine evidence; this remains an explicit gate limitation, not an inferred metric.

Sources checked 2026-09-22:
- https://docs.convex.dev/database/reading-data/indexes/
- https://stack.convex.dev/pagination
- https://docs.convex.dev/cli/overview
- Installed Convex 1.46.0 `src/cli/lib/generatedFunctionLogsApi.ts` for completion telemetry structure.

Seeding runs server-side through the `bench:seedRange` action so the fixture is generated once per range on the deployment instead of being pushed through hundreds of CLI processes; the oracle is still computed in plain TypeScript from the read-back inventory and never calls the query implementation.

Before: no repository, schema, fixture or benchmark. After: both prototypes and local correctness checks exist. The 2026-09-22 builder Cloud run passed all 520 samples across both candidates. The records decision remains pending independent repetition and range-evidence acceptance.
