import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, useOutletContext } from "react-router";
import { useConvex, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowDown, ArrowUp, Check, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AgentsCard } from "@/components/AgentsCard";
import { PaymentsCard } from "@/components/Bookings";
import { attempt, errorMessage } from "@/lib/errors";
import { toKey } from "@/lib/fields";
import { capacity, slotsLeft, type SlotKind } from "../../convex/lib/slots";
import type { OrgContext } from "@/routes/OrgLayout";

export function Settings() {
  const { org, role, objects } = useOutletContext<OrgContext>();
  const admin = role === "owner" || role === "admin";
  return (
    <div className="grid max-w-3xl gap-5">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <OrgCard org={org} admin={admin} />
      <RemindersCard orgId={org._id} />
      {admin && <EmailSendingCard orgId={org._id} />}
      {admin && <PaymentsCard orgId={org._id} />}
      <MembersCard orgId={org._id} admin={admin} />
      <AgentsCard orgId={org._id} objects={objects} admin={admin} owner={role === "owner"} />
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

function RemindersCard({ orgId }: { orgId: Id<"orgs"> }) {
  const mine = useQuery(api.reminders.mine, { orgId });
  const set = useMutation(api.reminders.set);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily reminder</CardTitle>
        <CardDescription>An email at 11:00 UTC with your overdue tasks, tasks due today and deals gone quiet in this organisation. Nothing is sent on days with nothing to list.</CardDescription>
      </CardHeader>
      <CardContent>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={mine?.on === true} disabled={!mine?.email} onCheckedChange={(on) => attempt(() => set({ orgId, on: on === true }), on === true ? "Daily reminder on" : "Daily reminder off")} aria-label="Email me a daily reminder" />
          {mine?.email ? <>Email me at <span className="font-medium">{mine.email}</span></> : "Your account has no email address, so reminders cannot be sent."}
        </label>
      </CardContent>
    </Card>
  );
}

// Campaign email: who it comes from, the postal address every email carries, and the
// daily limit. The checklist says what still blocks sending; secrets never reach the page.
function EmailSendingCard({ orgId }: { orgId: Id<"orgs"> }) {
  const data = useQuery(api.campaigns.settings, { orgId });
  if (!data) return null;
  return <EmailSendingForm key={JSON.stringify(data.settings)} orgId={orgId} data={data} />;
}

function EmailSendingForm({ orgId, data }: { orgId: Id<"orgs">; data: FunctionReturnType<typeof api.campaigns.settings> }) {
  const save = useMutation(api.campaigns.saveSettings);
  const saved = data.settings;
  const [draft, setDraft] = useState({ fromName: saved.fromName ?? "", fromAddress: saved.fromAddress ?? "", replyTo: saved.replyTo ?? "", postalAddress: saved.postalAddress ?? "", dailyLimit: String(saved.dailyLimit ?? 0) });
  const set = (key: keyof typeof draft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: e.target.value }));
  const ready = data.checklist.every((item) => item.ok || item.optional);
  const inputs: [keyof typeof draft, string, string, string?][] = [["fromName", "From name", "Your business"], ["fromAddress", "From address", "hello@mail.yourdomain.com", "email"], ["replyTo", "Reply-to address", "Leave empty to use the approving admin's email", "email"], ["postalAddress", "Postal address", "Printed at the bottom of every email"], ["dailyLimit", "Daily limit", "0", "number"]];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Email sending</CardTitle>
        <CardDescription>Campaign emails go out through Resend. {ready ? "Everything needed is in place." : "Nothing sends until every required item below is ready."}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void attempt(() => save({ orgId, ...draft, dailyLimit: Number(draft.dailyLimit) }), "Email settings saved");
          }}
        >
          {inputs.map(([key, label, placeholder, type]) => (
            <label key={key} className={key === "postalAddress" ? "grid gap-1.5 text-sm sm:col-span-2" : "grid gap-1.5 text-sm"}>
              <span className="font-medium">{label}</span>
              <Input type={type ?? "text"} min={type === "number" ? 0 : undefined} step={type === "number" ? 1 : undefined} value={draft[key]} onChange={set(key)} placeholder={placeholder} />
            </label>
          ))}
          <Button type="submit" variant="outline" className="justify-self-start sm:col-span-2">Save</Button>
        </form>
        <ul className="grid gap-1 border-t pt-3 text-sm">
          {data.checklist.map((item) => (
            <li key={item.key} className="flex items-center gap-2">
              {item.ok ? <Check className="size-4 text-emerald-600" aria-label="Ready" /> : <X className={item.optional ? "size-4 text-muted-foreground" : "size-4 text-destructive"} aria-label="Missing" />}
              <span className={item.ok ? undefined : "text-muted-foreground"}>{item.label}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">The API key, sender domains, deployment cap, webhook secret and inbound domain are set by whoever runs this Remold, as environment settings.</p>
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

// The confirm still opens when the preview cannot load, and says so; the error is also shown as a toast.
async function impactLines(load: () => Promise<string[]>) {
  try {
    return (await load()).join("\n");
  } catch (error) {
    toast.error(`Could not count what this touches: ${errorMessage(error)}`);
    return `Could not count what this touches: ${errorMessage(error)}`;
  }
}

// Moves one item a place up or down; the server takes the whole new order.
function moved<T>(list: T[], index: number, by: -1 | 1) {
  const next = [...list];
  [next[index], next[index + by]] = [next[index + by]!, next[index]!];
  return next;
}

function MoveButtons({ label, index, count, onMove }: { label: string; index: number; count: number; onMove: (by: -1 | 1) => void }) {
  return (
    <>
      <Button size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => onMove(-1)}>
        <ArrowUp />
      </Button>
      <Button size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label={`Move ${label} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
        <ArrowDown />
      </Button>
    </>
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
        <CardDescription>Shape Remold around your work: add an object like Lead or Job, then give it fields. Nothing is deleted: retired fields and archived objects keep their data and can come back.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {admin && <ObjectOrder orgId={orgId} objects={objects} />}
        <Select value={selected} onValueChange={(v) => setSelected(v as Id<"objects">)}>
          <SelectTrigger className="w-full sm:w-72" aria-label="Object">
            <SelectValue placeholder="Choose an object" />
          </SelectTrigger>
          <SelectContent>
            {objects.map((o) => (
              <SelectItem key={o._id} value={o._id}>
                {o.labelPlural}
                {o.archived && " (archived)"}
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

// The navigation order, and archiving custom objects. Standard objects cannot be archived.
function ObjectOrder({ orgId, objects }: { orgId: Id<"orgs">; objects: Doc<"objects">[] }) {
  const reorder = useMutation(api.objects.reorder);
  const setArchived = useMutation(api.objects.setArchived);
  const convex = useConvex();
  const shown = objects.filter((o) => !o.archived), archived = objects.filter((o) => o.archived);
  async function archive(object: Doc<"objects">) {
    const impact = await impactLines(() => convex.query(api.objects.impact, { orgId, objectId: object._id }));
    if (confirm(`Archive ${object.labelPlural}?\n\n${impact}`)) await attempt(() => setArchived({ orgId, objectId: object._id, archived: true }), "Archived");
  }
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">Navigation</span>
      <ul className="grid divide-y rounded-md border text-sm">
        {shown.map((object, index) => (
          <li key={object._id} className="flex min-h-9 items-center gap-1 px-3 py-1">
            <span className="mr-auto">{object.labelPlural}</span>
            <MoveButtons label={object.labelPlural} index={index} count={shown.length} onMove={(by) => attempt(() => reorder({ orgId, objectIds: moved(shown, index, by).map((o) => o._id) }))} />
            {!object.isStandard && (
              <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => void attempt(() => archive(object))}>
                Archive
              </Button>
            )}
          </li>
        ))}
        {archived.map((object) => (
          <li key={object._id} className="flex min-h-9 items-center gap-2 px-3 py-1 text-muted-foreground">
            <span className="mr-auto">{object.labelPlural}</span>
            <Badge variant="outline">archived</Badge>
            <Button size="xs" variant="ghost" onClick={() => attempt(() => setArchived({ orgId, objectId: object._id, archived: false }), "Back in the navigation")}>
              Unarchive
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SLOT_NAMES: Record<SlotKind, string> = { s: "text", n: "number", d: "date", b: "yes/no" };
const TYPES = ["text", "number", "select", "date", "boolean", "lookup", "links"] as const;

function Fields({ orgId, object, objects, admin }: { orgId: Id<"orgs">; object: Doc<"objects">; objects: Doc<"objects">[]; admin: boolean }) {
  const fields = useQuery(api.fields.list, { orgId, objectId: object._id });
  const create = useMutation(api.fields.create);
  const retire = useMutation(api.fields.retire);
  const restore = useMutation(api.fields.restore);
  const reorder = useMutation(api.fields.reorder);
  const setTitle = useMutation(api.objects.setTitleField);
  const convex = useConvex();
  const [label, setLabel] = useState("");
  const [indexed, setIndexed] = useState(true);
  const [type, setType] = useState<(typeof TYPES)[number]>("text");
  const [options, setOptions] = useState("");
  const [target, setTarget] = useState<Id<"objects"> | undefined>();
  const [withTime, setWithTime] = useState(false);
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
      const result = await create({ orgId, objectId: object._id, key, label: label.trim(), type, options: type === "select" ? parsed : undefined, targetObjectId: linking ? target : undefined, withTime: type === "date" && withTime ? true : undefined, indexed: type === "text" && !indexed ? false : undefined });
      if (!result.slot && (type !== "text" || indexed)) toast.warning("Slots for this type are used up: the field stores values but cannot sort or filter.");
      setLabel("");
      setIndexed(true);
      setOptions("");
      setWithTime(false);
    }, "Field added");
  }

  const live = fields?.filter((f) => !f.retired) ?? [], retired = fields?.filter((f) => f.retired) ?? [];
  // Retired fields keep their slots so they can come back.
  const left = slotsLeft(fields ?? []), kind: SlotKind | undefined = type === "number" ? "n" : type === "date" ? "d" : type === "boolean" ? "b" : type === "links" ? undefined : "s";
  async function retireField(field: Doc<"fields">) {
    const impact = await impactLines(() => convex.query(api.objects.impact, { orgId, objectId: object._id, fieldId: field._id }));
    if (confirm(`Retire ${field.label}?\n\n${impact}`)) await attempt(() => retire({ orgId, fieldId: field._id }), "Retired");
  }
  return (
    <div className="grid gap-3">
      <ul className="grid divide-y rounded-md border text-sm">
        {live.map((field, index) => (
          <FieldRow
            key={field._id}
            orgId={orgId}
            field={field}
            isTitle={field._id === object.titleFieldId}
            admin={admin}
            move={admin ? <MoveButtons label={field.label} index={index} count={live.length} onMove={(by) => attempt(() => reorder({ orgId, objectId: object._id, fieldIds: moved(live, index, by).map((f) => f._id) }))} /> : null}
            onRetire={() => void attempt(() => retireField(field))}
            onTitle={() => attempt(() => setTitle({ orgId, objectId: object._id, fieldId: field._id }), `${field.label} is now the title`)}
          />
        ))}
      </ul>
      {retired.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">Retired. Values are kept; restore one to bring it back.</span>
          <ul className="grid divide-y rounded-md border text-sm">
            {retired.map((field) => (
              <li key={field._id} className="flex min-h-9 items-center gap-2 px-3 py-1 text-muted-foreground">
                <span className="line-through">{field.label}</span>
                <span className="text-xs">{field.type}</span>
                {admin && (
                  <Button size="xs" variant="ghost" className="ml-auto" onClick={() => attempt(() => restore({ orgId, fieldId: field._id }), "Restored")}>
                    Restore
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
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
          {type === "text" && (
            <label className="flex items-center gap-2 text-sm sm:col-span-3">
              <Checkbox checked={indexed} onCheckedChange={(checked) => setIndexed(checked === true)} aria-label="Searchable and sortable" />
              Searchable and sortable
              <span className="text-xs text-muted-foreground">Uses one of the text slots. Turn off for notes and long text.</span>
            </label>
          )}
          {type === "date" && (
            <label className="flex items-center gap-2 text-sm sm:col-span-3">
              <Checkbox checked={withTime} onCheckedChange={(checked) => setWithTime(checked === true)} aria-label="Keep time of day" />
              Keep time of day
            </label>
          )}
          {linking && (
            <Select value={target} onValueChange={(v) => setTarget(v as Id<"objects">)}>
              <SelectTrigger className="w-full sm:col-span-3" aria-label="Target object">
                <SelectValue placeholder="Links to which object?" />
              </SelectTrigger>
              <SelectContent>
                {objects.filter((o) => !o.archived).map((o) => (
                  <SelectItem key={o._id} value={o._id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="text-xs text-muted-foreground sm:col-span-3" aria-label="Index slots left">
            Searchable and sortable slots left on {object.labelPlural}:{" "}
            {(["s", "n", "d", "b"] as const).map((k, i) => (
              <span key={k} className={k === kind ? "font-medium text-foreground" : undefined}>
                {i > 0 && ", "}
                {SLOT_NAMES[k]} {left[k]} of {capacity[k]}
              </span>
            ))}
            . Text, select and lookup fields share the text slots. A field added when they run out still stores values but cannot sort or filter.
          </p>
        </form>
      )}
    </div>
  );
}

function FieldRow({ orgId, field, isTitle, admin, move, onRetire, onTitle }: { orgId: Id<"orgs">; field: Doc<"fields">; isTitle: boolean; admin: boolean; move: ReactNode; onRetire: () => void; onTitle: () => void }) {
  const update = useMutation(api.fields.update);
  const [draft, setDraft] = useState<string | null>(null);
  const [ordering, setOrdering] = useState(false);
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
      <span className="text-xs text-muted-foreground">{field.type}{field.withTime && " and time"}</span>
      {isTitle && <Badge variant="secondary">title</Badge>}
      {/* Only unindexed fields need a note: they store values but cannot sort or filter. */}
      {!field.slot && field.type !== "links" && <Badge variant="outline" title="Stores values, cannot sort or filter">unindexed</Badge>}
      {!admin && field.protectedFromAgents && <Badge variant="outline" title="Agents cannot change this field">protected from agents</Badge>}
      {admin && !field.retired && (
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <label className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground" title="Agents cannot change this field, even with a grant. People still can.">
            <Checkbox checked={field.protectedFromAgents === true} onCheckedChange={(on) => attempt(() => update({ orgId, fieldId: field._id, protectedFromAgents: on === true }), on === true ? "Protected from agents" : "Agents may edit again")} aria-label={`Protect ${field.label} from agents`} />
            Protect from agents
          </label>
          <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setDraft(field.label)}>
            Rename
          </Button>
          {field.type === "select" && (
            <Button size="xs" variant="ghost" className="text-muted-foreground" aria-expanded={ordering} onClick={() => setOrdering(!ordering)}>
              Order options
            </Button>
          )}
          {!isTitle && field.type === "text" && (
            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={onTitle}>
              Use as title
            </Button>
          )}
          {!isTitle && (
            <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={onRetire}>
              Retire
            </Button>
          )}
          {move}
        </span>
      )}
      {ordering && <OptionOrder orgId={orgId} field={field} />}
    </li>
  );
}

function OptionOrder({ orgId, field }: { orgId: Id<"orgs">; field: Doc<"fields"> }) {
  const reorder = useMutation(api.fields.reorderOptions);
  const options = field.options ?? [];
  return (
    <ol className="grid w-full gap-0.5 rounded-md bg-muted/50 p-1.5 text-[13px]" aria-label={`Order of ${field.label} options`}>
      {options.map((option, index) => (
        <li key={option.id} className="flex items-center gap-1 pl-2">
          <span className="mr-auto">{option.label}</span>
          <MoveButtons label={option.label} index={index} count={options.length} onMove={(by) => attempt(() => reorder({ orgId, fieldId: field._id, optionIds: moved(options, index, by).map((o) => o.id) }))} />
        </li>
      ))}
    </ol>
  );
}
