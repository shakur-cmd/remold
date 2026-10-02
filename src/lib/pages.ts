import { useEffect, useMemo, useState } from "react";
import { useQueries } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { Value } from "convex/values";

type Page = { done: boolean; cursor: string | null };

// Follows a bounded query's continuation cursors. The server reads a limited
// number of rows per call and says whether it is done; until it is, the next page
// is asked for with the cursor it returned, up to `pages` pages (raised by
// loadMore). Every page stays a live query. `first` is the cursor of the first
// page (undefined: start at the beginning); null args fetch nothing.
export function useFollow<P extends Page>(query: FunctionReference<"query">, args: Record<string, Value> | null, first?: string, pages = 10) {
  const key = JSON.stringify([args, first]);
  const [state, setState] = useState({ key, cursors: [] as string[], max: pages });
  const { cursors, max } = state.key === key ? state : { cursors: [] as string[], max: pages };
  const chain = [first, ...cursors];
  // useQueries resubscribes whenever its argument object changes, so it must only change with its contents.
  const shape = JSON.stringify([getFunctionName(query), args, chain]);
  const queries = useMemo(() => (args ? Object.fromEntries(chain.map((cursor, i) => [String(i), { query, args: cursor === undefined ? args : { ...args, cursor } }])) : {}), [shape]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = useQueries(queries);
  const loaded = args ? chain.map((_, i) => results[String(i)] as P | Error | undefined) : [];
  for (const page of loaded) if (page instanceof Error) throw page;
  const last = loaded.at(-1) as P | undefined;
  const next = last && !last.done && last.cursor && !cursors.includes(last.cursor) && loaded.length < max ? last.cursor : null;
  useEffect(() => {
    if (next) setState({ key, cursors: [...cursors, next], max });
  }, [key, next]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    pages: loaded as (P | undefined)[],
    loading: loaded.some((page) => page === undefined) || !!next,
    // Pages left that were not asked for, because `pages` was reached.
    more: !!last && !last.done && !next,
    loadMore: () => setState({ key, cursors, max: max + pages }),
  };
}

export const uniqueById = <T extends { _id: string }>(rows: T[]) => [...new Map(rows.map((row) => [row._id, row])).values()];
