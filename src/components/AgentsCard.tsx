import { useState, type FormEvent } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
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

export function AgentsCard({ orgId, objects, admin, owner }: { orgId: Id<"orgs">; objects: Doc<"objects">[]; admin: boolean; owner: boolean }) {
  const agents = useQuery(api.agents.list, { orgId });
  const create = useAction(api.agents.create);
  const createIntake = useAction(api.agents.createIntake);
  const createGmailSync = useAction(api.agents.createGmailSync);
  const setGrants = useMutation(api.agents.setGrants);
  const setSharedInbox = useMutation(api.agents.setSharedInbox);
  const revoke = useMutation(api.agents.revoke);
  const [name, setName] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [grants, setGrantsDraft] = useState<Grant[]>([]);
  const [open, setOpen] = useState<Id<"agents"> | null>(null);
  const [issued, setIssued] = useState<{ name: string; key: string; intake?: boolean; gmail?: boolean } | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    await attempt(async () => {
      const { key } = await create({ orgId, name: name.trim(), role, grants });
      setIssued({ name: name.trim(), key });
      setName("");
      setGrantsDraft([]);
    });
  }
  const addIntake = () => attempt(async () => setIssued({ name: "Website intake key", key: (await createIntake({ orgId })).key, intake: true }));
  const addGmailSync = () => attempt(async () => setIssued({ name: "Gmail sync", key: (await createGmailSync({ orgId })).key, gmail: true }));
  const has = (g: Grant) => grants.some((x) => x.action === g.action && x.objectKey === g.objectKey);
  const toggle = (g: Grant) => setGrantsDraft((all) => (has(g) ? all.filter((x) => !(x.action === g.action && x.objectKey === g.objectKey)) : [...all, g]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agents</CardTitle>
        <CardDescription>New keys read the current workspace objects and propose changes. Objects added later stay hidden until you let the agent read them. Grant an action to allow direct changes. Shared notes need the separate inbox permission.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {agents && agents.length > 0 && (
          <ul className="grid divide-y rounded-md border text-sm">
            {agents.map((agent) => (
              <li key={agent._id} className="flex min-h-10 flex-wrap items-center gap-2 px-3 py-1.5">
                <span className={agent.revokedAt ? "text-muted-foreground line-through" : "font-medium"}>{agent.name}</span>
                <code className="text-xs text-muted-foreground">{agent.keyPrefix}…</code>
                <Badge variant="outline">{agent.role}</Badge>
                <span className="text-xs text-muted-foreground">{agent.revokedAt ? "revoked" : agent.purpose === "intake" ? "submits website leads only; reads nothing" : agent.grants.length ? `applies ${agent.grants.map((g) => `${g.action} ${g.objectKey === "*" ? "all pre-migration objects" : g.objectKey}`).join(", ")}` : agent.access.length ? `can ${agent.access.join(", ")}` : "proposes only"}</span>
                {admin && !agent.revokedAt && (
                  <span className="ml-auto flex gap-1">
                    {agent.purpose === undefined && (
                      <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => attempt(() => setSharedInbox({ orgId, agentId: agent._id, enabled: !agent.sharedInbox }), agent.sharedInbox ? "Shared inbox disabled" : "Shared inbox enabled for eligible reads")}>
                        {agent.sharedInbox ? "Disable shared inbox" : "Allow shared inbox"}
                      </Button>
                    )}
                    {agent.grants.length > 0 && (
                      <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => attempt(() => setGrants({ orgId, agentId: agent._id, grants: [] }), "Now proposes only")}>
                        Remove grants
                      </Button>
                    )}
                    {!agent.fixedScope && (
                      <Button size="xs" variant="ghost" className="text-muted-foreground" aria-expanded={open === agent._id} onClick={() => setOpen(open === agent._id ? null : agent._id)}>
                        Access
                      </Button>
                    )}
                    <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => confirm(`Revoke ${agent.name}'s key? Its past changes stay in the timeline.`) && attempt(() => revoke({ orgId, agentId: agent._id }), "Revoked")}>
                      Revoke
                    </Button>
                  </span>
                )}
                {!agent.revokedAt && !agent.fixedScope && <ReadAccess orgId={orgId} agent={agent} objects={objects} admin={admin} open={admin && open === agent._id} />}
              </li>
            ))}
          </ul>
        )}
        {issued && (
          <div className="grid gap-2 rounded-md border border-primary/30 bg-accent/60 p-3 text-sm">
            <p className="font-medium">Key for {issued.name}. Copy it now; it is not shown again.</p>
            <CopyBlock text={issued.key} label="Agent key" />
            {issued.intake ? (
              <>
                <p className="text-muted-foreground">Store it as a server-side secret on the website. It can submit leads and read nothing. Each form submission needs its own Idempotency-Key:</p>
                <CopyBlock text={`curl -X POST ${siteUrl}/api/v1/intake/lead -H "Authorization: Bearer ${issued.key}" -H "Idempotency-Key: <submission id>" -H "Content-Type: application/json" -d '{"name":"Ada Lovelace","email":"ada@example.com","message":"Hello"}'`} label="Intake example" />
              </>
            ) : issued.gmail ? (
              <>
                <p className="text-muted-foreground">In the Apps Script project's Script Properties, set REMOLD_KEY to the key above and REMOLD_BASE_URL to:</p>
                <CopyBlock text={siteUrl} label="Base URL" />
                <p className="text-muted-foreground">The script and setup steps are in ops/gmail-sync in the Remold repository. Installing it needs your Google sign-in.</p>
              </>
            ) : (
              <>
                <p className="text-muted-foreground">Connect Claude Code:</p>
                <CopyBlock text={`claude mcp add remold -e REMOLD_URL=${siteUrl} -e REMOLD_KEY=${issued.key} -- node <path to remold>/packages/mcp/dist/index.js`} label="Claude Code command" />
                <p className="text-muted-foreground">Or call REST directly:</p>
                <CopyBlock text={`curl -H "Authorization: Bearer ${issued.key}" ${siteUrl}/api/v1/me`} label="REST example" />
              </>
            )}
            <Button size="sm" variant="outline" className="justify-self-start" onClick={() => setIssued(null)}>
              I saved it
            </Button>
          </div>
        )}
        {owner && (
          <div className="grid gap-2 border-t pt-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={addIntake}>
                Website intake key
              </Button>
              <span className="text-muted-foreground">For your website's contact form: it adds each lead as a Person, an Opportunity at New and a Note, and cannot read anything.</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={addGmailSync}>
                Create Gmail sync key
              </Button>
              <span className="text-muted-foreground">For the Apps Script that logs your emails as activities: it reads people's names and emails, reads and creates activities, and nothing else.</span>
            </div>
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

type Listed = FunctionReturnType<typeof api.agents.list>[number];
// What one agent reads, and per object whether it may apply changes directly.
function ReadAccess({ orgId, agent, objects, admin, open }: { orgId: Id<"orgs">; agent: Listed; objects: Doc<"objects">[]; admin: boolean; open: boolean }) {
  const setReadAccess = useMutation(api.agents.setReadAccess);
  const setGrants = useMutation(api.agents.setGrants);
  const all = !!agent.readAllObjects, hidden = objects.filter((o) => agent.cannotRead.includes(o.key)), reads = (o: Doc<"objects">) => !agent.cannotRead.includes(o.key);
  const readable = objects.filter(reads).map((o) => o._id);
  const save = (readAllObjects: boolean, objectIds: Id<"objects">[], done: string) => attempt(() => setReadAccess({ orgId, agentId: agent._id, readAllObjects, objectIds }), done);
  const can = (action: Grant["action"], o: Doc<"objects">) => agent.grants.some((g) => g.action === action && (g.objectKey === o.key || g.objectKey === "*"));
  const toggleGrant = (action: Grant["action"], o: Doc<"objects">) => attempt(() => setGrants({ orgId, agentId: agent._id, grants: can(action, o) ? agent.grants.filter((g) => !(g.action === action && g.objectKey === o.key)) : [...agent.grants, { action, objectKey: o.key }] }), "Saved");
  const allObjects = (
    <Button size="xs" variant="ghost" onClick={() => save(true, [], "It reads all objects")}>
      All objects
    </Button>
  );
  return (
    <div className="grid w-full gap-2 pb-1 text-xs text-muted-foreground">
      <p className="flex flex-wrap items-center gap-1.5">
        {all ? "Reads all objects, including new ones." : hidden.length ? `Cannot see: ${hidden.map((o) => o.labelPlural).join(", ")}` : "Reads every current object. New ones stay hidden until you let it read them."}
        {admin && !all && hidden.map((o) => (
          <Button key={o._id} size="xs" variant="outline" onClick={() => save(false, [...readable, o._id], `It can read ${o.labelPlural}`)}>
            Let it read {o.labelPlural}
          </Button>
        ))}
        {admin && !all && !agent.inboxNeedsAll && allObjects}
      </p>
      {agent.inboxNeedsAll && (
        <p className="flex flex-wrap items-center gap-1.5">
          Shared inbox needs access to all objects.
          {admin && allObjects}
        </p>
      )}
      {open && (
        <table className="w-full max-w-md text-sm text-foreground">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="py-1 text-left font-normal" />
              <th className="w-16 py-1 font-normal">read</th>
              {ACTIONS.map((action) => <th key={action} className="w-16 py-1 font-normal">{action}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t">
              <td className="py-1.5">All objects, including new ones</td>
              <td className="text-center"><Checkbox checked={all} onCheckedChange={() => save(!all, objects.map((o) => o._id), all ? "New objects now stay hidden" : "It reads all objects")} aria-label={`${agent.name} reads all objects`} /></td>
            </tr>
            {objects.map((o) => (
              <tr key={o._id} className="border-t">
                <td className="py-1.5">{o.labelPlural}</td>
                <td className="text-center"><Checkbox checked={reads(o)} disabled={all} onCheckedChange={() => save(false, reads(o) ? readable.filter((id) => id !== o._id) : [...readable, o._id], reads(o) ? `It no longer reads ${o.labelPlural}` : `It can read ${o.labelPlural}`)} aria-label={`${agent.name} reads ${o.labelPlural}`} /></td>
                {ACTIONS.map((action) => (
                  <td key={action} className="text-center"><Checkbox checked={reads(o) && can(action, o)} disabled={!reads(o)} onCheckedChange={() => toggleGrant(action, o)} aria-label={`${agent.name} may ${action} ${o.labelPlural}`} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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
