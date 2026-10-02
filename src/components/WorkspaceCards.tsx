import { useState } from "react";
import { useNavigate } from "react-router";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
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

function download(data: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `remold-${name.replace(/[^\w-]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(url);
}

// Delete stays off until the name is typed exactly and the export's sha256 is pasted, or, for a
// workspace too large to export, the exact phrase.
const NO_EXPORT = "DELETE WITHOUT EXPORT";
export const canDelete = (orgName: string, typed: string, proof: string) => typed === orgName && (/^[0-9a-f]{64}$/i.test(proof.trim()) || proof === NO_EXPORT);

export function DataCard({ org }: { org: Doc<"orgs"> }) {
  const convex = useConvex(), importAll = useMutation(api.workspace.importAll), confirmDelete = useMutation(api.workspace.confirmDelete);
  const navigate = useNavigate();
  const [confirmName, setConfirmName] = useState(""), [hash, setHash] = useState(""), [exported, setExported] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>, done: string) => { setBusy(true); const ok = await attempt(work, done); setBusy(false); return ok; };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your data</CardTitle>
        <CardDescription>One JSON file with every object, field, record and change. Import restores such a file into an empty workspace.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => { const data = await convex.query(api.workspace.exportAll, { orgId: org._id }); download(data, org.name); setExported(data.sha256); }, "Exported")}>Export workspace</Button>
          <label className="inline-flex">
            <Input type="file" accept="application/json,.json" className="sr-only" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void run(async () => importAll({ orgId: org._id, data: JSON.parse(await file.text()) }), "Imported"); }} />
            <span className="inline-flex h-8 cursor-pointer items-center rounded-md border px-3 font-medium hover:bg-accent">Import into this empty workspace</span>
          </label>
        </div>
        {exported && <p className="break-all text-muted-foreground">Export sha256: <code>{exported}</code></p>}
        <form className="grid gap-2 border-t pt-4" onSubmit={(e) => { e.preventDefault(); void run(async () => { await confirmDelete({ orgId: org._id, confirmName, ...(hash === NO_EXPORT ? { withoutExport: hash } : { sha256: hash }) }); navigate("/"); }, "Workspace deleted"); }}>
          <p className="font-medium text-destructive">Delete this workspace</p>
          <p className="text-muted-foreground">First export the workspace and keep the file. Then type <span className="font-medium text-foreground">{org.name}</span> and paste the export's sha256 (it is in the file) to prove you hold it. A workspace over 15,000 rows cannot be exported here: type {NO_EXPORT} in that box instead, or ask us for an export first. Everything is removed and this cannot be undone.</p>
          <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder="Workspace name" aria-label="Workspace name to confirm deletion" />
          <div className="flex gap-2">
            <Input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="Export sha256" aria-label="Export sha256 to confirm deletion" />
            <Button type="submit" variant="destructive" disabled={busy || !canDelete(org.name, confirmName, hash)}>Delete</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
