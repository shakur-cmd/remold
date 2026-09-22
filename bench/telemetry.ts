export type Sample = { sampleId: string; option: string; query: string; run: number; recovery: boolean; serverActionElapsedMs: number };
type Completion = { kind: string; identifier: string; logLines: unknown[]; executionTime: number; cachedResult: boolean;
  usageStats: { databaseReadDocuments: number }; error?: string; executionId: string };
export function evaluate(samples: Sample[], logText: string) {
  const logs: Completion[] = logText.split("\n").filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as Completion]; } catch { return []; }
  }).filter(log => log.kind === "Completion" && /bench(?::|\.js:|\.ts:)page$/.test(log.identifier));
  const rows = samples.map(sample => {
    const matches = logs.filter(log => JSON.stringify(log.logLines).includes(sample.sampleId));
    const unique = [...new Map(matches.map(log => [log.executionId, log])).values()];
    if (unique.length !== 1) throw new Error(`Missing or ambiguous server telemetry: ${sample.sampleId}`);
    const log = unique[0]!;
    const strings = JSON.stringify(log.logLines).replaceAll('\\"', '"');
    const ranges = Number(strings.match(/"indexRangeRequests":(\d+)/)?.[1]);
    if (log.error || log.cachedResult || !Number.isFinite(log.executionTime) || log.executionTime < 0 ||
      !Number.isInteger(log.usageStats?.databaseReadDocuments) || log.usageStats.databaseReadDocuments < 0 ||
      log.usageStats.databaseReadDocuments >= 32_000 || !Number.isInteger(ranges) || ranges < 1 || ranges >= 4096) {
      throw new Error(`Invalid, cached, failed or over-limit telemetry: ${sample.sampleId}`);
    }
    return { ...sample, serverExecutionMs: log.executionTime * 1000, documentsRead: log.usageStats.databaseReadDocuments,
      instrumentedIndexRangeRequests: ranges, executionId: log.executionId };
  });
  const groups = [...new Set(rows.map(r => `${r.option}/${r.run}/${r.query}/${r.recovery}`))].map(key => {
    const timings = rows.filter(r => `${r.option}/${r.run}/${r.query}/${r.recovery}` === key).map(r => r.serverExecutionMs).sort((a,b) => a-b);
    if (timings.length !== 20) throw new Error(`Expected 20 samples: ${key}`);
    const p50 = timings[9]!, p95 = timings[18]!;
    return { key, p50, p95, pass: p50 < 100 && p95 < 250 };
  });
  return { rows, groups, timingPass: groups.length > 0 && groups.every(g => g.pass) };
}
