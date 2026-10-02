import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";

const answers: Record<string, unknown> = {};
vi.mock("convex/react", () => ({ useQuery: (query: any) => answers[getFunctionName(query)], useMutation: () => async () => undefined }));
const { Home } = await import("./Home");
const render = (canCreate: boolean) => {
  Object.assign(answers, { "orgs:mine": [], "orgs:canCreate": canCreate });
  return renderToString(createElement(MemoryRouter, null, createElement(Home)));
};

describe("Home for a signed-in user with no organisation", () => {
  it("tells someone who may not create one that Remold is invite-only, with no create form", () => {
    const html = render(false);
    expect(html).toContain("invite-only");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Create your organisation");
  });
  it("shows a listed creator the create form", () => {
    const html = render(true);
    expect(html).toContain("<form");
    expect(html).toContain("Create your organisation");
    expect(html).not.toContain("invite-only");
  });
});
