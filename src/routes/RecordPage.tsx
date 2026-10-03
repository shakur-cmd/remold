import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { cn } from "cn";
import { Copy, ExternalLink, Mail, MoreHorizontal, Phone, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Board } from "@/components/Board";
import { AutomationPanel } from "@/components/AutomationPanel";
import { CampaignEmails } from "@/components/CampaignEmails";
import { PageBookings } from "@/components/Bookings";
import { FieldValue } from "@/components/FieldValue";
import { Loading } from "@/components/Loading";
import { SuggestionCard } from "@/components/SuggestionCard";
import { FieldInput, RecordForm } from "@/components/RecordForm";
import { attempt } from "@/lib/errors";
import { usePinnedPages } from "@/lib/pages";
import { invoiceStatus } from "@/lib/invoices";
import { contactHref, formatContact, formatDate, formatFieldDate, formatMoney, formatTime, isEmpty, isSlotted, localDay, localToday, relativeDay, timeOfDay, type Field } from "@/lib/fields";
import type { OrgContext } from "@/routes/OrgLayout";

type Reverse = { field: Field; object: Doc<"objects"> };

export function RecordPage() {
  const { org, role } = useOutletContext<OrgContext>();
  const recordId = useParams().recordId as Id<"records">;
  return <Record key={recordId} orgId={org._id} recordId={recordId} admin={role === "owner" || role === "admin"} />;
}

