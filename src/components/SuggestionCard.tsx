import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { cn } from "cn";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldValue } from "@/components/FieldValue";
import { errorMessage } from "@/lib/errors";
import type { Field } from "@/lib/fields";

export type SuggestionRow = FunctionReturnType<typeof api.suggestions.list>[number];

const verb = { create: "wants to create", update: "wants to change", delete: "wants to delete" } as const;

// One proposed change: who, what, the values as they were and as they would
// be, and the two buttons. A conflict shows what changed underneath it.
export function SuggestionCard({ orgId, row }: { orgId: Id<"orgs">; row: SuggestionRow }) {
  const { suggestion, agentName, objectKey, objectLabel, recordTitle, recordRef } = row;
  const detail = useQuery(api.objects.get, { orgId, objectId: suggestion.change.objectId });
  const apply = useMutation(api.suggestions.apply);
  const dismiss = useMutation(api.suggestions.dismiss);
  const [busy, setBusy] = useState(false);
  const fields = new Map<string, Field>((detail?.fields ?? []).map((f) => [f._id, f]));
  const order = [...fields.keys()];
  const entries = Object.entries(suggestion.change.values).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  const pending = suggestion.status === "pending";
  const conflicted = suggestion.status === "conflicted";
  const target = suggestion.change.recordId ? (
    <Link to={`/o/${orgId}/${objectKey}/${suggestion.change.recordId}`} className="font-medium underline decoration-border underline-offset-4 hover:decoration-primary">
      {recordTitle || recordRef || "a record"}
    </Link>
  ) : (
    <span>a {(objectLabel ?? "record").toLowerCase()}</span>
  );

  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      const result = (await action()) as { status?: string; conflicts?: unknown[] } | undefined;
      if (result?.status === "conflicted") toast.warning("Someone changed this first. Check both values below.");
      else if (result?.status === "already") toast.message("Already handled");
      else toast.success(success);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("grid gap-3 rounded-lg border p-3 text-sm", pending ? "border-primary/30 bg-accent/60" : "bg-card")}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium">{agentName ?? "An agent"}</span>
        <span className="text-muted-foreground">{verb[suggestion.change.action]}</span>
        {target}
        {!pending && (
          <Badge variant={conflicted ? "destructive" : "outline"} className="ml-auto">
            {conflicted ? "changed underneath" : suggestion.status}
          </Badge>
        )}
      </div>
      {suggestion.change.action !== "delete" && (
        <ul className="grid gap-1">
          {entries.map(([fieldId, value]) => {
            const field = fields.get(fieldId);
            const was = suggestion.before[fieldId];
            const conflict = suggestion.conflicts?.find((c) => c.fieldId === fieldId);
            return (
              <li key={fieldId} className="grid gap-0.5">
                <span className="text-xs text-muted-foreground">{field?.label ?? "Field"}</span>
                <span className="flex flex-wrap items-center gap-x-2">
                  {suggestion.change.action === "update" && field && (
                    <>
                      <span className="text-muted-foreground line-through"><FieldValue orgId={orgId} field={field} value={was} plain /></span>
                      <span className="text-muted-foreground">→</span>
                    </>
                  )}
                  {field ? <FieldValue orgId={orgId} field={field} value={value} plain /> : String(value)}
                </span>
                {conflict && field && (
                  <span className="text-xs text-destructive">
                    Now <FieldValue orgId={orgId} field={field} value={conflict.actual} plain /> on the record, not what the agent saw.
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-muted-foreground">“{suggestion.reason}”</p>
      {(pending || conflicted) && (
        <div className="flex gap-2">
          {pending && (
            // Outline, not filled: a page can hold several of these, and filled teal is kept to one per screen.
            <Button size="sm" variant="outline" className="border-primary/40 text-primary hover:bg-primary hover:text-primary-foreground" disabled={busy} onClick={() => act(() => apply({ orgId, suggestionId: suggestion._id }), "Applied")}>
              Apply
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => dismiss({ orgId, suggestionId: suggestion._id }), "Dismissed")}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
