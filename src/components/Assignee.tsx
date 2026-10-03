import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Field } from "@/lib/fields";

// A task's assignee is stored as text but is chosen from, and shown as, the workspace's people and agents.
// Any other field named "assignee" stays plain text.
export const isAssignee = (field: Field) => field.type === "text" && field.key === "assignee";
const NONE = "__none";

function useAssignees(orgId: Id<"orgs">, field: Field) {
  const objects = useQuery(api.objects.list, { orgId });
  const isTask = objects?.find((o) => o._id === field.objectId)?.key === "task";
  return { isTask, people: useQuery(api.queue.assignees, isTask ? { orgId } : "skip") };
}

export function AssigneeName({ orgId, field, value }: { orgId: Id<"orgs">; field: Field; value: string }) {
  const { isTask, people } = useAssignees(orgId, field);
  if (!isTask) return <span className="whitespace-pre-wrap">{value}</span>;
  return <span>{people ? (people.find((p) => p.id === value)?.name ?? "Former member") : "…"}</span>;
}

export function AssigneeInput({ orgId, field, value, onChange, autoFocus }: { orgId: Id<"orgs">; field: Field; value: string; onChange: (v: unknown) => void; autoFocus?: boolean }) {
  const { isTask, people } = useAssignees(orgId, field);
  if (!isTask) return <Input id={field._id} autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} />;
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger id={field._id} className="w-full">
        <SelectValue placeholder="Unassigned" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Unassigned</SelectItem>
        {value && !people?.some((p) => p.id === value) && <SelectItem value={value}>Former member</SelectItem>}
        {people?.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
            {p.kind === "agent" && " (agent)"}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
