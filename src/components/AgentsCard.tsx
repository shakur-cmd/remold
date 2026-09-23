import { useState, type FormEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorMessage } from "@/lib/errors";

type Grant = { action: "create" | "update" | "delete"; objectKey: string };
const ACTIONS = ["create", "update", "delete"] as const;
// The REST and MCP surface lives on the deployment's site URL.
const siteUrl = (import.meta.env.VITE_CONVEX_URL as string).replace(".convex.cloud", ".convex.site");

export function AgentsCard({ orgId, objects, admin }: { orgId: Id<"orgs">; objects: Doc<"objects">[]; admin: boolean }) {
  const agents = useQuery(api.agents.list, { orgId });
  const create = useAction(api.agents.create);
  const setGrants = useMutation(api.agents.setGrants);
  const revoke = useMutation(api.agents.revoke);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [grants, setGrantsDraft] = useState<Grant[]>([]);
  const [issued, setIssued] = useState<{ name: string; key: string } | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      const { key } = await create({ orgId, name: name.trim(), role, grants });
      setIssued({ name: name.trim(), key });
      setName("");
      setGrantsDraft([]);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  const has = (g: Grant) => grants.some((x) => x.action === g.action && x.objectKey === g.objectKey);
  const toggle = (g: Grant) => setGrantsDraft((all) => (has(g) ? all.filter((x) => !(x.action === g.action && x.objectKey === g.objectKey)) : [...all, g]));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Agents</CardTitle>
        <p className="text-sm text-muted-foreground">An agent is a team member with a key. It reads everything a member can and proposes changes; you apply them. Grant an action and it lands without asking.</p>
      </CardHeader>
      <CardContent className="grid gap-4">
        {agents?.map((agent) => (
          <div key={agent._id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className={agent.revokedAt ? "text-muted-foreground line-through" : "font-medium"}>{agent.name}</span>
            <code className="text-xs text-muted-foreground">{agent.keyPrefix}…</code>
            <Badge variant="outline">{agent.role}</Badge>
            <span className="text-xs text-muted-foreground">{agent.grants.length ? agent.grants.map((g) => `${g.action}:${g.objectKey}`).join(", ") : "proposes only"}</span>
            {admin && !agent.revokedAt && (
              <span className="ml-auto flex gap-1">
                {agent.grants.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setGrants({ orgId, agentId: agent._id, grants: [] }).then(() => toast.success("Grants removed"), (e) => toast.error(errorMessage(e)))}>
                    Remove grants
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => confirm(`Revoke ${agent.name}'s key? Its past changes stay in the timeline.`) && revoke({ orgId, agentId: agent._id }).then(() => toast.success("Revoked"), (e) => toast.error(errorMessage(e)))}>
                  Revoke
                </Button>
              </span>
            )}
          </div>
        ))}
        {issued && (
          <div className="grid gap-2 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
            <p className="font-medium">Key for {issued.name}. Copy it now; it is not shown again.</p>
            <Input readOnly value={issued.key} onFocus={(e) => e.currentTarget.select()} aria-label="Agent key" />
            <p className="text-muted-foreground">Connect Claude Code:</p>
            <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{`claude mcp add remold -e REMOLD_URL=${siteUrl} -e REMOLD_KEY=${issued.key} -- npx -y @remold/mcp`}</pre>
            <p className="text-muted-foreground">Or call REST directly:</p>
            <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{`curl -H "Authorization: Bearer ${issued.key}" ${siteUrl}/api/v1/me`}</pre>
            <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setIssued(null)}>
              I saved it
            </Button>
          </div>
        )}
        {admin && (
          <form onSubmit={add} className="grid gap-3 rounded-md border p-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name, e.g. claude-mac" aria-label="Agent name" required />
              <Select value={role} onValueChange={(v) => setRole(v as "member" | "admin")}>
                <SelectTrigger aria-label="Agent role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">member</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
              <Button type="submit" disabled={!name.trim()}>
                Add agent
              </Button>
            </div>
            <div className="grid gap-1.5">
              <Label>Apply without asking</Label>
              <div className="grid gap-1 text-sm sm:grid-cols-2">
                {[{ key: "*", label: "Everything" }, ...objects.map((o) => ({ key: o.key, label: o.labelPlural }))].map((o) => (
                  <div key={o.key} className="flex flex-wrap items-center gap-3">
                    <span className="w-28 truncate">{o.label}</span>
                    {ACTIONS.map((action) => (
                      <label key={action} className="flex items-center gap-1 text-muted-foreground">
                        <Checkbox checked={has({ action, objectKey: o.key })} onCheckedChange={() => toggle({ action, objectKey: o.key })} aria-label={`${action} ${o.label}`} />
                        {action}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
