import { expect, test } from "vitest";
import { evaluate, type Sample } from "./telemetry";
const samples: Sample[] = Array.from({ length: 20 }, (_, i) => ({ sampleId: `test-sample-${i}-end`, option: "slots", query: "score", run: 1, recovery: false, serverActionElapsedMs: 80 }));
const logs = samples.map(sample => ({ kind: "Completion", identifier: "bench:page", executionId: sample.sampleId,
  logLines: [{ messages: [JSON.stringify({ marker: "REMOLD_BENCH", sampleId: sample.sampleId, indexRangeRequests: 1 })] }],
  executionTime: .08, cachedResult: false, usageStats: { databaseReadDocuments: 50 },
}));
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");
test("engine telemetry supplies milliseconds and document reads rather than client timings", () => {
  const result = evaluate(samples, jsonl(logs));
  expect(result.groups).toEqual([{ key: "slots/1/score/false", p50: 80, p95: 80, pass: true }]);
  expect(result.rows.every(r => r.documentsRead === 50)).toBe(true);
});
test("missing or cached telemetry cannot pass a performance gate", () => {
  expect(() => evaluate(samples, jsonl(logs.slice(1)))).toThrow("Missing");
  expect(() => evaluate(samples, jsonl(logs.map(l => ({ ...l, cachedResult: true }))))).toThrow("Invalid");
});
test("slow queries fail the timing gate even when IDs were correct", () => {
  expect(evaluate(samples, jsonl(logs.map(l => ({ ...l, executionTime: .251 })))).timingPass).toBe(false);
});
test("document limits and missing range evidence fail closed", () => {
  expect(() => evaluate(samples, jsonl(logs.map(l => ({ ...l, usageStats: { databaseReadDocuments: 32_000 } }))))).toThrow("over-limit");
  expect(() => evaluate(samples, jsonl(logs.map(l => ({ ...l, logLines: [{ messages: [JSON.stringify({ sampleId: l.executionId })] }] }))))).toThrow("Invalid");
});
