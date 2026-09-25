import { useState, type FormEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { attempt } from "@/lib/errors";

type Grant = { action: "create" | "update" | "delete"; objectKey: string };
const ACTIONS = ["create", "update", "delete"] as const;
// The REST and MCP surface lives on the deployment's site URL.
const siteUrl = (import.meta.env.VITE_CONVEX_URL as string).replace(".convex.cloud", ".convex.site");

export function AgentsCard({ orgId, objects, admin }: { orgId: Id<"orgs">; objects: Doc<"objects">[]; admin: boolean }) {
  const agents = useQuery(api.agents.list, { orgId });
  const create = useAction(api.agents.create);
  const setGrants = useMutation(api.agents.setGrants);
  const setSharedInbox = useMutation(api.agents.setSharedInbox);
  const revoke = useMutation(api.agents.revoke);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [grants, setGrantsDraft] = useState<Grant[]>([]);
  const [issued, setIssued] = useState<{ name: string; key: string } | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    await attempt(async () => {
      const { key } = await create({ orgId, name: name.trim(), role, grants });
      setIssued({ name: name.trim(), key });
      setName("");
      setGrantsDraft([]);
    });
  }
  const has = (g: Grant) => grants.some((x) => x.action === g.action && x.objectKey === g.objectKey);
  const toggle = (g: Grant) => setGrantsDraft((all) => (has(g) ? all.filter((x) => !(x.action === g.action && x.objectKey === g.objectKey)) : [...all, g]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agents</CardTitle>
        <CardDescription>New keys read the current workspace objects and propose changes. Future objects need new permission. Grant an action to allow direct changes. Shared notes need the separate inbox permission.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {agents && agents.length > 0 && (
          <ul className="grid divide-y rounded-md border text-sm">
            {agents.map((agent) => (
              <li key={agent._id} className="flex min-h-10 flex-wrap items-center gap-2 px-3 py-1.5">
                <span className={agent.revokedAt ? "text-muted-foreground line-through" : "font-medium"}>{agent.name}</span>
                <code className="text-xs text-muted-foreground">{agent.keyPrefix}…</code>
                <Badge variant="outline">{agent.role}</Badge>
                <span className="text-xs text-muted-foreground">{agent.revokedAt ? "revoked" : agent.grants.length ? `applies ${agent.grants.map((g) => `${g.action} ${g.objectKey === "*" ? "all pre-migration objects" : g.objectKey}`).join(", ")}` : "proposes only"}</span>
                {admin && !agent.revokedAt && (
                  <span className="ml-auto flex gap-1">
                    <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => attempt(() => setSharedInbox({ orgId, agentId: agent._id, enabled: !agent.sharedInbox }), agent.sharedInbox ? "Shared inbox disabled" : "Shared inbox enabled for eligible reads")}>
                      {agent.sharedInbox ? "Disable shared inbox" : "Allow shared inbox"}
                    </Button>
                    {agent.grants.length > 0 && (
                      <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => attempt(() => setGrants({ orgId, agentId: agent._id, grants: [] }), "Now proposes only")}>
                        Remove grants
                      </Button>
                    )}
                    <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => confirm(`Revoke ${agent.name}'s key? Its past changes stay in the timeline.`) && attempt(() => revoke({ orgId, agentId: agent._id }), "Revoked")}>
                      Revoke
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {issued && (
          <div className="grid gap-2 rounded-md border border-primary/30 bg-accent/60 p-3 text-sm">
            <p className="font-medium">Key for {issued.name}. Copy it now; it is not shown again.</p>
            <CopyBlock text={issued.key} label="Agent key" />
            <p className="text-muted-foreground">Connect Claude Code:</p>
            <CopyBlock text={`claude mcp add remold -e REMOLD_URL=${siteUrl} -e REMOLD_KEY=${issued.key} -- node <path to remold>/packages/mcp/dist/index.js`} label="Claude Code command" />
            <p className="text-muted-foreground">Or call REST directly:</p>
            <CopyBlock text={`curl -H "Authorization: Bearer ${issued.key}" ${siteUrl}/api/v1/me`} label="REST example" />
            <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setIssued(null)}>
              I saved it
            </Button>
          </div>
        )}
        {admin && (
          <form onSubmit={add} className="grid gap-3 border-t pt-4">
            <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name, e.g. claude-mac" aria-label="Agent name" required />
              <Select value={role} onValueChange={(v) => setRole(v as "member" | "admin")}>
                <SelectTrigger className="w-full" aria-label="Agent role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">member</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
              <Button type="submit" variant="outline" disabled={!name.trim()}>
                Add agent
              </Button>
            </div>
            <fieldset className="grid gap-1.5">
              <legend className="text-xs text-muted-foreground">Apply without asking (leave empty to have it propose everything)</legend>
              <table className="w-full max-w-md text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="py-1 text-left font-normal" />
                    {ACTIONS.map((action) => (
                      <th key={action} className="w-20 py-1 font-normal">
                        {action}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[{ key: "*", label: "All current objects" }, ...objects.map((o) => ({ key: o.key, label: o.labelPlural }))].map((o) => (
                    <tr key={o.key} className="border-t">
                      <td className="py-1.5">{o.label}</td>
                      {ACTIONS.map((action) => (
                        <td key={action} className="text-center">
                          <Checkbox checked={has({ action, objectKey: o.key })} onCheckedChange={() => toggle({ action, objectKey: o.key })} aria-label={`${action} ${o.label}`} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </fieldset>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-md border bg-card p-2">
      <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap break-all" aria-label={label}>
        {text}
      </pre>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); toast.success("Copied"); }, () => toast.error("Copy failed; select the text instead"))}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
