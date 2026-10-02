import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { BillingCard, canDelete, DataCard } from "@/components/WorkspaceCards";

const state = vi.hoisted(() => ({ billing: undefined as unknown }));
vi.mock("convex/react", () => ({ useQuery: () => state.billing, useAction: () => async () => ({}), useMutation: () => async () => null, useConvex: () => ({}) }));
const org = { _id: "org1", name: "Acme Ltd" } as never;
const text = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const html = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe("Settings: subscription", () => {
  it.each([["active", "Active"], ["past_due", "Past due"], ["canceled", "Canceled"], [null, "No subscription"]] as const)("shows %s as %s", (status, label) => {
    state.billing = { enabled: true, status };
    expect(text(<BillingCard org={org} owner />)).toContain(label);
  });

  it("offers test-mode Checkout only to an owner, only when billing is on and not already active", () => {
    state.billing = { enabled: true, status: "canceled" };
    expect(text(<BillingCard org={org} owner />)).toContain("Subscribe (test mode)");
    expect(text(<BillingCard org={org} owner={false} />)).not.toContain("Subscribe");
    state.billing = { enabled: true, status: "active" };
    expect(text(<BillingCard org={org} owner />)).not.toContain("Subscribe");
    state.billing = { enabled: false, status: null };
    expect(text(<BillingCard org={org} owner />)).toMatch(/Billing is not switched on.*No subscription/);
    expect(text(<BillingCard org={org} owner />)).not.toContain("Subscribe");
  });
});

describe("Settings: your data", () => {
  it("has export, import, and a delete that starts disabled and asks for the name and the export sha256", () => {
    const page = html(<DataCard org={org} />);
    expect(text(<DataCard org={org} />)).toMatch(/Export workspace.*Import into this empty workspace.*Delete this workspace/);
    expect(page).toContain('aria-label="Workspace name to confirm deletion"');
    expect(page).toContain('aria-label="Export sha256 to confirm deletion"');
    expect(page).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Delete<\/button>/);
  });

  it("enables delete only for the exact name and a 64-hex sha256", () => {
    const hash = "a".repeat(64);
    expect(canDelete("Acme Ltd", "Acme Ltd", hash)).toBe(true);
    expect(canDelete("Acme Ltd", "acme ltd", hash)).toBe(false);
    expect(canDelete("Acme Ltd", "Acme Ltd", "a".repeat(63))).toBe(false);
    expect(canDelete("Acme Ltd", "Acme Ltd", "")).toBe(false);
  });
});
