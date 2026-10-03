import { Component, useState, type ReactNode } from "react";
import { Link, useOutletContext } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { SuggestionCard, type SuggestionRow } from "@/components/SuggestionCard";
import { BlueprintReview, useBlueprintCheck } from "@/components/BlueprintReview";
import { Loading } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { formatTime } from "@/lib/fields";
import type { OrgContext } from "@/routes/OrgLayout";

const done = { create: "created", update: "changed", delete: "deleted" } as const;
type ShapeRow = FunctionReturnType<typeof api.shapeSuggestions.list>[number];

// Record changes and shape changes both wait on a person, so the nav badge and Today count both.
export function useWaiting(orgId: Id<"orgs">) {
  const records = useQuery(api.suggestions.list, { orgId, status: "pending" })?.length ?? 0;
  return records + (useQuery(api.shapeSuggestions.list, { orgId, status: "pending" })?.length ?? 0);
}

export function Suggestions() {
  const { org, objects } = useOutletContext<OrgContext>();
  const pending = useQuery(api.suggestions.list, { orgId: org._id, status: "pending" });
  const conflicted = useQuery(api.suggestions.list, { orgId: org._id, status: "conflicted" });
  const applied = useQuery(api.suggestions.list, { orgId: org._id, status: "applied" });
  const shape = useQuery(api.shapeSuggestions.list, { orgId: org._id, status: "pending" });
  const failed = useQuery(api.shapeSuggestions.list, { orgId: org._id, status: "failed" });
  if (!pending || !conflicted || !applied || !shape || !failed) return <Loading />;
  return (
    <div className="grid max-w-2xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Suggestions</h1>
        <p className="text-sm text-muted-foreground">Changes your agents proposed. Nothing lands until someone applies it.</p>
      </div>
      <Section title="Waiting for you" count={pending.length + shape.length}>
        {pending.length + shape.length === 0 && <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">Nothing waiting. When an agent proposes a change it appears here.</p>}
        {shape.map((row) => (row.blueprint ? <BlueprintCard key={row._id} orgId={org._id} row={row} workspace={objects} /> : <ShapeCard key={row._id} orgId={org._id} row={row} />))}
        {pending.map((row) => (
          <SuggestionCard key={row.suggestion._id} orgId={org._id} row={row} />
        ))}
      </Section>
      {conflicted.length > 0 && (
        <Section title="Changed underneath" count={conflicted.length}>
          {conflicted.map((row) => (
            <SuggestionCard key={row.suggestion._id} orgId={org._id} row={row} />
          ))}
        </Section>
      )}
      {failed.length > 0 && (
        <Section title="Could not apply" count={failed.length}>
          {failed.slice(0, 10).map((row) => (
            <ShapeCard key={row._id} orgId={org._id} row={row} />
          ))}
        </Section>
      )}
      {applied.length > 0 && (
        <Section title="Recently applied">
          <ul className="grid divide-y rounded-lg border bg-card">
            {applied.slice(0, 20).map((row) => (
              <AppliedLine key={row.suggestion._id} orgId={org._id} row={row} />
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h2 className="text-sm font-semibold">
        {title}
        {!!count && <span className="ml-2 font-normal text-muted-foreground tabular-nums">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function AppliedLine({ orgId, row }: { orgId: Id<"orgs">; row: SuggestionRow }) {
  const { suggestion, agentName, objectKey, objectLabel, recordTitle, recordRef } = row;
  const recordId = suggestion.change.recordId ?? suggestion.recordId;
  const target = recordTitle || recordRef || `a ${(objectLabel ?? "record").toLowerCase()}`;
  return (
    <li className="flex items-baseline gap-1.5 px-3 py-2 text-[13px]">
      <span className="font-medium">{agentName ?? "An agent"}</span>
      <span className="text-muted-foreground">{done[suggestion.change.action]}</span>
      {recordId ? (
        <Link to={`/o/${orgId}/${objectKey}/${recordId}`} className="min-w-0 truncate hover:text-primary">
          {target}
        </Link>
      ) : (
        <span className="min-w-0 truncate">{target}</span>
      )}
      <time className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{formatTime(suggestion.resolvedAt ?? suggestion._creationTime)}</time>
    </li>
  );
}

// An agent's proposed change to objects or fields, in the words the server wrote for it.
function ShapeCard({ orgId, row }: { orgId: Id<"orgs">; row: ShapeRow }) {
  const apply = useMutation(api.shapeSuggestions.apply);
  const dismiss = useMutation(api.shapeSuggestions.dismiss);
  const [busy, setBusy] = useState(false);
  const pending = row.status === "pending";
  async function act(action: () => Promise<{ status: string; error?: string }>, success: string) {
    setBusy(true);
    try {
      const result = await action();
      if (result.status === "failed") toast.warning(`Could not apply: ${result.error}`);
      else if (result.status === "already") toast.message("Already handled");
      else toast.success(success);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={pending ? "grid gap-3 rounded-lg border border-primary/30 bg-accent/60 p-3 text-sm" : "grid gap-3 rounded-lg border bg-card p-3 text-sm"}>
      <div className="grid gap-1">
        <span className="text-xs text-muted-foreground">{row.agentName ?? "An agent"} wants to change the workspace</span>
        <span className="font-medium">{row.summary}</span>
        {row.details.length > 0 && (
          <ul className="grid gap-0.5 text-[13px] text-muted-foreground">
            {row.details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </div>
      {row.preview && (
        <ImpactBoundary>
          <Impact orgId={orgId} preview={row.preview} />
        </ImpactBoundary>
      )}
      <p className="text-muted-foreground">“{row.reason}”</p>
      {row.error && <p className="text-xs text-destructive">{row.error}</p>}
      {row.paused && <p className="text-xs text-muted-foreground">This agent's access changed since it asked. Dismiss it, or make the change yourself in Settings.</p>}
      {pending && (
        <div className="flex gap-2">
          {!row.paused && (
            // Outline, not filled, like SuggestionCard: filled teal is kept to one per screen.
            <Button size="sm" variant="outline" className="border-primary/40 text-primary hover:bg-primary hover:text-primary-foreground" disabled={busy} onClick={() => act(() => apply({ orgId, id: row._id }), "Applied")}>
              Apply
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => dismiss({ orgId, id: row._id }), "Dismissed")}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

function Impact({ orgId, preview }: { orgId: Id<"orgs">; preview: NonNullable<ShapeRow["preview"]> }) {
  const impact = useQuery(api.objects.impact, { orgId, ...preview });
  if (!impact?.length) return null;
  return (
    <div className="grid gap-0.5 rounded-md border bg-card px-2.5 py-2 text-[13px]">
      <span className="text-xs font-medium">What this touches</span>
      {impact.map((line) => (
        <span key={line} className="text-muted-foreground">{line}</span>
      ))}
    </div>
  );
}

// A preview that fails stays inside its own card, so every other proposal still shows.
class ImpactBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <p className="text-xs text-destructive">Could not count what this touches: {errorMessage(this.state.error)}</p>;
  }
}

// A whole blueprint is one card: the grouped diff, a check that runs it and rolls it back,
// and Apply, which applies all of it or, if anything no longer fits, none of it.
function BlueprintCard({ orgId, row, workspace }: { orgId: Id<"orgs">; row: ShapeRow; workspace: unknown }) {
  const apply = useAction(api.shapeSuggestions.applyBlueprint);
  const dismiss = useMutation(api.shapeSuggestions.dismiss);
  const [busy, setBusy] = useState(false);
  const [withRecords, setWithRecords] = useState(false);
  const checked = useBlueprintCheck({ orgId, id: row._id, withRecords }, workspace);
  async function act(action: () => Promise<{ status: string; error?: string }>, success: string) {
    setBusy(true);
    try {
      const result = await action();
      if (result.status === "failed") toast.warning(`Nothing was applied: ${result.error}`);
      else if (result.status === "already") toast.message("Already handled");
      else toast.success(success);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-3 rounded-lg border border-primary/30 bg-accent/60 p-3 text-sm">
      <div className="grid gap-1">
        <span className="text-xs text-muted-foreground">{row.agentName ?? "An agent"} wants to reshape the workspace</span>
        <span className="font-medium">{row.summary}</span>
      </div>
      <BlueprintReview orgId={orgId} diff={row.blueprint!} checked={checked} withRecords={withRecords} onWithRecords={setWithRecords} />
      <p className="text-muted-foreground">“{row.reason}”</p>
      {row.paused && <p className="text-xs text-muted-foreground">This agent's access changed since it asked. Dismiss it, or make the change yourself in Settings.</p>}
      <div className="flex gap-2">
        {!row.paused && (
          <Button size="sm" variant="outline" className="border-primary/40 text-primary hover:bg-primary hover:text-primary-foreground" disabled={busy || !checked?.ok} onClick={() => act(() => apply({ orgId, id: row._id, withRecords }), "Applied")}>
            Apply all
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => dismiss({ orgId, id: row._id }), "Dismissed")}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
