export function fixture(count = 50_000) {
  let state = 20260922;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const stages: string[] = Array.from({ length: count }, (_, i) => {
    const percent = i / count;
    return percent < .4 ? "new" : percent < .7 ? "contacted" : percent < .85 ? "qualified" : percent < .95 ? "proposal" : "won";
  });
  for (let i = stages.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [stages[i], stages[j]] = [stages[j]!, stages[i]!];
  }
  return stages.map((stage, i) => ({ sourceId: i + 1, values: {
    score: Math.floor(random() * 10_000), stage, name: `Fictional job ${i + 1}`,
    email: `job${i + 1}@example.invalid`, city: "Demo City", category: "Service",
    amount: Math.floor(random() * 100_000), priority: i % 4, owner: `member-${i % 7}`,
    status: "open", description: "Synthetic benchmark record", revision: 1,
  } }));
}
export type Fixture = ReturnType<typeof fixture>[number];
export type ManifestRow = Fixture & { _id: string; _creationTime: number };
export function expected(rows: ManifestRow[]) {
  const recent = (a: ManifestRow, b: ManifestRow) => b._creationTime - a._creationTime || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0);
  const score = [...rows].sort((a,b) => b.values.score - a.values.score || recent(a,b));
  return {
    score: score.slice(0, 50).map(r => r._id),
    won: rows.filter(r => r.values.stage === "won").sort(recent).slice(0, 50).map(r => r._id),
    contacted: rows.filter(r => r.values.stage === "contacted").sort(recent).slice(0, 50).map(r => r._id),
    page2: score.slice(50, 100).map(r => r._id),
  };
}
