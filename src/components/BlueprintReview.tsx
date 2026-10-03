import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Checkbox } from "@/components/ui/checkbox";
import { errorMessage } from "@/lib/errors";

type Diff = FunctionReturnType<typeof api.blueprints.preview>;
type Checked = FunctionReturnType<typeof api.blueprints.check>;

// Checks a blueprint by running it in a transaction that is rolled back, so the answer is
// exactly what applying it now would do. Rechecks when the workspace changes underneath.
export function useBlueprintCheck(args: FunctionArgs<typeof api.blueprints.check>, workspace: unknown) {
  const check = useAction(api.blueprints.check);
  const [result, setResult] = useState<Checked | undefined>();
  const key = JSON.stringify(args), version = JSON.stringify(workspace);
  useEffect(() => {
    let live = true;
    check(JSON.parse(key)).then((r) => live && setResult(r), (error) => live && setResult({ ok: false, error: errorMessage(error) }));
    return () => { live = false; };
  }, [check, key, version]);
  return result;
}

// One reviewable diff for a whole blueprint: grouped by object, what retiring or archiving
// touches, index slots after applying, and an explicit opt-in for starter records.
export function BlueprintReview({ orgId, diff, checked, withRecords, onWithRecords }: { orgId: Id<"orgs">; diff: Diff; checked: Checked | undefined; withRecords: boolean; onWithRecords: (on: boolean) => void }) {
  return (
    <div className="grid gap-3 text-[13px]">
      {diff.description && <p className="text-muted-foreground">{diff.description}</p>}
      <div className="grid gap-2">
        {diff.groups.map((group) => (
          <div key={group.key} className="grid gap-0.5">
            <span className="font-medium">{group.title}</span>
            {group.lines.length > 0 && (
              <ul className="grid gap-0.5 pl-3 text-muted-foreground">
                {group.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      {diff.impacts.map((item) => (
        <Impact key={item.label} orgId={orgId} item={item} />
      ))}
      {checked === undefined && <p className="text-xs text-muted-foreground">Checking against your workspace…</p>}
      {checked && !checked.ok && <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">Cannot apply: {checked.error}</p>}
      {checked?.ok && checked.slots.length > 0 && (
        <div className="grid gap-0.5 rounded-md border bg-card px-2.5 py-2">
          <span className="text-xs font-medium">Searchable and sortable slots after applying</span>
          {checked.slots.map((s) => (
            <span key={s.object} className="text-muted-foreground">
              {s.object}: text {s.text}, number {s.number}, date {s.date}, yes/no {s.boolean}
            </span>
          ))}
        </div>
      )}
      {diff.records && (
        <label className="flex items-center gap-2">
          <Checkbox checked={withRecords} onCheckedChange={(on) => onWithRecords(on === true)} aria-label="Also add the starter records" />
          Also add {diff.records}
        </label>
      )}
    </div>
  );
}

function Impact({ orgId, item }: { orgId: Id<"orgs">; item: Diff["impacts"][number] }) {
  const lines = useQuery(api.objects.impact, { orgId, objectId: item.objectId, ...(item.fieldId ? { fieldId: item.fieldId } : {}) });
  return (
    <div className="grid gap-0.5 rounded-md border bg-card px-2.5 py-2">
      <span className="text-xs font-medium">{item.label}: what this touches</span>
      {(lines ?? []).map((line) => (
        <span key={line} className="text-muted-foreground">{line}</span>
      ))}
    </div>
  );
}
