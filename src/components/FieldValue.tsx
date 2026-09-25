import { useQuery } from "convex/react";
import { Link } from "react-router";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { type Field, contactHref, formatDate, formatNumber, isEmpty, optionLabel } from "@/lib/fields";

export function RecordLink({ orgId, recordId, plain = false }: { orgId: Id<"orgs">; recordId: Id<"records">; plain?: boolean }) {
  const result = useQuery(api.records.get, { orgId, recordId });
  if (result === undefined) return <span className="text-muted-foreground">…</span>;
  if (result === null) return <span className="text-muted-foreground">missing</span>;
  const title = result.record.title || "Untitled";
  if (plain) return <>{title}</>;
  return (
    <Link className="text-foreground underline decoration-border underline-offset-4 hover:decoration-primary" to={`/o/${orgId}/${result.object.key}/${recordId}`}>
      {title}
    </Link>
  );
}

// `plain` is for values shown inside a button, where a nested link would be invalid.
export function FieldValue({ orgId, field, value, plain = false }: { orgId: Id<"orgs">; field: Field; value: unknown; plain?: boolean }) {
  if (isEmpty(value)) return null;
  const href = plain ? undefined : contactHref(field, value);
  if (href)
    return (
      <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="underline decoration-border underline-offset-4 hover:decoration-primary">
        {String(value)}
      </a>
    );
  switch (field.type) {
    case "select":
      return <Badge variant="secondary">{optionLabel(field, value)}</Badge>;
    case "date":
      return <span className="tabular-nums">{formatDate(value)}</span>;
    case "boolean":
      return <>{value ? "Yes" : "No"}</>;
    case "number":
      return <span className="tabular-nums">{formatNumber(field, value as number)}</span>;
    case "lookup":
      return <RecordLink orgId={orgId} recordId={value as Id<"records">} plain={plain} />;
    case "links":
      return (
        <span className="flex flex-wrap gap-x-2 gap-y-1">
          {(value as Id<"records">[]).map((id) => (
            <RecordLink key={id} orgId={orgId} recordId={id} plain={plain} />
          ))}
        </span>
      );
    default:
      return <span className="whitespace-pre-wrap">{String(value)}</span>;
  }
}
