// @vitest-environment jsdom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { getFunctionName } from "convex/server";

// Two pending shape proposals; the impact preview of the first one throws.
const shape = (id: string, summary: string, preview: unknown) => ({ _id: id, _creationTime: 0, kind: "retireField", status: "pending", summary, details: [], preview, reason: "tidy", agentName: "shaper", paused: false, error: null, resolvedAt: null });
vi.mock("convex/react", () => ({
  useQuery: (query: unknown, args: any) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(query as never);
    if (name === "suggestions:list" || name === "batches:list") return [];
    if (name === "shapeSuggestions:list") return args.status === "pending" ? [shape("a", "Retire field City on Venue", { objectId: "o1", fieldId: "broken" }), shape("b", "Retire field Kind on Venue", { objectId: "o1", fieldId: "f2" })] : [];
    if (name === "objects:impact") { if (args.fieldId === "broken") throw new Error("Too many bytes read"); return ["3 records of 3 hold a value."]; }
    return undefined;
  },
  useMutation: () => async () => ({}),
}));
vi.mock("react-router", async (original) => ({ ...(await original<typeof import("react-router")>()), useOutletContext: () => ({ org: { _id: "org1" } }) }));
const { Suggestions } = await import("./Suggestions");

it("a proposal whose impact preview fails says so in its own card, and the other proposals still show", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => { createRoot(host).render(<MemoryRouter><Suggestions /></MemoryRouter>); });
  expect(host.textContent).toContain("Retire field City on Venue");
  expect(host.textContent).toContain("Could not count what this touches: Too many bytes read");
  expect(host.textContent).toContain("Retire field Kind on Venue");
  expect(host.textContent).toContain("3 records of 3 hold a value.");
});
