import { useState, type FormEvent } from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { FieldValue } from "@/components/FieldValue";
import { Loading } from "@/components/Loading";
import { RecordForm } from "@/components/RecordForm";
import { errorMessage } from "@/lib/errors";
import { dateToInput, isEmpty, optionLabel, type Field } from "@/lib/fields";
import type { OrgContext } from "@/routes/OrgLayout";

export function RecordPage() {
  const { org } = useOutletContext<OrgContext>();
  const recordId = useParams().recordId as Id<"records">;
  return <Record key={recordId} orgId={org._id} recordId={recordId} />;
}

function Record({ orgId, recordId }: { orgId: Id<"orgs">; recordId: Id<"records"> }) {
  const detail = useQuery(api.records.get, { orgId, recordId });
  const reverse = useQuery(api.records.reverseFields, detail ? { orgId, objectId: detail.object._id } : "skip");
  const update = useMutation(api.records.update);
  const remove = useMutation(api.records.remove);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);

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
  const shown = fields.filter((f) => f._id !== object.titleFieldId && !f.retired);

  async function destroy() {
    if (!confirm(`Delete this ${object.label.toLowerCase()}? The history stays in the timeline.`)) return;
    try {
      await remove({ orgId, recordId });
      toast.success(`${object.label} deleted`);
      navigate(`/o/${orgId}/${object.key}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="grid content-start gap-6">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0">
            <Link to={`/o/${orgId}/${object.key}`} className="text-xs uppercase tracking-wide text-muted-foreground">
              {object.labelPlural}
            </Link>
            <h1 className="truncate text-2xl font-semibold tracking-tight">{record.title || "Untitled"}</h1>
          </div>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={destroy}>
              Delete
            </Button>
          </div>
        </div>

        <dl className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
          {shown.map((field) => (
            <div key={field._id} className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">{field.label}</dt>
              <dd className="text-sm">
                <FieldValue orgId={orgId} field={field} value={record.values[field._id]} />
              </dd>
            </div>
          ))}
        </dl>

        {reverse?.map(({ field, object: source }) => (
          <RelatedPanel key={field._id} orgId={orgId} recordId={recordId} field={field} source={source} />
        ))}
      </div>

      <Timeline orgId={orgId} recordId={recordId} fields={fields} />

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit {object.label}</DialogTitle>
          </DialogHeader>
          <RecordForm
            orgId={orgId}
            fields={fields}
            initial={record.values}
            onCancel={() => setEditing(false)}
            onSubmit={async (values) => {
              await update({ orgId, recordId, values });
              setEditing(false);
              toast.success("Saved");
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RelatedPanel({ orgId, recordId, field, source }: { orgId: Id<"orgs">; recordId: Id<"records">; field: Field; source: Doc<"objects"> }) {
  const { results, status, loadMore } = usePaginatedQuery(api.records.related, { orgId, recordId, fieldId: field._id }, { initialNumItems: 20 });
  const isNote = source.key === "note";
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          {source.labelPlural}
          {field.targetObjectId ? "" : ""} <span className="font-normal text-muted-foreground">via {field.label}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {isNote && <NoteComposer orgId={orgId} noteObject={source} aboutField={field} recordId={recordId} />}
        {results.map((related) => (
          <Link key={related._id} to={`/o/${orgId}/${source.key}/${related._id}`} className="rounded-md border px-3 py-2 text-sm hover:bg-accent">
            <span className="whitespace-pre-wrap">{related.title || "Untitled"}</span>
          </Link>
        ))}
        {status !== "LoadingFirstPage" && results.length === 0 && <span className="text-sm text-muted-foreground">None yet</span>}
        {status === "CanLoadMore" && (
          <Button variant="ghost" size="sm" onClick={() => loadMore(20)}>
            More
          </Button>
        )}
      </CardContent>
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

function Timeline({ orgId, recordId, fields }: { orgId: Id<"orgs">; recordId: Id<"records">; fields: Field[] }) {
  const events = useQuery(api.events.forRecord, { orgId, recordId });
  const byId = new Map(fields.map((f) => [f._id, f]));
  const show = (field: Field | undefined, value: unknown) => {
    if (isEmpty(value)) return "empty";
    if (!field) return String(value);
    if (field.type === "select") return optionLabel(field, value);
    if (field.type === "date") return dateToInput(value);
    if (field.type === "lookup" || field.type === "links") return "a linked record";
    return String(value);
  };
  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="text-base">Timeline</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {events === undefined && <span className="text-sm text-muted-foreground">Loading</span>}
        {events?.map((event) => (
          <div key={event._id} className="grid gap-1 text-sm">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{event.actorName}</span>
              <span className="text-muted-foreground">{event.action === "create" ? "created" : event.action === "delete" ? "deleted" : "changed"}</span>
              <time className="ml-auto text-xs text-muted-foreground">{new Date(event._creationTime).toLocaleString()}</time>
            </div>
            {event.action === "update" && event.after && (
              <ul className="grid gap-0.5 text-muted-foreground">
                {Object.keys(event.after).map((fieldId) => (
                  <li key={fieldId}>
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
      </CardContent>
    </Card>
  );
}
