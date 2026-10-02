import { useState } from "react";
import { useNavigate } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { attempt } from "@/lib/errors";

const label = { active: "Active", past_due: "Past due", canceled: "Canceled" } as const;

export function BillingCard({ org, owner }: { org: Doc<"orgs">; owner: boolean }) {
  const billing = useQuery(api.billing.status, { orgId: org._id });
  const checkout = useAction(api.billing.checkout);
  if (!billing) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscription</CardTitle>
        <CardDescription>{billing.enabled ? "Stripe test mode: no real card is charged." : "Billing is not switched on."}</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-3 text-sm">
        <Badge variant="outline">{billing.status ? label[billing.status] : "No subscription"}</Badge>
        {billing.enabled && owner && billing.status !== "active" && (
          <Button size="sm" onClick={() => attempt(async () => { window.location.href = (await checkout({ orgId: org._id })).url; })}>Subscribe (test mode)</Button>
        )}
      </CardContent>
    </Card>
  );
}

async function save(url: string, name: string) {
  const blob = await (await fetch(url)).blob(), href = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"), { href, download: `remold-${name.replace(/[^\w-]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.json` }).click();
  URL.revokeObjectURL(href);
}

// What the delete button sends: the exact name, plus the phrase unless an export was just downloaded here.
// null keeps the button off.
export const NO_EXPORT = "DELETE WITHOUT EXPORT";
export function deleteArgs(orgId: Id<"orgs">, orgName: string, typed: string, exported: boolean, phrase: string) {
  if (typed !== orgName) return null;
  if (phrase === NO_EXPORT) return { orgId, confirmName: typed, withoutExport: phrase };
  return exported ? { orgId, confirmName: typed } : null;
}

export function DataCard({ org }: { org: Doc<"orgs"> }) {
  const exportAll = useAction(api.workspace.exportAll), uploadUrl = useMutation(api.workspace.importUploadUrl), uploaded = useMutation(api.workspace.importUploaded), importAll = useAction(api.workspace.importAll), confirmDelete = useMutation(api.workspace.confirmDelete);
  const navigate = useNavigate();
  const [typed, setTyped] = useState(""), [phrase, setPhrase] = useState(""), [exported, setExported] = useState(false), [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>, done: string) => { setBusy(true); const ok = await attempt(work, done); setBusy(false); return ok; };
  const args = deleteArgs(org._id, org.name, typed, exported, phrase);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your data</CardTitle>
        <CardDescription>One JSON file with every object, field, record and change, up to 64 MB. Importing a file creates a new workspace from it.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { await save((await exportAll({ orgId: org._id })).url, org.name); setExported(true); }, "Exported")}>Export workspace</Button>
          <label className="inline-flex">
            <Input type="file" accept="application/json,.json" className="sr-only" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void run(async () => { const { storageId } = await (await fetch(await uploadUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: file })).json(); await uploaded({ storageId }); navigate(`/o/${await importAll({ storageId })}`); }, "Imported into a new workspace"); }} />
            <span className="inline-flex h-8 cursor-pointer items-center rounded-md border px-3 font-medium hover:bg-accent">Import into a new workspace</span>
          </label>
        </div>
        <form className="grid gap-2 border-t pt-4" onSubmit={(e) => { e.preventDefault(); if (args) void run(async () => { await confirmDelete(args); navigate("/"); }, "Workspace deleted"); }}>
          <p className="font-medium text-destructive">Delete this workspace</p>
          <p className="text-muted-foreground">Removes every record, field, member and agent. This cannot be undone. Type <span className="font-medium text-foreground">{org.name}</span> to confirm.</p>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Workspace name" aria-label="Workspace name to confirm deletion" />
          {!exported && (
            <div className="grid gap-2">
              <p className="text-muted-foreground">You have not downloaded an export here. <Button type="button" variant="link" className="h-auto p-0" disabled={busy} onClick={() => run(async () => { await save((await exportAll({ orgId: org._id })).url, org.name); setExported(true); }, "Exported")}>Export first</Button>, or type {NO_EXPORT} to delete without one.</p>
              <Input value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={NO_EXPORT} aria-label="Type DELETE WITHOUT EXPORT to delete without an export" />
            </div>
          )}
          <div><Button type="submit" variant="destructive" disabled={busy || !args}>Delete</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}
