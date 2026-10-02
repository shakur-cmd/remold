import { fail } from "../errors";

// A row's place in a newest-first list: later `at` first, then later creation, then larger id.
export type Pos = { _id: string; at: number; createdAt: number };
const ahead = (a: Pos, b: Pos) => (a.at !== b.at ? a.at > b.at : a.createdAt !== b.createdAt ? a.createdAt > b.createdAt : a._id > b._id);
// A stream returns its rows strictly behind `after` and not behind `until`, newest first. With
// `take` it must include the `take` newest such rows; extra rows are fine, the merge filters.
export type Stream<T extends Pos> = (after: Pos | undefined, until: Pos | undefined, take: number | undefined) => Promise<T[]>;

const encode = (prefix: string, p: Pos) => `${prefix}:${p.at}:${p.createdAt}:${p._id}`;
function decode(prefix: string, cursor: string | null | undefined): Pos | undefined {
  if (!cursor || cursor === `${prefix}:start`) return undefined;
  const m = /^([a-z]+):(-?\d+(?:\.\d+)?):(\d+(?:\.\d+)?):([A-Za-z0-9_]+)$/.exec(cursor);
  if (!m || m[1] !== prefix) fail("VALIDATION", "Invalid cursor");
  return { at: Number(m[2]), createdAt: Number(m[3]), _id: m[4]! };
}

// Newest-first merge of streams, paged by position cursors. Like Convex's paginate, a page
// asked for with an endCursor returns every row from its cursor to that end, so a page the
// client has pinned grows or shrinks with writes instead of shifting rows into its neighbours.
export async function mergePage<T extends Pos>(prefix: string, streams: Stream<T>[], opts: { cursor: string | null; numItems: number; endCursor?: string | null }) {
  const after = decode(prefix, opts.cursor), until = decode(prefix, opts.endCursor);
  const rows = async (a: Pos | undefined, u: Pos | undefined, take: number | undefined) => {
    const seen = new Set<string>(), out: T[] = [];
    for (const row of (await Promise.all(streams.map(stream => stream(a, u, take)))).flat()) if ((!a || ahead(a, row)) && (!u || !ahead(u, row)) && !seen.has(row._id)) { seen.add(row._id); out.push(row); }
    return out.sort((x, y) => (ahead(x, y) ? -1 : 1));
  };
  const n = Math.max(0, Math.floor(opts.numItems));
  const page = until ? await rows(after, until, undefined) : (await rows(after, undefined, n)).slice(0, n);
  const end = until ?? page.at(-1) ?? after;
  const isDone = !end || (await rows(end, undefined, 1)).length === 0;
  return { page, isDone, continueCursor: until ? opts.endCursor! : end ? encode(prefix, end) : `${prefix}:start` };
}

// Range on a descending index field for a stream keyed by it; rows tied with `after` come back too and the merge drops them.
export const bounded = (q: any, field: string, after: Pos | undefined, until: Pos | undefined) => { let b = q; if (until) b = b.gte(field, until.at); if (after) b = b.lte(field, after.at); return b; };
// A few spare rows cover ties with the cursor position.
export const fetch = <T>(query: { take(n: number): Promise<T[]>; collect(): Promise<T[]> }, take: number | undefined) => (take === undefined ? query.collect() : query.take(take + 3));

// A stream over rows already in memory.
export const listStream = <T extends Pos>(rows: T[]): Stream<T> => {
  const sorted = [...rows].sort((x, y) => (ahead(x, y) ? -1 : 1));
  return async (after, until, take) => sorted.filter(row => (!after || ahead(after, row)) && (!until || !ahead(until, row))).slice(0, take ?? sorted.length);
};
