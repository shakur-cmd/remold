import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { Copy, ExternalLink, Mail, MoreHorizontal, Phone, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { FieldValue } from "@/components/FieldValue";
import { Loading } from "@/components/Loading";
import { FieldInput, RecordForm } from "@/components/RecordForm";
import { errorMessage } from "@/lib/errors";
import { contactHref, dateToInput, isEmpty, optionLabel, type Field } from "@/lib/fields";
import { cn } from "@/lib/utils";
import type { OrgContext } from "@/routes/OrgLayout";

export function RecordPage() {
  const { org } = useOutletContext<OrgContext>();
  const recordId = useParams().recordId as Id<"records">;
  return <Record key={recordId} orgId={org._id} recordId={recordId} />;
}

function Record({ orgId, recordId }: { orgId: Id<"orgs">; recordId: Id<"records"> }) {
  const detail = useQuery(api.records.get, { orgId, recordId });
  const reverse = useQuery(api.records.reverseFields, detail ? { orgId, objectId: detail.object._id } : "skip");
  const remove = useMutation(api.records.remove);
  const navigate = useNavigate();
  const [showEmpty, setShowEmpty] = useState(false);

  if (detail === undefined) return <Loading />;
  if (detail === null)
    return (
      <div className="grid gap-2">
        <p className="text-muted-foreground">This record does not exist or you cannot see it.</p>
        <Link to={`/o/${orgId}`} className="underline">
          Back
        </Link>
      </div>
    );
  const { record, object, fields } = detail;
  const live = fields.filter((f) => !f.retired);
  const titleField = live.find((f) => f._id === object.titleFieldId);
  const rest = live.filter((f) => f._id !== object.titleFieldId);
  const filled = rest.filter((f) => !isEmpty(record.values[f._id]));
  const empty = rest.filter((f) => isEmpty(record.values[f._id]));
  const shown = showEmpty ? rest : filled;

  async function destroy() {
    if (!confirm(`Delete this ${object.label.toLowerCase()}? Its history stays in the timeline.`)) return;
    try {
      await remove({ orgId, recordId });
      toast.success(`${object.label} deleted`);
      navigate(`/o/${orgId}/${object.key}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="grid min-w-0 content-start gap-6">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <Link to={`/o/${orgId}/${object.key}`} className="text-xs uppercase tracking-wide text-muted-foreground">
              {object.labelPlural}
            </Link>
            {titleField ? (
              <InlineField orgId={orgId} recordId={recordId} field={titleField} value={record.values[titleField._id]} title />
            ) : (
              <h1 className="text-2xl font-semibold tracking-tight">{record.title || "Untitled"}</h1>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {record.ref && <RefBadge value={record.ref} />}
              <span className="mt-1 text-xs text-muted-foreground">
                Created {new Date(record._creationTime).toLocaleDateString()} · Updated {new Date(record.updatedAt).toLocaleDateString()}
              </span>
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

        <div className="grid gap-2">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border p-3 sm:grid-cols-2">
            {shown.map((field) => (
              <div key={field._id} className="grid min-w-0 gap-0.5">
                <dt className="px-2 text-xs text-muted-foreground">{field.label}</dt>
                <dd className="min-w-0 text-sm">
                  <InlineField orgId={orgId} recordId={recordId} field={field} value={record.values[field._id]} />
                </dd>
              </div>
            ))}
            {shown.length === 0 && <p className="px-2 text-sm text-muted-foreground">Nothing filled in yet</p>}
          </dl>
          {empty.length > 0 && (
            <Button variant="ghost" size="sm" className="justify-self-start text-muted-foreground" onClick={() => setShowEmpty((v) => !v)}>
              {showEmpty ? "Hide empty fields" : `Show ${empty.length} empty ${empty.length === 1 ? "field" : "fields"}`}
            </Button>
          )}
        </div>

        {reverse?.map(({ field, object: source }) => (
          <RelatedPanel key={field._id} orgId={orgId} recordId={recordId} field={field} source={source} />
        ))}
      </div>

      <Timeline orgId={orgId} recordId={recordId} fields={fields} />
    </div>
  );
}

// The code is what a person pastes into a prompt so an agent finds this exact record.
function RefBadge({ value }: { value: string }) {
  return (
    <button
      type="button"
      className="mt-1 inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground hover:text-foreground"
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
    try {
      await update({ orgId, recordId, values: { [field._id]: next ?? null } });
      setEditing(false);
    } catch (error) {
      toast.error(errorMessage(error));
    }
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
          "block w-full min-w-0 rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:hover:bg-transparent",
          title ? "text-2xl font-semibold tracking-tight" : "min-h-9",
        )}
      >
        {title ? (value as string) || "Untitled" : <FieldValue orgId={orgId} field={field} value={value} plain />}
      </button>
    );
    if (!href) return view;
    return (
      <div className="flex min-w-0 items-center gap-1">
        {view}
        <Button asChild variant="ghost" size="icon" className="shrink-0" aria-label={`Open ${field.label.toLowerCase()}`}>
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
          <Button type="submit" size="sm">
            Save
          </Button>
        )}
      </div>
    </form>
  );
}

function RelatedPanel({ orgId, recordId, field, source }: { orgId: Id<"orgs">; recordId: Id<"records">; field: Field; source: Doc<"objects"> }) {
  const { results, status, loadMore } = usePaginatedQuery(api.records.related, { orgId, recordId, fieldId: field._id }, { initialNumItems: 20 });
  const sourceDetail = useQuery(api.objects.get, { orgId, objectId: source._id });
  const create = useMutation(api.records.create);
  const [adding, setAdding] = useState(false);
  const isNote = source.key === "note";
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">
          {source.labelPlural} <span className="font-normal text-muted-foreground">via {field.label}</span>
        </CardTitle>
        {!isNote && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus /> Add
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-2">
        {isNote && <NoteComposer orgId={orgId} noteObject={source} aboutField={field} recordId={recordId} />}
        {results.map((related) => (
          <Link key={related._id} to={`/o/${orgId}/${source.key}/${related._id}`} className="min-w-0 rounded-md border px-3 py-2 text-sm hover:bg-accent">
            <span className="whitespace-pre-wrap break-words">{related.title || "Untitled"}</span>
          </Link>
        ))}
        {status !== "LoadingFirstPage" && results.length === 0 && <span className="text-sm text-muted-foreground">None yet</span>}
        {status === "CanLoadMore" && (
          <Button variant="ghost" size="sm" onClick={() => loadMore(20)}>
            More
          </Button>
        )}
      </CardContent>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New {source.label}</DialogTitle>
          </DialogHeader>
          {sourceDetail && (
            <RecordForm
              orgId={orgId}
              fields={sourceDetail.fields}
              hidden={[field._id]}
              submitLabel="Create"
              onCancel={() => setAdding(false)}
              onSubmit={async (values) => {
                // The relation back to this record is filled in for the user.
                await create({ orgId, objectId: source._id, values: { ...values, [field._id]: field.type === "links" ? [recordId] : recordId } });
                setAdding(false);
                toast.success(`${source.label} added`);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function NoteComposer({ orgId, noteObject, aboutField, recordId }: { orgId: Id<"orgs">; noteObject: Doc<"objects">; aboutField: Field; recordId: Id<"records"> }) {
  const detail = useQuery(api.objects.get, { orgId, objectId: noteObject._id });
  const create = useMutation(api.records.create);
  const [body, setBody] = useState("");
  const bodyField = detail?.fields.find((f) => f.key === "body");
  if (!bodyField) return null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await create({ orgId, objectId: noteObject._id, values: { [bodyField!._id]: body.trim(), [aboutField._id]: recordId } });
      setBody("");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }
  return (
    <form onSubmit={submit} className="grid gap-2">
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note" rows={2} />
      <Button size="sm" className="justify-self-end" disabled={!body.trim()}>
        Add note
      </Button>
    </form>
  );
}

const TIMELINE_PREVIEW = 5;

function Timeline({ orgId, recordId, fields }: { orgId: Id<"orgs">; recordId: Id<"records">; fields: Field[] }) {
  const events = useQuery(api.events.forRecord, { orgId, recordId });
  const [expanded, setExpanded] = useState(false);
  const byId = new Map(fields.map((f) => [f._id, f]));
  const show = (field: Field | undefined, value: unknown) => {
    if (isEmpty(value)) return "empty";
    if (!field) return String(value);
    if (field.type === "select") return optionLabel(field, value);
    if (field.type === "date") return dateToInput(value);
    if (field.type === "lookup" || field.type === "links") return "a linked record";
    return String(value);
  };
  const visible = expanded ? events : events?.slice(0, TIMELINE_PREVIEW);
  return (
    <Card className="h-fit min-w-0">
      <CardHeader>
        <CardTitle className="text-base">Timeline</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {events === undefined && <span className="text-sm text-muted-foreground">Loading</span>}
        {visible?.map((event) => (
          <div key={event._id} className="grid min-w-0 gap-1 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{event.actorName}</span>
              <span className="text-muted-foreground">{event.action === "create" ? "created" : event.action === "delete" ? "deleted" : "changed"}</span>
              <time className="ml-auto text-xs text-muted-foreground">{new Date(event._creationTime).toLocaleString()}</time>
            </div>
            {event.action === "update" && event.after && (
              <ul className="grid gap-0.5 text-muted-foreground">
                {Object.keys(event.after).map((fieldId) => (
                  <li key={fieldId} className="break-words">
                    {byId.get(fieldId as Id<"fields">)?.label ?? "Field"}: {show(byId.get(fieldId as Id<"fields">), event.before?.[fieldId])}
                    {" to "}
                    <span className="text-foreground">{show(byId.get(fieldId as Id<"fields">), event.after?.[fieldId])}</span>
                  </li>
                ))}
              </ul>
            )}
            {event.reason && <p className="text-muted-foreground">{event.reason}</p>}
          </div>
        ))}
        {events && events.length > TIMELINE_PREVIEW && (
          <Button variant="ghost" size="sm" className="justify-self-start text-muted-foreground" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show less" : `Show all ${events.length}`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
