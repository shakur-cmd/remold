import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "convex/react";
import { getFunctionName, makeFunctionReference, type FunctionReference } from "convex/server";

export type PageSpec = { cursor: string | null; endCursor?: string; numItems: number };
type PageResult<T> = { page: T[]; isDone: boolean; continueCursor: string };

// Each loaded page is pinned to the end it first returned, so a later write makes that page
// grow or shrink in place and never shifts rows across a page boundary. A page that came
// back empty from the very start has no end yet and stays open.
export function pinPages<T>(pages: PageSpec[], results: (PageResult<T> | undefined)[]): PageSpec[] {
  let changed = false;
  const next = pages.map((spec, i) => {
    const result = results[i];
    if (spec.endCursor || !result || result.continueCursor.endsWith(":start")) return spec;
    changed = true;
    return { ...spec, endCursor: result.continueCursor };
  });
  return changed ? next : pages;
}

// Rows of every page up to the first one still loading, and the status usePaginatedQuery would report.
export function pageView<T>(pages: PageSpec[], results: (PageResult<T> | undefined)[]) {
  const items: T[] = [];
  for (let i = 0; i < pages.length; i++) {
    const result = results[i];
    if (!result) return { items, status: i === 0 ? ("LoadingFirstPage" as const) : ("LoadingMore" as const), next: null };
    items.push(...result.page);
  }
  const last = results[pages.length - 1]!, spec = pages[pages.length - 1]!;
  return last.isDone ? { items, status: "Exhausted" as const, next: null } : { items, status: "CanLoadMore" as const, next: spec.endCursor ?? last.continueCursor };
}

// usePaginatedQuery for a query that honours endCursor, with every loaded page pinned.
export function usePinnedPages<T>(query: FunctionReference<"query">, args: Record<string, any>, initialNumItems: number) {
  const key = JSON.stringify(args);
  const [state, setState] = useState<{ key: string; pages: PageSpec[] }>({ key, pages: [{ cursor: null, numItems: initialNumItems }] });
  const pages = state.key === key ? state.pages : [{ cursor: null, numItems: initialNumItems }];
  // useQueries resubscribes whenever its request object changes identity, and api references
  // are fresh objects on every access, so the request is keyed by content and function name.
  const specs = JSON.stringify(pages), name = getFunctionName(query);
  const request = useMemo(() => Object.fromEntries((JSON.parse(specs) as PageSpec[]).map((spec, i) => [String(i), { query: makeFunctionReference<"query">(name), args: { ...JSON.parse(key), paginationOpts: { numItems: spec.numItems, cursor: spec.cursor, ...(spec.endCursor ? { endCursor: spec.endCursor } : {}) } } }])), [name, key, specs]);
  const live = useQueries(request);
  // While a page re-subscribes with its new endCursor, keep showing what it last returned.
  const shown = useRef<Record<string, PageResult<T>>>({});
  if (state.key !== key) shown.current = {};
  const results = pages.map((_, i) => {
    const result = live[String(i)];
    if (result instanceof Error) throw result;
    if (result !== undefined) shown.current[String(i)] = result;
    return shown.current[String(i)];
  });
  useEffect(() => {
    const pinned = pinPages(pages, results);
    if (pinned !== pages || state.key !== key) setState({ key, pages: pinned });
  });
  const view = pageView(pages, results);
  return { results: view.items, status: view.status, loadMore: (numItems: number) => { if (view.next) setState({ key, pages: [...pages, { cursor: view.next, numItems }] }); } };
}
