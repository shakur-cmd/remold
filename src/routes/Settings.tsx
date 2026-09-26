import { useState, type FormEvent } from "react";
import { useNavigate, useOutletContext } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AgentsCard } from "@/components/AgentsCard";
import { attempt } from "@/lib/errors";
import { toKey } from "@/lib/fields";
import type { OrgContext } from "@/routes/OrgLayout";

export function Settings() {
  const { org, role, objects } = useOutletContext<OrgContext>();
  const admin = role === "owner" || role === "admin";
  return (
    <div className="grid max-w-3xl gap-5">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <OrgCard org={org} admin={admin} />
      <MembersCard orgId={org._id} admin={admin} />
      <AgentsCard orgId={org._id} objects={objects} admin={admin} />
      <ObjectsCard orgId={org._id} objects={objects} admin={admin} />
    </div>
  );
}

function OrgCard({ org, admin }: { org: Doc<"orgs">; admin: boolean }) {
  const rename = useMutation(api.orgs.rename);
  const [name, setName] = useState(org.name);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Organisation</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void attempt(() => rename({ orgId: org._id, name: name.trim() }), "Renamed");
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!admin} aria-label="Organisation name" />
          <Button type="submit" variant="outline" disabled={!admin || !name.trim() || name.trim() === org.name}>
            Rename
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function MembersCard({ orgId, admin }: { orgId: Id<"orgs">; admin: boolean }) {
  const members = useQuery(api.orgs.members, { orgId });
  const me = useQuery(api.users.me);
  const createInvite = useMutation(api.invites.create);
  const setRole = useMutation(api.orgs.setRole);
  const removeMember = useMutation(api.orgs.removeMember);
  const leave = useMutation(api.orgs.leave);
  const navigate = useNavigate();
  const [link, setLink] = useState<string | null>(null);
  const myRole = members?.find(({ user }) => user._id === me?._id)?.member.role;
  const invite = (role: "admin" | "member") =>
    attempt(async () => {
      const { token } = await createInvite({ orgId, role });
      const base = import.meta.env.VITE_ROUTER === "hash" ? `${location.origin}${location.pathname}#` : location.origin;
      const url = `${base}/invite/${token}`;
      setLink(url);
      await navigator.clipboard?.writeText(url).catch(() => undefined);
    }, "Invite link ready and copied");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1">
        {members?.map(({ member, user }) => {
          const self = user._id === me?._id;
          // Only an owner touches owners; nobody edits their own row here.
          const editable = admin && !self && (member.role !== "owner" || myRole === "owner");
          return (
            <div key={member._id} className="flex min-h-9 flex-wrap items-center gap-x-2 text-sm">
              <span className="font-medium">{user.name}</span>
              <span className="text-muted-foreground">{user.email}</span>
              <span className="ml-auto flex items-center gap-1">
                {editable ? (
                  <Select value={member.role} onValueChange={(role) => attempt(() => setRole({ orgId, userId: user._id, role: role as "owner" | "admin" | "member" }), "Role changed")}>
                    <SelectTrigger size="sm" aria-label={`Role of ${user.name}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(["member", "admin", ...(myRole === "owner" ? ["owner"] : [])] as const).map((role) => (
                        <SelectItem key={role} value={role}>
                          {role}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="outline">{member.role}</Badge>
                )}
                {editable && (
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => confirm(`Remove ${user.name} from this organisation?`) && attempt(() => removeMember({ orgId, userId: user._id }), "Removed")}>
                    Remove
                  </Button>
                )}
              </span>
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2 pt-3">
          {admin && (
            <>
              <Button size="sm" variant="outline" onClick={() => invite("member")}>
                Invite a member
              </Button>
              <Button size="sm" variant="outline" onClick={() => invite("admin")}>
                Invite an admin
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => confirm("Leave this organisation?") && attempt(async () => { await leave({ orgId }); navigate("/"); })}>
            Leave organisation
          </Button>
        </div>
        {link && <Input readOnly value={link} className="mt-2" onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />}
      </CardContent>
    </Card>
  );
}

function ObjectsCard({ orgId, objects, admin }: { orgId: Id<"orgs">; objects: Doc<"objects">[]; admin: boolean }) {
  const create = useMutation(api.objects.create);
  const [selected, setSelected] = useState<Id<"objects"> | undefined>(objects[0]?._id);
  const [label, setLabel] = useState("");
  const [plural, setPlural] = useState("");
  const key = toKey(label);
  const current = objects.find((o) => o._id === selected);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Objects and fields</CardTitle>
        <CardDescription>Shape Remold around your work: add an object like Lead or Job, then give it fields.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Select value={selected} onValueChange={(v) => setSelected(v as Id<"objects">)}>
          <SelectTrigger className="w-full sm:w-72" aria-label="Object">
            <SelectValue placeholder="Choose an object" />
          </SelectTrigger>
          <SelectContent>
            {objects.map((o) => (
              <SelectItem key={o._id} value={o._id}>
                {o.labelPlural}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {current && <Fields key={current._id} orgId={orgId} object={current} objects={objects} admin={admin} />}
        {admin && (
          <form
            className="grid gap-2 border-t pt-4 sm:grid-cols-[1fr_1fr_auto]"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void attempt(async () => {
                setSelected(await create({ orgId, key, label: label.trim(), labelPlural: plural.trim() || `${label.trim()}s` }));
                setLabel("");
                setPlural("");
              }, "Object created");
            }}
          >
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New object, e.g. Lead" aria-label="Object label" required />
            <Input value={plural} onChange={(e) => setPlural(e.target.value)} placeholder="Plural, e.g. Leads" aria-label="Plural label" />
            <Button type="submit" variant="outline" disabled={!key}>
              Add object
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

const TYPES = ["text", "number", "select", "date", "boolean", "lookup", "links"] as const;

function Fields({ orgId, object, objects, admin }: { orgId: Id<"orgs">; object: Doc<"objects">; objects: Doc<"objects">[]; admin: boolean }) {
  const fields = useQuery(api.fields.list, { orgId, objectId: object._id });
  const create = useMutation(api.fields.create);
  const retire = useMutation(api.fields.retire);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("text");
  const [options, setOptions] = useState("");
  const [target, setTarget] = useState<Id<"objects"> | undefined>();
  const key = toKey(label);
  const linking = type === "lookup" || type === "links";

  async function add(e: FormEvent) {
    e.preventDefault();
    await attempt(async () => {
      const parsed = options
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => ({ id: s.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label: s }));
      const result = await create({ orgId, objectId: object._id, key, label: label.trim(), type, options: type === "select" ? parsed : undefined, targetObjectId: linking ? target : undefined });
      if (!result.slot) toast.warning("Slots for this type are used up: the field stores values but cannot sort or filter.");
      setLabel("");
      setOptions("");
    }, "Field added");
  }

  return (
    <div className="grid gap-3">
      <ul className="grid divide-y rounded-md border text-sm">
        {fields?.map((field) => (
          <FieldRow key={field._id} orgId={orgId} field={field} isTitle={field._id === object.titleFieldId} admin={admin} onRetire={() => confirm(`Retire ${field.label}? Its values stay in history.`) && attempt(() => retire({ orgId, fieldId: field._id }), "Retired")} />
        ))}
      </ul>
      {admin && (
        <form onSubmit={add} className="grid gap-2 sm:grid-cols-[1fr_10rem_auto]">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New field, e.g. Source" aria-label="Field label" required />
          <Select value={type} onValueChange={(v) => setType(v as (typeof TYPES)[number])}>
            <SelectTrigger className="w-full" aria-label="Field type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" variant="outline" disabled={!key || (linking && !target)}>
            Add field
          </Button>
          {type === "select" && <Input className="sm:col-span-3" value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Options, comma separated: New, Contacted, Won" aria-label="Options" required />}
          {linking && (
            <Select value={target} onValueChange={(v) => setTarget(v as Id<"objects">)}>
              <SelectTrigger className="w-full sm:col-span-3" aria-label="Target object">
                <SelectValue placeholder="Links to which object?" />
              </SelectTrigger>
              <SelectContent>
                {objects.map((o) => (
                  <SelectItem key={o._id} value={o._id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </form>
      )}
    </div>
  );
}

function FieldRow({ orgId, field, isTitle, admin, onRetire }: { orgId: Id<"orgs">; field: Doc<"fields">; isTitle: boolean; admin: boolean; onRetire: () => void }) {
  const update = useMutation(api.fields.update);
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null)
    return (
      <li className="px-3 py-1.5">
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (draft.trim() === field.label || (await attempt(() => update({ orgId, fieldId: field._id, label: draft.trim() }), "Renamed"))) setDraft(null);
          }}
        >
          <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`New name for ${field.label}`} onKeyDown={(e) => e.key === "Escape" && setDraft(null)} />
          <Button type="submit" size="sm" variant="outline" disabled={!draft.trim()}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </form>
      </li>
    );
  return (
    <li className="flex min-h-10 flex-wrap items-center gap-2 px-3 py-1.5">
      <span className={field.retired ? "text-muted-foreground line-through" : "font-medium"}>{field.label}</span>
      <span className="text-xs text-muted-foreground">{field.type}</span>
      {isTitle && <Badge variant="secondary">title</Badge>}
      {/* Only unindexed fields need a note: they store values but cannot sort or filter. */}
      {!field.slot && field.type !== "links" && <Badge variant="outline" title="Stores values, cannot sort or filter">unindexed</Badge>}
      {admin && !field.retired && (
        <span className="ml-auto flex gap-1">
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setDraft(field.label)}>
            Rename
          </Button>
          {!isTitle && (
            <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={onRetire}>
              Retire
            </Button>
          )}
        </span>
      )}
    </li>
  );
}
