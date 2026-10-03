import { Link } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { Pause, Play } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { attempt } from "@/lib/errors";
import { formatTime } from "@/lib/fields";

type Ref = { id: string; ref?: string | null; object?: string; title?: string };
const STATUS: Record<string, string> = { done: "Done", failed: "Failed", refused: "Refused", skipped: "Skipped", queued: "Waiting" };

// An automation in plain words, its switch, and what it did.
export function AutomationPanel({ orgId, recordId }: { orgId: Id<"orgs">; recordId: Id<"records"> }) {
  const view = useQuery(api.automations.view, { orgId, recordId });
  const setOn = useMutation(api.automations.setOn);
  if (!view) return null;
  const on = view.status === "on";
  const link = (item: Ref) => (item.object && item.title !== undefined ? <Link key={item.id} to={`/o/${orgId}/${item.object}/${item.id}`} className="hover:underline">{item.title || "Untitled"}</Link> : <span key={item.id} className="text-muted-foreground">a record you cannot see</span>);

  return (
    <section className="grid min-w-0 gap-3 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">What it does</h2>
        {on ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-1.5 rounded-full bg-emerald-500" aria-hidden /> On</span>
        ) : (
          <span className="text-xs text-muted-foreground">{view.status === "paused" ? "Paused" : "Draft, not running"}</span>
        )}
        <div className="ml-auto">
          {on ? (
            <Button size="sm" variant="outline" onClick={() => attempt(() => setOn({ orgId, recordId, on: false }), "Automation paused")}><Pause /> Pause</Button>
          ) : (
            <Button size="sm" onClick={() => attempt(() => setOn({ orgId, recordId, on: true }), "Automation on")}><Play /> Turn on</Button>
          )}
        </div>
      </div>
      <p className="text-base">{view.sentence}.</p>
      {view.actions.length > 0 && (
        <ol className="grid list-decimal gap-1 pl-5 text-sm text-muted-foreground">
          {view.actions.map((line, i) => <li key={i}>{line}</li>)}
        </ol>
      )}
      {!on && <p className="text-xs text-muted-foreground">It runs as you, with your access, once you turn it on. Changing what it does later pauses it until someone turns it on again.</p>}
      {view.dailyLimit === 0 && <p className="text-xs text-amber-700 dark:text-amber-400">Automations cannot run on this server yet: its daily limit is 0.</p>}
      <div className="grid gap-1">
        <h3 className="text-xs font-medium text-muted-foreground">Run history</h3>
        {view.runs.length === 0 && <p className="text-sm text-muted-foreground">No runs yet.</p>}
        <ul className="grid gap-1.5">
          {view.runs.map((run) => (
            <li key={run.id} className="grid gap-0.5 text-sm">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge variant={run.status === "done" ? "secondary" : run.status === "failed" || run.status === "refused" ? "destructive" : "outline"}>{STATUS[run.status] ?? run.status}</Badge>
                <span className="text-xs tabular-nums text-muted-foreground">{formatTime(run.at)}</span>
                {run.trigger && <span className="text-xs">for {link(run.trigger)}</span>}
                {run.enabledBy && <span className="text-xs text-muted-foreground">as {run.enabledBy}</span>}
              </div>
              {run.created.length > 0 && <p className="text-xs text-muted-foreground">Created {run.created.map((item, i) => <span key={item.id}>{i > 0 && ", "}{link(item)}</span>)}</p>}
              {run.error && <p className="text-xs text-destructive">{run.error}</p>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
