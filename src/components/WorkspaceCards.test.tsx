import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import { BillingCard, DataCard, deleteArgs } from "@/components/WorkspaceCards";
import { Settings } from "@/routes/Settings";

const state = vi.hoisted(() => { import.meta.env.VITE_CONVEX_URL = "https://example.invalid"; return { billing: undefined as unknown }; });
vi.mock("convex/react", () => ({ useQuery: (ref: any) => (getFunctionName(ref) === "billing:status" ? state.billing : undefined), useAction: () => async () => ({}), useMutation: () => async () => null, useConvex: () => ({}) }));
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
  it("has export, import into a new workspace, and a delete that starts disabled and offers export first or the phrase", () => {
    const page = html(<DataCard org={org} />);
    expect(text(<DataCard org={org} />)).toMatch(/Export workspace.*Import into a new workspace.*Delete this workspace.*Export first.*DELETE WITHOUT EXPORT/);
    expect(page).toContain('aria-label="Workspace name to confirm deletion"');
    expect(page).toContain('aria-label="Type DELETE WITHOUT EXPORT to delete without an export"');
    expect(page).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Delete<\/button>/);
  });
});

describe("Settings page", () => {
  const settings = (role: string) => text(
    <Routes><Route element={<Outlet context={{ org, role, objects: [] }} />}><Route index element={<Settings />} /></Route></Routes>,
  );
  it("shows the subscription to everyone and the data controls to the owner only", () => {
    state.billing = { enabled: false, status: "past_due" };
    expect(settings("owner")).toMatch(/Subscription.*Past due.*Your data.*Delete this workspace/);
    expect(settings("admin")).toContain("Past due");
    expect(settings("admin")).not.toContain("Your data");
  });
});

describe("What the delete button sends", () => {
  const id = "org1" as never;
  it("sends the phrase as withoutExport, and nothing without the exact name", () => {
    expect(deleteArgs(id, "Acme Ltd", "Acme Ltd", false, "DELETE WITHOUT EXPORT")).toEqual({ orgId: id, confirmName: "Acme Ltd", withoutExport: "DELETE WITHOUT EXPORT" });
    expect(deleteArgs(id, "Acme Ltd", "acme ltd", false, "DELETE WITHOUT EXPORT")).toBeNull();
    expect(deleteArgs(id, "Acme Ltd", "Acme Ltd", false, "delete without export")).toBeNull();
  });
  it("sends only the name once an export was downloaded here, and stays off before that", () => {
    expect(deleteArgs(id, "Acme Ltd", "Acme Ltd", true, "")).toEqual({ orgId: id, confirmName: "Acme Ltd" });
    expect(deleteArgs(id, "Acme Ltd", "Acme Ltd", false, "")).toBeNull();
  });
});
