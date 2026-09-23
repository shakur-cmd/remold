import { useQuery } from "convex/react";
import { Link } from "react-router";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { type Field, contactHref, dateToInput, isEmpty, optionLabel } from "@/lib/fields";

export function RecordLink({ orgId, recordId }: { orgId: Id<"orgs">; recordId: Id<"records"> }) {
  const result = useQuery(api.records.get, { orgId, recordId });
  if (result === undefined) return <span className="text-muted-foreground">…</span>;
  if (result === null) return <span className="text-muted-foreground">missing</span>;
  return (
    <Link className="underline decoration-muted-foreground/50 underline-offset-4" to={`/o/${orgId}/${result.object.key}/${recordId}`}>
      {result.record.title || "Untitled"}
    </Link>
  );
}

// `plain` is for values shown inside a button, where a nested link would be invalid.
export function FieldValue({ orgId, field, value, plain = false }: { orgId: Id<"orgs">; field: Field; value: unknown; plain?: boolean }) {
  if (isEmpty(value)) return <span className="text-muted-foreground">·</span>;
  const href = plain ? undefined : contactHref(field, value);
  if (href)
    return (
      <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="underline decoration-muted-foreground/50 underline-offset-4">
        {String(value)}
      </a>
    );
  switch (field.type) {
    case "select":
      return <Badge variant="secondary">{optionLabel(field, value)}</Badge>;
    case "date":
      return <>{dateToInput(value)}</>;
    case "boolean":
      return <>{value ? "Yes" : "No"}</>;
    case "number":
      return <>{(value as number).toLocaleString()}</>;
    case "lookup":
      return <RecordLink orgId={orgId} recordId={value as Id<"records">} />;
    case "links":
      return (
        <span className="flex flex-wrap gap-x-2 gap-y-1">
          {(value as Id<"records">[]).map((id) => (
            <RecordLink key={id} orgId={orgId} recordId={id} />
          ))}
        </span>
      );
    default:
      return <span className="whitespace-pre-wrap">{String(value)}</span>;
  }
}
