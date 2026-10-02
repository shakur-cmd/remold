import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { Shell } from "@/App";
import { SignInPage } from "@/routes/SignInPage";

vi.hoisted(() => { import.meta.env.VITE_CONVEX_URL = "https://example.invalid"; });
vi.mock("@/lib/identity", () => ({ useIdentity: () => ({ isLoading: false, signIn: async () => {}, signUp: async () => {} }), IdentityProvider: () => <p>signed-in app</p> }));
const at = (path: string) => renderToStaticMarkup(<MemoryRouter initialEntries={[path]}><Shell client={{} as never} /></MemoryRouter>).replace(/<[^>]+>/g, " ");

describe("terms and privacy", () => {
  it.each(["/terms", "/privacy"])("%s is public, marked as an unreviewed draft, and names the contact", (path) => {
    const text = at(path);
    expect(text).not.toContain("signed-in app");
    expect(text.trim().indexOf("Draft, not yet reviewed")).toBeLessThan(80);
    expect(text).toContain("shakur@codemyvibe.com");
  });

  it("privacy names where data lives and who processes it", () => {
    const text = at("/privacy");
    for (const fact of ["Convex", "United States", "WorkOS", "Resend", "export", "delete"]) expect(text).toContain(fact);
  });

  it("other paths still go to the app", () => {
    expect(at("/o/x/today")).toContain("signed-in app");
  });

  it("the sign-in page links to both", () => {
    const html = renderToStaticMarkup(<MemoryRouter><SignInPage /></MemoryRouter>);
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
  });
});
