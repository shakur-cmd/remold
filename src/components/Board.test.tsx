import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

// The board's queries, answered in memory: totals from `totals`, no cards loaded.
let totals: unknown;
vi.mock("convex/react", () => ({ useQuery: () => totals, useMutation: () => () => {}, usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: () => {} }) }));
const { Board } = await import("./Board");

const stage = { _id: "stage", key: "stage", label: "Stage", type: "select", options: [{ id: "new", label: "New" }, { id: "won", label: "Won" }] } as any;
const amount = { _id: "amount", key: "amount", label: "Amount", type: "number" } as any;
const object = { _id: "deal", key: "opportunity", titleFieldId: "name" } as any;
// Header text per column, keyed by its label.
const headers = (groups: { value: string | null; count: number; sum: number | null }[]) => {
  totals = { groups, partial: false, cap: 5000 };
  const html = renderToStaticMarkup(<MemoryRouter><Board orgId={"org" as any} object={object} groupBy={stage} fields={[stage, amount]} /></MemoryRouter>);
  return Object.fromEntries([...html.matchAll(/<h2[^>]*>(.*?)<span[^>]*>(.*?)<\/span><\/h2>/g)].map((m) => [m[1], m[2]!.replace(/<!-- -->/g, "")]));
};

describe("Board column totals", () => {
  it("shows $0 for a column whose amounts sum to zero", () => {
    const h = headers([{ value: "new", count: 2, sum: 0 }, { value: "won", count: 1, sum: 4500 }, { value: null, count: 0, sum: 0 }]);
    expect(h.New).toBe("2 · $0");
    expect(h.Won).toBe("1 · $4,500");
  });
  it("shows only the count when the amount is not readable", () => {
    expect(headers([{ value: "new", count: 2, sum: null }, { value: "won", count: 1, sum: null }, { value: null, count: 0, sum: null }]).New).toBe("2");
  });
});
