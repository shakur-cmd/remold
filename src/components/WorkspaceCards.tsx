import { useState } from "react";
import { useNavigate } from "react-router";
import { useAction, useQuery } from "convex/react";
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

export function DataCard({ org }: { org: Doc<"orgs"> }) {
  const exportAll = useAction(api.workspace.exportAll), importAll = useAction(api.workspace.importAll), remove = useAction(api.workspace.remove);
  const navigate = useNavigate();
  const [confirmName, setConfirmName] = useState(""), [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>, done: string) => { setBusy(true); const ok = await attempt(work, done); setBusy(false); return ok; };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your data</CardTitle>
        <CardDescription>One JSON file with every object, field, record and change. Import restores such a file into an empty workspace.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(async () => download(await exportAll({ orgId: org._id }), org.name), "Exported")}>Export workspace</Button>
          <label className="inline-flex">
            <Input type="file" accept="application/json,.json" className="sr-only" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void run(async () => importAll({ orgId: org._id, data: JSON.parse(await file.text()) }), "Imported"); }} />
            <span className="inline-flex h-8 cursor-pointer items-center rounded-md border px-3 font-medium hover:bg-accent">Import into this empty workspace</span>
          </label>
        </div>
        <form className="grid gap-2 border-t pt-4" onSubmit={(e) => { e.preventDefault(); void run(async () => { download(await remove({ orgId: org._id, confirmName }), org.name); navigate("/"); }, "Workspace deleted. Your export was downloaded."); }}>
          <p className="font-medium text-destructive">Delete this workspace</p>
          <p className="text-muted-foreground">Downloads the export first, then removes every record, field, member and agent. This cannot be undone. Type <span className="font-medium text-foreground">{org.name}</span> to confirm.</p>
          <div className="flex gap-2">
            <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} aria-label="Workspace name to confirm deletion" />
            <Button type="submit" variant="destructive" disabled={busy || confirmName !== org.name}>Delete</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
