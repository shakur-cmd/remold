import assert from "node:assert/strict";
import { readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { deployment, run, scope, streamLogs, reconciled } from "./cli.ts";
import { fixture, expected } from "./fixture.ts";
import { evaluate, type Sample } from "./telemetry.ts";

const target = deployment();
const oracleFile = JSON.parse(readFileSync("bench/expected.json", "utf8")) as { deployment: string } & Record<string, ReturnType<typeof expected>>;
assert.equal(oracleFile.deployment, target, "bench/expected.json was written for a different deployment; run pnpm seed here first");
const stamp = new Date().toISOString().replaceAll(":", "-");
const logPath = `bench/results-${stamp}-logs.jsonl`;
const fd = openSync(logPath, "wx");
const logger = streamLogs(fd);
const samples: Sample[] = [];
let report: object = { status: "UNVERIFIED" };

// `convex logs` only streams events that happen after its first poll. Prove it
// is receiving before any measured sample runs, and fail fast if it never does.
async function awaitLogStream() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const sampleId = `probe-${randomUUID()}`;
    run("bench:sample", { ...scope("slots"), query: "score", cursor: null, sampleId });
    await delay(2_000);
    if (readFileSync(logPath, "utf8").includes(sampleId)) return;
  }
  throw new Error("The log stream never reported a probe sample. Check that `convex logs --jsonl --success` works for this deployment.");
}

try {
  await awaitLogStream();
  for (const option of ["slots", "values"] as const) {
    assert.deepEqual(expected(reconciled(option)), oracleFile[option], `${option}: live inventory disagrees with bench/expected.json`);
  }
  for (const option of ["slots", "values"] as const) {
    const oracle = oracleFile[option]!;
    for (let iteration = 1; iteration <= 3; iteration++) {
      for (const query of ["score", "won", "contacted", "page2"] as const) {
        let cursor: string | null = null;
        if (query === "page2") cursor = run<{continueCursor: string}>("bench:page", { ...scope(option), query: "score", cursor: null }).continueCursor;
        for (let i = 0; i < 20; i++) {
          const sampleId = randomUUID();
          const result = run<{ page: {_id: string}[]; serverActionElapsedMs: number }>("bench:sample", {
            ...scope(option), query: query === "page2" ? "score" : query, cursor, sampleId,
          });
          assert.deepEqual(result.page.map(r => r._id), oracle[query]);
          samples.push({ sampleId, option, query, run: iteration, recovery: false, serverActionElapsedMs: result.serverActionElapsedMs });
        }
        console.log(`${option} run ${iteration}: ${query} correctness passed (20 samples)`);
      }
    }
    try {
      const row = fixture(1)[0]!;
      row.sourceId = 50_001;
      row.values.score = 10_000;
      const [inserted] = run<{ _id: string }[]>("bench:seedBatch", { ...scope(option), rows: [row] });
      const recoveryIds = [inserted!._id, ...oracle.score.slice(0, 49)];
      for (let i = 0; i < 20; i++) {
        const sampleId = randomUUID();
        const result = run<{ page: {_id: string}[]; serverActionElapsedMs: number }>("bench:sample", { ...scope(option), query: "score", cursor: null, sampleId });
        assert.deepEqual(result.page.map(r => r._id), recoveryIds);
        samples.push({ sampleId, option, query: "score", run: 4, recovery: true, serverActionElapsedMs: result.serverActionElapsedMs });
      }
    } finally { run("bench:removeRecovery", scope(option)); }
  }
  let measured: ReturnType<typeof evaluate> | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 15; attempt++) {
    try { measured = evaluate(samples, readFileSync(logPath, "utf8")); break; }
    catch (error) { lastError = error; await delay(1000); }
  }
  if (!measured) throw lastError;
  assert.equal(measured.rows.length, 520, "Both candidates need 240 baseline and 20 recovery samples each");
  assert.equal(measured.groups.length, 26, "Each candidate needs twelve baseline query groups and one recovery group");
  const passingOptions = (["slots", "values"] as const).filter(option => measured.groups.filter(g => g.key.startsWith(`${option}/`)).every(g => g.pass));
  report = { status: passingOptions.length ? "BUILDER_CHECK_PASSED_AWAITING_IV" : "FAILED", deployment: target, passingOptions,
    indexRangeEvidence: "Instrumented database calls (one indexed pagination plus each primary-key get); engine document counts and timings from raw logs.", ...measured };
  if (!passingOptions.length) process.exitCode = 1;
} catch (error) {
  report = { status: "UNVERIFIED_OR_FAILED", deployment: target, error: String(error), samples };
  process.exitCode = 1;
} finally {
  logger.kill("SIGTERM");
  closeSync(fd);
  writeFileSync(`bench/results-${stamp}.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
