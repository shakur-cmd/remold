import { fail } from "../errors";

export type Merged = { _id: string; at: number; createdAt: number };
export type Stream<T extends Merged> = (until: number | undefined, take: number) => Promise<T[]>;

// Newest-first merge of streams, each returning its rows with `at` <= until, newest
// first. The cursor holds the `at` reached and the IDs already returned at exactly
// that value, so ties across a page boundary are neither repeated nor skipped.
export async function mergePage<T extends Merged>(prefix: string, streams: Stream<T>[], opts: { cursor: string | null; numItems: number }) {
  let until: number | undefined, seen: string[] = [];
  if (opts.cursor) { const m = /^([a-z]+):(-?\d+(?:\.\d+)?|start):(.*)$/.exec(opts.cursor); if (!m || m[1] !== prefix) fail("VALIDATION", "Invalid cursor"); until = m[2] === "start" ? undefined : Number(m[2]); seen = m[3] ? m[3].split(",") : []; }
  const n = Math.max(0, Math.floor(opts.numItems)), take = n + seen.length + 1;
  const rows = (await Promise.all(streams.map(stream => stream(until, take)))).flat().filter(row => !seen.includes(row._id));
  rows.sort((a, b) => b.at - a.at || b.createdAt - a.createdAt || (a._id < b._id ? 1 : a._id > b._id ? -1 : 0));
  const page = rows.slice(0, n), last = page.at(-1);
  const next = last ? last.at : until, carried = !last || next === until ? seen : [];
  const ids = [...carried, ...page.filter(row => row.at === next).map(row => row._id)];
  return { page, isDone: rows.length <= n, continueCursor: `${prefix}:${next ?? "start"}:${ids.join(",")}` };
}

// A stream over rows already in memory.
export const listStream = <T extends Merged>(rows: T[]): Stream<T> => {
  const sorted = [...rows].sort((a, b) => b.at - a.at || b.createdAt - a.createdAt);
  return async (until, take) => sorted.filter(row => until === undefined || row.at <= until).slice(0, take);
};
