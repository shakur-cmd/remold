import { useState, type FormEvent } from "react";
import { useOutletContext } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorMessage } from "@/lib/errors";
import type { OrgContext } from "@/routes/OrgLayout";

const run = async (action: () => Promise<unknown>, success?: string) => {
  try {
    await action();
    if (success) toast.success(success);
  } catch (error) {
    toast.error(errorMessage(error));
  }
};

export function Settings() {
  const { org, role, objects } = useOutletContext<OrgContext>();
  const admin = role === "owner" || role === "admin";
  return (
    <div className="grid max-w-3xl gap-6">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <OrgCard org={org} admin={admin} />
      <MembersCard orgId={org._id} admin={admin} />
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
        <CardTitle className="text-base">Organisation</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(() => rename({ orgId: org._id, name: name.trim() }), "Renamed");
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!admin} aria-label="Organisation name" />
          <Button type="submit" disabled={!admin || name.trim() === org.name}>
            Rename
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function MembersCard({ orgId, admin }: { orgId: Id<"orgs">; admin: boolean }) {
  const members = useQuery(api.orgs.members, { orgId });
  const createInvite = useMutation(api.invites.create);
  const [link, setLink] = useState<string | null>(null);
  async function invite(role: "admin" | "member") {
    await run(async () => {
      const { token } = await createInvite({ orgId, role });
      const base = import.meta.env.VITE_ROUTER === "hash" ? `${location.origin}${location.pathname}#` : location.origin;
      const url = `${base}/invite/${token}`;
      setLink(url);
      await navigator.clipboard?.writeText(url).catch(() => undefined);
    }, "Invite link ready and copied");
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Members</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {members?.map(({ member, user }) => (
          <div key={member._id} className="flex items-center gap-2 text-sm">
            <span className="font-medium">{user.name}</span>
            <span className="text-muted-foreground">{user.email}</span>
            <Badge variant="outline" className="ml-auto">
              {member.role}
            </Badge>
          </div>
        ))}
        {admin && (
          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={() => invite("member")}>
              Invite a member
            </Button>
            <Button size="sm" variant="outline" onClick={() => invite("admin")}>
              Invite an admin
            </Button>
          </div>
        )}
        {link && <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />}
      </CardContent>
    </Card>
  );
}

function ObjectsCard({ orgId, objects, admin }: { orgId: Id<"orgs">; objects: Doc<"objects">[]; admin: boolean }) {
  const create = useMutation(api.objects.create);
  const [selected, setSelected] = useState<Id<"objects"> | undefined>(objects[0]?._id);
  const [label, setLabel] = useState("");
  const [plural, setPlural] = useState("");
  const key = label.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^[A-Z]/, (c) => c.toLowerCase());
  const current = objects.find((o) => o._id === selected);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Objects and fields</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {admin && (
          <form
            className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto]"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run(async () => {
                const objectId = await create({ orgId, key, label: label.trim(), labelPlural: plural.trim() || `${label.trim()}s` });
                setSelected(objectId);
                setLabel("");
                setPlural("");
              }, "Object created");
            }}
          >
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New object, e.g. Lead" aria-label="Object label" required />
            <Input value={plural} onChange={(e) => setPlural(e.target.value)} placeholder="Plural, e.g. Leads" aria-label="Plural label" />
            <Button type="submit" disabled={!key}>
              Add object
            </Button>
          </form>
        )}
        <div className="grid gap-1.5">
          <Label>Object</Label>
          <Select value={selected} onValueChange={(v) => setSelected(v as Id<"objects">)}>
            <SelectTrigger className="w-full sm:w-72">
              <SelectValue placeholder="Choose an object" />
            </SelectTrigger>
            <SelectContent>
              {objects.map((o) => (
                <SelectItem key={o._id} value={o._id}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {current && <Fields key={current._id} orgId={orgId} object={current} objects={objects} admin={admin} />}
      </CardContent>
    </Card>
  );
}

const TYPES = ["text", "number", "select", "date", "boolean", "lookup", "links"] as const;

function Fields({ orgId, object, objects, admin }: { orgId: Id<"orgs">; object: Doc<"objects">; objects: Doc<"objects">[]; admin: boolean }) {
  const fields = useQuery(api.fields.list, { orgId, objectId: object._id });
  const create = useMutation(api.fields.create);
  const update = useMutation(api.fields.update);
  const retire = useMutation(api.fields.retire);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("text");
  const [options, setOptions] = useState("");
  const [target, setTarget] = useState<Id<"objects"> | undefined>();
  const key = label.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : "")).replace(/^[A-Z]/, (c) => c.toLowerCase());

  async function add(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const parsed = options
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => ({ id: s.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label: s }));
      const result = await create({
        orgId,
        objectId: object._id,
        key,
        label: label.trim(),
        type,
        options: type === "select" ? parsed : undefined,
        targetObjectId: type === "lookup" || type === "links" ? target : undefined,
      });
      if (!result.slot) toast.warning("Slots for this type are used up: the field stores values but cannot sort or filter.");
      setLabel("");
      setOptions("");
    }, "Field added");
  }

  return (
    <div className="grid gap-3">
      <ul className="grid gap-1 text-sm">
        {fields?.map((field) => (
          <li key={field._id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
            <span className={field.retired ? "line-through text-muted-foreground" : "font-medium"}>{field.label}</span>
            <span className="text-muted-foreground">{field.type}</span>
            {field.slot ? (
              <Badge variant="outline">indexed</Badge>
            ) : (
              field.type !== "links" && <Badge variant="secondary">unindexed</Badge>
            )}
            {field._id === object.titleFieldId && <Badge>title</Badge>}
            {admin && !field.retired && (
              <span className="ml-auto flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const next = prompt("Rename field", field.label);
                    if (next && next.trim() !== field.label) void run(() => update({ orgId, fieldId: field._id, label: next.trim() }), "Renamed");
                  }}
                >
                  Rename
                </Button>
                {field._id !== object.titleFieldId && (
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => confirm(`Retire ${field.label}?`) && run(() => retire({ orgId, fieldId: field._id }), "Retired")}>
                    Retire
                  </Button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      {admin && (
        <form onSubmit={add} className="grid gap-2 rounded-md border p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Field label, e.g. Stage" aria-label="Field label" required />
            <Select value={type} onValueChange={(v) => setType(v as (typeof TYPES)[number])}>
              <SelectTrigger aria-label="Field type">
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
          </div>
          {type === "select" && <Input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Options, comma separated: New, Contacted, Won" aria-label="Options" required />}
          {(type === "lookup" || type === "links") && (
            <Select value={target} onValueChange={(v) => setTarget(v as Id<"objects">)}>
              <SelectTrigger aria-label="Target object">
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
          <Button type="submit" className="justify-self-end" disabled={!key || ((type === "lookup" || type === "links") && !target)}>
            Add field
          </Button>
        </form>
      )}
    </div>
  );
}