function Record({ orgId, recordId, admin }: { orgId: Id<"orgs">; recordId: Id<"records">; admin: boolean }) {
  const detail = useQuery(api.records.get, { orgId, recordId });
  const reverse = useQuery(api.records.reverseFields, detail ? { orgId, objectId: detail.object._id } : "skip");
  const contact = useQuery(api.records.lastContact, detail?.object.key === "person" ? { orgId, recordIds: [recordId] } : "skip")?.[recordId];
  const remove = useMutation(api.records.remove);
  const navigate = useNavigate();
  const [showEmpty, setShowEmpty] = useState(false);

  if (detail === undefined) return <Loading />;
  if (detail === null)
    return (
      <div className="grid gap-2 text-sm">
        <p className="text-muted-foreground">This record does not exist or you cannot see it.</p>
        <Link to={`/o/${orgId}`} className="text-primary hover:underline">
          Back to Today
        </Link>
      </div>
    );
  const { record, object, fields } = detail;
  const live = fields.filter((f) => !f.retired);
  const titleField = live.find((f) => f._id === object.titleFieldId);
  // A campaign is a funnel: its status and goal lead, its deals show as a board and its tasks as steps.
  const funnel = object.key === "campaign";
  const headline = funnel ? live.filter((f) => f.key === "status" || f.key === "goal") : [];
  const rest = live.filter((f) => f._id !== object.titleFieldId && !headline.includes(f));
  const empty = rest.filter((f) => isEmpty(record.values[f._id]));
  const shown = showEmpty ? rest : rest.filter((f) => !isEmpty(record.values[f._id]));
  // Notes and activities about this record live in the timeline, not in panels of their own.
  const about = (key: string) => reverse?.find((r) => r.object.key === key && r.field.key === "about" && r.field.type === "lookup" && !r.field.targetObjectId);
  const inTimeline = [about("note"), about("activity")];
  const steps = funnel ? about("task") : undefined;
  const deals = funnel ? reverse?.find((r) => r.object.key === "opportunity" && r.field.key === "campaign" && r.field.type === "lookup") : undefined;
  // Its emails get their own section with numbers and the go switch.
  const emails = funnel ? reverse?.find((r) => r.object.key === "email" && r.object.isStandard && r.field.key === "campaign") : undefined;
  const statusField = headline.find((f) => f.key === "status" && f.type === "select");
  // Tasks pointing at this record through a single lookup feed the next step; "blocked by" lists are not next steps.
  const taskSources = steps ? [] : (reverse ?? []).filter((r) => r.object.key === "task" && r.field.type === "lookup").slice(0, 2);

  // What needs a decision comes first: beside the record on wide screens, under its header on phones.
  const act = (
    <>
      <PendingSuggestions orgId={orgId} recordId={recordId} />
      {steps && <Steps orgId={orgId} recordId={recordId} entry={steps} />}
      {taskSources.length > 0 && <NextStep orgId={orgId} recordId={recordId} sources={taskSources} />}
    </>
  );

  async function destroy() {
    if (!confirm(`Delete this ${object.label.toLowerCase()}? Its history stays in the timeline.`)) return;
    if (await attempt(() => remove({ orgId, recordId }), `${object.label} deleted`)) navigate(`/o/${orgId}/${object.key}`);
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="grid min-w-0 content-start gap-5">
        <div className="flex min-w-0 items-start gap-2">
          <div className="grid min-w-0 flex-1 gap-1">
            <Link to={`/o/${orgId}/${object.key}`} className="text-xs text-muted-foreground hover:text-foreground">
              {object.labelPlural}
            </Link>
            {titleField ? (
              <InlineField orgId={orgId} recordId={recordId} field={titleField} value={record.values[titleField._id]} title />
            ) : (
              <h1 className="text-2xl font-semibold tracking-tight">{record.title || "Untitled"}</h1>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
              {record.ref && <RefBadge value={record.ref} />}
              <span>
                Created {formatTime(record._creationTime)} · Updated {formatTime(record.updatedAt)}
              </span>
              {contact !== undefined && <span>Last contact {formatContact(contact)}</span>}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={destroy}>
                Delete {object.label.toLowerCase()}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {headline.length > 0 && (
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border bg-card p-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
            {headline.map((field) => (
              <div key={field._id} className="grid min-w-0 gap-0.5">
                <span className="px-2 text-xs text-muted-foreground">{field.label}</span>
                <InlineField orgId={orgId} recordId={recordId} field={field} value={record.values[field._id]} />
              </div>
            ))}
          </div>
        )}

        <div className="grid gap-5 lg:hidden">{act}</div>

        {object.key === "automation" && object.isStandard && <AutomationPanel orgId={orgId} recordId={recordId} />}
        {emails && <CampaignEmails orgId={orgId} recordId={recordId} admin={admin} status={statusField && { field: statusField, value: record.values[statusField._id] }} />}
        {object.isStandard && object.key === "bookingPage" && <PageBookings orgId={orgId} recordId={recordId} />}
        {deals && <FunnelDeals orgId={orgId} recordId={recordId} entry={deals} />}

        <div className="grid gap-1">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border bg-card p-3 sm:grid-cols-2">
            {shown.map((field) => (
              <div key={field._id} className="grid min-w-0 gap-0.5">
                <dt className="px-2 text-xs text-muted-foreground">{field.label}</dt>
                <dd className="min-w-0 text-sm">
                  <InlineField orgId={orgId} recordId={recordId} field={field} value={record.values[field._id]} />
                </dd>
              </div>
            ))}
            {shown.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">Nothing filled in yet</p>}
          </dl>
          {empty.length > 0 && (
            <Button variant="ghost" size="sm" className="justify-self-start text-muted-foreground" onClick={() => setShowEmpty((v) => !v)}>
              {showEmpty ? "Hide empty fields" : `Show ${empty.length} empty ${empty.length === 1 ? "field" : "fields"}`}
            </Button>
          )}
        </div>

        {/* Tasks that feed the next step are listed there, not twice. */}
        {reverse?.filter((entry) => !taskSources.includes(entry) && !inTimeline.includes(entry) && entry !== steps && entry !== deals && entry !== emails).map((entry) =>
          entry.object.key === "invoice" && entry.field.key === "company" ? (
            <InvoicesPanel key={entry.field._id} orgId={orgId} recordId={recordId} entry={entry} />
          ) : (
            <RelatedPanel key={entry.field._id} orgId={orgId} recordId={recordId} entry={entry} showVia={reverse.filter((r) => r.object._id === entry.object._id).length > 1} />
          ),
        )}
      </div>

      <div className="grid min-w-0 content-start gap-5">
        <div className="hidden gap-5 lg:grid">{act}</div>
        <Timeline orgId={orgId} recordId={recordId} fields={fields} note={inTimeline[0]} activity={inTimeline[1]} />
      </div>
    </div>
  );
}

// The code is what a person pastes into a prompt so an agent finds this exact record.
function RefBadge({ value }: { value: string }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:text-foreground"
      onClick={() => navigator.clipboard?.writeText(value).then(() => toast.success("Code copied"))}
      title="Copy code"
    >
      {value} <Copy className="size-3" />
    </button>
  );
}

// Tap a value to edit it in place. Selects and checkboxes save on change;
// everything else saves on Enter or the Save button.
function InlineField({ orgId, recordId, field, value, title = false }: { orgId: Id<"orgs">; recordId: Id<"records">; field: Field; value: unknown; title?: boolean }) {
  const update = useMutation(api.records.update);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<unknown>(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const readOnly = field.type === "lookup" && !field.targetObjectId;
  const instant = field.type === "select" || field.type === "boolean" || field.type === "lookup";

  async function save(next: unknown) {
    if (await attempt(() => update({ orgId, recordId, values: { [field._id]: next ?? null } }))) setEditing(false);
  }

  if (!editing || readOnly) {
    const href = title ? undefined : contactHref(field, value);
    const Icon = href?.startsWith("tel:") ? Phone : href?.startsWith("mailto:") ? Mail : ExternalLink;
    const view = (
      <button
        type="button"
        disabled={readOnly}
        onClick={() => setEditing(true)}
        className={cn(
          "block w-full min-w-0 rounded-md px-2 text-left hover:bg-muted disabled:hover:bg-transparent",
          title ? "-mx-2 w-[calc(100%+1rem)] py-0.5 text-2xl font-semibold tracking-tight" : "min-h-8 py-1.5",
        )}
      >
        {title ? (value as string) || "Untitled" : isEmpty(value) ? <span className="text-muted-foreground">Add</span> : <FieldValue orgId={orgId} field={field} value={value} plain />}
      </button>
    );
    if (!href) return view;
    return (
      <div className="flex min-w-0 items-center gap-1">
        {view}
        <Button asChild variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={`Open ${field.label.toLowerCase()}`}>
          <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
            <Icon />
          </a>
        </Button>
      </div>
    );
  }
  return (
    <form
      className="grid gap-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void save(draft);
      }}
    >
      <FieldInput orgId={orgId} field={field} value={draft} autoFocus onChange={(v) => (instant ? void save(v) : setDraft(v))} />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        {!instant && (
          <Button type="submit" size="sm" variant="outline">
            Save
          </Button>
        )}
      </div>
    </form>
  );
}

// A new record of `source` with its relation back to this record already filled in.
function AddRelatedDialog({ orgId, recordId, entry, open, onOpenChange }: { orgId: Id<"orgs">; recordId: Id<"records">; entry: Reverse; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { field, object: source } = entry;
  const detail = useQuery(api.objects.get, open ? { orgId, objectId: source._id } : "skip");
  const create = useMutation(api.records.create);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New {source.label.toLowerCase()}</DialogTitle>
        </DialogHeader>
        {detail && (
          <RecordForm
            orgId={orgId}
            fields={detail.fields}
            hidden={[field._id]}
            submitLabel="Create"
            onCancel={() => onOpenChange(false)}
            onSubmit={async (values) => {
              await create({ orgId, objectId: source._id, values: { ...values, [field._id]: field.type === "links" ? [recordId] : recordId } });
              onOpenChange(false);
              toast.success(`${source.label} added`);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// A company's invoices with what was billed, what is paid and what is still open.
function InvoicesPanel({ orgId, recordId, entry }: { orgId: Id<"orgs">; recordId: Id<"records">; entry: Reverse }) {
  const data = useQuery(api.invoices.forCompany, { orgId, recordId });
  // Totals add up every page, independent of how many invoices are listed.
  const sums = usePaginatedQuery(api.invoices.totals, { orgId, recordId }, { initialNumItems: 500 });
  const { status, loadMore } = sums;
  useEffect(() => { if (status === "CanLoadMore") loadMore(500); }, [status, loadMore]);
  const [adding, setAdding] = useState(false);
  const today = Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  if (!data) return null;
  const { fields: f } = data;
  const number = (r: Doc<"records">, id: Id<"fields"> | null) => (id && typeof r.values[id] === "number" ? (r.values[id] as number) : null);
  const rows = [...data.invoices].sort((a, b) => (number(b, f.due) ?? b._creationTime) - (number(a, f.due) ?? a._creationTime));
  const complete = status === "Exhausted", known = sums.results.every((s) => s.known);
  const billed = sums.results.reduce((t, s) => t + s.billed, 0), paid = sums.results.reduce((t, s) => t + s.paid, 0);
  const totals = [
    { label: "Billed", value: known ? billed : null },
    { label: "Paid", value: known ? paid : null },
    { label: "Open", value: known ? billed - paid : null },
  ];
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          Invoices
          {rows.length > 0 && <span className="ml-2 font-normal text-muted-foreground tabular-nums">{rows.length}{data.capped ? "+" : ""}</span>}
        </CardTitle>
        <CardAction>
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setAdding(true)}>
            <Plus /> Add
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        {rows.length > 0 && (
          <dl className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/40 p-3">
            {totals.map((total) => (
              <div key={total.label} className="grid gap-0.5">
                <dt className="text-xs text-muted-foreground">{total.label}</dt>
                <dd className={cn("text-sm font-medium tabular-nums", !complete && "text-muted-foreground")}>{total.value === null ? "Hidden" : formatMoney(total.value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {rows.length > 0 && !complete && <p className="-mt-2 px-1 text-xs text-muted-foreground">Still counting older invoices; totals so far.</p>}
        <div className="grid gap-0.5">
          {rows.map((r) => {
            const amount = number(r, f.amount), due = number(r, f.due), paidOn = number(r, f.paidOn);
            const status = invoiceStatus({ due, paidOn, paymentHidden: data.paymentHidden.includes(r._id), today });
            return (
              <Link key={r._id} to={`/o/${orgId}/${data.objectKey}/${r._id}`} className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                <span className="shrink-0">{r.title || "Untitled"}</span>
                {f.monthly && r.values[f.monthly] === true && <Badge variant="outline" className="shrink-0">Monthly</Badge>}
                <span className={cn("ml-auto min-w-0 truncate text-xs tabular-nums", status.overdue ? "font-medium text-destructive" : "text-muted-foreground")}>{status.label}</span>
                <span className="w-20 shrink-0 text-right tabular-nums">{amount === null ? "—" : formatMoney(amount)}</span>
              </Link>
            );
          })}
          {rows.length === 0 && <span className="px-2 text-sm text-muted-foreground">None yet</span>}
        </div>
      </CardContent>
      <AddRelatedDialog orgId={orgId} recordId={recordId} entry={entry} open={adding} onOpenChange={setAdding} />
    </Card>
  );
}

function RelatedPanel({ orgId, recordId, entry, showVia }: { orgId: Id<"orgs">; recordId: Id<"records">; entry: Reverse; showVia: boolean }) {
  const { field, object: source } = entry;
  const { results, status, loadMore } = usePaginatedQuery(api.records.related, { orgId, recordId, fieldId: field._id }, { initialNumItems: 20 });
  const [adding, setAdding] = useState(false);
  const isNote = source.key === "note";
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          {source.labelPlural}
          {showVia && <span className="font-normal text-muted-foreground"> via {field.label}</span>}
          {results.length > 0 && <span className="ml-2 font-normal text-muted-foreground tabular-nums">{results.length}{status === "CanLoadMore" ? "+" : ""}</span>}
        </CardTitle>
        {!isNote && (
          <CardAction>
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setAdding(true)}>
              <Plus /> Add
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-1">
        {isNote && <NoteComposer orgId={orgId} note={source} about={field} recordId={recordId} />}
        {results.map((related) => (
          <Link key={related._id} to={`/o/${orgId}/${source.key}/${related._id}`} className={cn("min-w-0 rounded-md px-2 py-1.5 text-sm hover:bg-muted", isNote && "border bg-muted/40 px-3 py-2")}>
            <span className="whitespace-pre-wrap break-words">{related.title || "Untitled"}</span>
          </Link>
        ))}
        {status !== "LoadingFirstPage" && results.length === 0 && !isNote && <span className="px-2 text-sm text-muted-foreground">None yet</span>}
        {status === "CanLoadMore" && (
          <Button variant="ghost" size="sm" className="justify-self-start text-muted-foreground" onClick={() => loadMore(20)}>
            Load more
          </Button>
        )}
      </CardContent>
      {!isNote && <AddRelatedDialog orgId={orgId} recordId={recordId} entry={entry} open={adding} onOpenChange={setAdding} />}
    </Card>
  );
}

function NoteComposer({ orgId, note, about, recordId }: { orgId: Id<"orgs">; note: Doc<"objects">; about: Field; recordId: Id<"records"> }) {
  const detail = useQuery(api.objects.get, { orgId, objectId: note._id });
  const create = useMutation(api.records.create);
  const [body, setBody] = useState("");
  const bodyField = detail?.fields.find((f) => f.key === "body");
  if (!bodyField) return null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (await attempt(() => create({ orgId, objectId: note._id, values: { [bodyField!._id]: body.trim(), [about._id]: recordId } }))) setBody("");
  }
  return (
    <form onSubmit={submit} className="mb-2 grid gap-2">
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note" rows={2} aria-label="New note" />
      {body.trim() && (
        <Button size="sm" variant="outline" className="justify-self-end">
          Add note
        </Button>
      )}
    </form>
  );
}

// Open tasks pointing at this record, earliest due first: what happens next, above the history.
function NextStep({ orgId, recordId, sources }: { orgId: Id<"orgs">; recordId: Id<"records">; sources: Reverse[] }) {
  // Hooks cannot run in a loop, so two relations are read: the standard Task has two (Project, About).
  // A third custom lookup to tasks would still show as its own panel, since only these two are hidden.
  const [first, second] = sources;
  const a = usePaginatedQuery(api.records.related, { orgId, recordId, fieldId: first!.field._id }, { initialNumItems: 50 });
  const b = usePaginatedQuery(api.records.related, second ? { orgId, recordId, fieldId: second.field._id } : "skip", { initialNumItems: 50 });
  const task = useQuery(api.objects.get, { orgId, objectId: first!.object._id });
  const update = useMutation(api.records.update);
  const [adding, setAdding] = useState(false);
  if (!task || a.status === "LoadingFirstPage") return null;
  const due = task.fields.find((f) => f.key === "dueDate");
  const done = task.fields.find((f) => f.key === "done");
  const dueOf = (r: Doc<"records">) => (due ? (r.values[due._id] as number | undefined) : undefined) ?? Infinity;
  const all = [...new Map([...a.results, ...b.results].map((r) => [r._id, r])).values()];
  const open = all.filter((r) => !done || r.values[done._id] !== true).sort((x, y) => dueOf(x) - dueOf(y));
  const dayOf = (r: Doc<"records">) => localDay(due, dueOf(r));
  const today = localToday();
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Next step</CardTitle>
        <CardAction>
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setAdding(true)}>
            <Plus /> Task
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-0.5">
        {open.length === 0 && (
          <p className="flex items-center gap-2 px-2 text-sm text-muted-foreground">
            <span className="size-1.5 rounded-full bg-warning" aria-hidden /> No next step yet
          </p>
        )}
        {open.map((item, index) => (
          <div key={item._id} className={cn("flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted", index > 0 && "text-muted-foreground")}>
            {done && <Checkbox aria-label={`Mark ${item.title} done`} onCheckedChange={() => attempt(() => update({ orgId, recordId: item._id, values: { [done._id]: true } }), "Done")} />}
            <Link to={`/o/${orgId}/${first!.object.key}/${item._id}`} className={cn("min-w-0 flex-1 truncate text-sm", index === 0 && "font-medium")}>
              {item.title || "Untitled"}
            </Link>
            {dueOf(item) !== Infinity && (
              <span className={cn("text-xs tabular-nums", dayOf(item) < today ? "font-medium text-destructive" : "text-muted-foreground")}>
                {relativeDay(dayOf(item), today)}
                {timeOfDay(due, dueOf(item)) && ` ${timeOfDay(due, dueOf(item))}`}
              </span>
            )}
          </div>
        ))}
        {all.length > open.length && <p className="px-2 pt-1 text-xs text-muted-foreground">{all.length - open.length} done</p>}
      </CardContent>
      <AddRelatedDialog orgId={orgId} recordId={recordId} entry={first!} open={adding} onOpenChange={setAdding} />
    </Card>
  );
}

// A funnel's deals on a board by stage, each column counted and summed over the whole funnel.
function FunnelDeals({ orgId, recordId, entry }: { orgId: Id<"orgs">; recordId: Id<"records">; entry: Reverse }) {
  const deal = useQuery(api.objects.get, { orgId, objectId: entry.object._id });
  const [adding, setAdding] = useState(false);
  if (!deal) return null;
  const selects = deal.fields.filter((f) => f.type === "select" && !f.retired && isSlotted(f));
  const stage = selects.find((f) => f.key === "stage") ?? selects[0];
  return (
    <section className="grid min-w-0 gap-2">
      <div className="flex items-center">
        <h2 className="text-sm font-semibold">{entry.object.labelPlural}</h2>
        <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={() => setAdding(true)}>
          <Plus /> Add
        </Button>
      </div>
      {stage && isSlotted(entry.field) ? (
        <Board orgId={orgId} object={deal.object} groupBy={stage} fields={deal.fields} filters={[{ fieldId: entry.field._id, value: recordId }]} />
      ) : (
        <RelatedPanel orgId={orgId} recordId={recordId} entry={entry} showVia={false} />
      )}
      <AddRelatedDialog orgId={orgId} recordId={recordId} entry={entry} open={adding} onOpenChange={setAdding} />
    </section>
  );
}

// A funnel's steps: tasks about it in the server's due order (undated last), done ones
// included and crossed out. Typing a title and Enter adds one; the due date is optional.
function Steps({ orgId, recordId, entry }: { orgId: Id<"orgs">; recordId: Id<"records">; entry: Reverse }) {
  const { results: rows, status, loadMore } = usePaginatedQuery(api.records.steps, { orgId, recordId }, { initialNumItems: 100 });
  const task = useQuery(api.objects.get, { orgId, objectId: entry.object._id });
  const create = useMutation(api.records.create);
  const update = useMutation(api.records.update);
  const [params] = useSearchParams();
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState<unknown>(null);
  if (!task) return null;
  const titleField = task.fields.find((f) => f._id === task.object.titleFieldId);
  const due = task.fields.find((f) => f.key === "dueDate" && f.type === "date" && !f.retired);
  const done = task.fields.find((f) => f.key === "done" && f.type === "boolean" && !f.retired);
  const dueOf = (r: Doc<"records">) => (due ? (r.values[due._id] as number | undefined) : undefined) ?? Infinity;
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const open = rows.filter((r) => !done || r.values[done._id] !== true).length;

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!titleField || !title.trim()) return;
    const values = { [titleField._id]: title.trim(), [entry.field._id]: recordId, ...(due && when != null ? { [due._id]: when } : {}) };
    if (await attempt(() => create({ orgId, objectId: entry.object._id, values }))) {
      setTitle("");
      setWhen(null);
    }
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          Steps
          {rows.length > 0 && <span className="ml-2 font-normal text-muted-foreground tabular-nums">{rows.length - open}/{rows.length} done</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-0.5">
        {status !== "LoadingFirstPage" && rows.length === 0 && <p className="px-2 pb-1 text-sm text-muted-foreground">No steps yet. Add the first one below.</p>}
        {rows.map((item) => {
          const finished = !!done && item.values[done._id] === true;
          const at = dueOf(item), day = localDay(due, at);
          return (
            <div key={item._id} className="flex min-h-8 items-center gap-3 rounded-md px-2 py-1 hover:bg-muted">
              {done && <Checkbox checked={finished} aria-label={`Mark ${item.title} ${finished ? "not done" : "done"}`} onCheckedChange={(checked) => attempt(() => update({ orgId, recordId: item._id, values: { [done._id]: checked === true } }))} />}
              <Link to={`/o/${orgId}/${entry.object.key}/${item._id}`} className={cn("min-w-0 flex-1 truncate text-sm", finished && "text-muted-foreground line-through")}>
                {item.title || "Untitled"}
              </Link>
              {at !== Infinity && (
                <span className={cn("shrink-0 text-xs tabular-nums", !finished && day < today ? "font-medium text-destructive" : "text-muted-foreground")}>
                  {relativeDay(day, today)}
                  {timeOfDay(due, at) && ` ${timeOfDay(due, at)}`}
                </span>
              )}
            </div>
          );
        })}
        {status === "CanLoadMore" && (
          <Button variant="ghost" size="sm" className="justify-self-start text-muted-foreground" onClick={() => loadMore(100)}>
            Load more
          </Button>
        )}
        {titleField && (
          <form onSubmit={add} className="mt-2 grid gap-2 border-t pt-3">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a step" aria-label="New step" autoFocus={params.has("steps")} />
            {title.trim() && (
              <div className="flex items-center gap-2">
                {due && (
                  <div className="min-w-0 flex-1" aria-label="Step due">
                    <FieldInput orgId={orgId} field={due} value={when} onChange={setWhen} />
                  </div>
                )}
                <Button size="sm" variant="outline" className="ml-auto">
                  Add step
                </Button>
              </div>
            )}
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function PendingSuggestions({ orgId, recordId }: { orgId: Id<"orgs">; recordId: Id<"records"> }) {
  const rows = useQuery(api.suggestions.forRecord, { orgId, recordId });
  if (!rows?.length) return null;
  return (
    <div className="grid gap-2">
      <h2 className="text-sm font-semibold">Suggested</h2>
      {rows.map((row) => (
        <SuggestionCard key={row.suggestion._id} orgId={orgId} row={row} />
      ))}
    </div>
  );
}

const TIMELINE_PREVIEW = 5;

// Change history merged with the activities, notes and tasks about this record, newest first.
function Timeline({ orgId, recordId, fields, note, activity }: { orgId: Id<"orgs">; recordId: Id<"records">; fields: Field[]; note?: Reverse; activity?: Reverse }) {
  // The server merges and orders history with related activities, notes and tasks; pages arrive in order.
  const { results: entries, status, loadMore } = usePinnedPages<FunctionReturnType<typeof api.events.timeline>["page"][number]>(api.events.timeline, { orgId, recordId }, 20);
  const [expanded, setExpanded] = useState(false);
  const [logging, setLogging] = useState(false);
  const byId = new Map(fields.map((f) => [f._id, f]));
  const show = (field: Field | undefined, value: unknown) =>
    isEmpty(value) ? <span className="italic">empty</span> : field ? <FieldValue orgId={orgId} field={field} value={value} plain /> : String(value);
  const more = status === "CanLoadMore" || status === "LoadingMore";
  const visible = expanded ? entries : entries.slice(0, TIMELINE_PREVIEW);
  const loading = status === "LoadingFirstPage";
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        {activity && (
          <CardAction>
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setLogging(true)}>
              <Plus /> Log activity
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        {note && <NoteComposer orgId={orgId} note={note.object} about={note.field} recordId={recordId} />}
        {loading && <span className="text-sm text-muted-foreground">Loading</span>}
        {visible.map((entry) => (
          <div key={entry._id} className="grid min-w-0 gap-0.5 border-l-2 pl-3 text-[13px]">
            {entry.kind !== "event" ? (
              <>
                <div className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="font-medium">{entry.kind === "activity" ? (entry.type ?? "Activity") : entry.kind === "note" ? "Note" : "Task"}</span>
                  {entry.kind === "activity" && entry.source && <span className="text-muted-foreground">via {entry.source}</span>}
                  {entry.kind === "task" && entry.done && <span className="text-muted-foreground">done</span>}
                  <time className="ml-auto text-xs text-muted-foreground tabular-nums">{entry.kind === "activity" && entry.allDay ? formatDate(entry.at) : formatTime(entry.at)}</time>
                </div>
                <Link to={`/o/${orgId}/${entry.objectKey}/${entry._id}`} className={cn("min-w-0 break-words hover:underline", entry.kind === "note" && "whitespace-pre-wrap", entry.kind === "task" && entry.done && "text-muted-foreground line-through")}>
                  {entry.title || "Untitled"}
                </Link>
                {entry.kind === "task" && typeof entry.due === "number" && <span className="text-muted-foreground">Due {formatFieldDate({ withTime: entry.dueWithTime } as Field, entry.due)}</span>}
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-baseline gap-x-1.5">
                  <span className="font-medium">{entry.actorName ?? (entry.actor.kind === "agent" ? "An agent" : "Automation")}</span>
                  <span className="text-muted-foreground">
                    {entry.action === "create" ? "created this" : entry.action === "delete" ? "deleted this" : "changed"}
                    {entry.appliedByName && `, applied by ${entry.appliedByName}`}
                  </span>
                  <time className="ml-auto text-xs text-muted-foreground tabular-nums">{formatTime(entry.at)}</time>
                </div>
                {entry.action === "update" && entry.after && (
                  <ul className="grid gap-0.5 text-muted-foreground">
                    {Object.keys(entry.after).map((fieldId) => {
                      const field = byId.get(fieldId as Id<"fields">);
                      return (
                        <li key={fieldId} className="break-words">
                          {field?.label ?? "Field"}: {show(field, entry.before?.[fieldId])} → <span className="text-foreground">{show(field, entry.after?.[fieldId])}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {entry.reason && <p className="text-muted-foreground">“{entry.reason}”</p>}
              </>
            )}
          </div>
        ))}
        <div className="flex flex-wrap gap-1">
          {entries.length > TIMELINE_PREVIEW && (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show less" : `Show all ${entries.length}${more ? "+" : ""}`}
            </Button>
          )}
          {expanded && more && (
            <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={status === "LoadingMore"} onClick={() => loadMore(100)}>
              Load more
            </Button>
          )}
        </div>
      </CardContent>
      {activity && <AddRelatedDialog orgId={orgId} recordId={recordId} entry={activity} open={logging} onOpenChange={setLogging} />}
    </Card>
  );
}
