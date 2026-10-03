import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { cn } from "cn";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FieldValue } from "@/components/FieldValue";
import { errorMessage } from "@/lib/errors";

export type BatchRow = FunctionReturnType<typeof api.batches.list>[number];
type ItemRow = FunctionReturnType<typeof api.batches.items>["page"][number];
type Filter = "conflicted" | "failed" | undefined;

const PAGE = 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const itemStatus = { queued: "", applied: "applied", conflicted: "skipped", failed: "failed" } as const;

// Many changes from one agent under one reason: what it would do, a paged preview, and
// Apply all. While it runs the card shows progress; afterwards, what was skipped and why.
export function BatchCard({ orgId, row }: { orgId: Id<"orgs">; row: BatchRow }) {
  const apply = useMutation(api.batches.apply);
  const dismiss = useMutation(api.batches.dismiss);
  const recount = useMutation(api.batches.recount);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>();
  const pending = row.status === "pending";
  const stale = useStale(row);
  const counts = [row.counts.update && plural(row.counts.update, "update"), row.counts.create && plural(row.counts.create, "new record"), row.counts.delete && plural(row.counts.delete, "delete")].filter(Boolean).join(" · ");

  async function act(action: () => Promise<{ status: string }>, success: string) {
    setBusy(true);
    try {
      const result = await action();
      if (result.status === "already") toast.message("Already handled");
      else toast.success(success);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("grid gap-3 rounded-lg border p-3 text-sm", pending ? "border-primary/30 bg-accent/60" : "bg-card")}>
      <div className="grid gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs text-muted-foreground">
            {row.agentName ?? "An agent"} {row.mode === "direct" ? "made" : pending ? "wants to make" : "asked for"} {plural(row.total, "change")}
          </span>
          {!pending && <Badge variant={row.status === "stopped" ? "destructive" : "outline"} className="ml-auto">{row.status === "done" ? "finished" : row.status}</Badge>}
        </div>
        <span className="font-medium">{row.summary}</span>
        <span className="text-[13px] text-muted-foreground">{counts}</span>
        {row.counting && <span className="text-[13px] text-muted-foreground">Counting what deleting would clear…</span>}
        {row.countError && (
          <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-destructive">
            {row.countError}.
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={busy} onClick={() => act(() => recount({ orgId, batchId: row._id }), "Counting again")}>
              Retry
            </Button>
          </span>
        )}
        {!!row.impact && <span className="text-[13px] text-destructive">Deleting also clears {row.impactPartial ? `${row.impact}+ links` : plural(row.impact, "link")} from other records.</span>}
      </div>
      {row.reason && <p className="text-muted-foreground">“{row.reason}”</p>}
      {!pending && <Progress row={row} />}
      {row.error && <p className="text-xs text-destructive">{row.error}</p>}
      {row.paused && <p className="text-xs text-muted-foreground">This agent's access changed since it asked. Dismiss it, or make the changes yourself.</p>}
      {row.status === "done" && row.progress.conflicted + row.progress.failed > 0 && (
        <div className="flex gap-1">
          {([[undefined, "All", 1], ["conflicted", `Skipped ${row.progress.conflicted}`, row.progress.conflicted], ["failed", `Failed ${row.progress.failed}`, row.progress.failed]] as const).filter(([, , n]) => n > 0).map(([value, label]) => (
            <Button key={label} size="sm" variant={filter === value ? "secondary" : "ghost"} className="h-7 px-2 text-xs" onClick={() => setFilter(value)}>
              {label}
            </Button>
          ))}
        </div>
      )}
      <Preview key={filter ?? "all"} orgId={orgId} batchId={row._id} filter={filter} showStatus={!pending} />
      {(pending || row.status === "stopped" || stale) && (
        <div className="flex gap-2">
          {!row.paused && (
            // Outline, not filled, like SuggestionCard: filled teal is kept to one per screen.
            <Button size="sm" variant="outline" className="border-primary/40 text-primary hover:bg-primary hover:text-primary-foreground" disabled={busy || row.counting || !!row.countError} onClick={() => act(() => apply({ orgId, batchId: row._id }), pending ? "Applying" : "Resumed")}>
              {!pending ? "Resume" : row.total === 1 ? "Apply" : `Apply all ${row.total}`}
            </Button>
          )}
          {(pending || row.status === "stopped") && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => dismiss({ orgId, batchId: row._id }), "Dismissed")}>
              Dismiss
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// A driver that has not reported for a minute probably died, so the card offers Resume
// (resuming never applies an item twice). A timer re-renders the card when that minute is up.
const STALE_MS = 60_000;
function useStale(row: BatchRow) {
  const watching = row.status === "applying" && row.progressAt !== null, [, setNow] = useState(0);
  useEffect(() => {
    if (!watching) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, row.progressAt! + STALE_MS + 1 - Date.now()));
    return () => clearTimeout(timer);
  }, [watching, row.progressAt]);
  return watching && Date.now() - row.progressAt! > STALE_MS;
}

function Progress({ row }: { row: BatchRow }) {
  const { done, applied, conflicted, failed } = row.progress;
  return (
    <div className="grid gap-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round((done / Math.max(row.total, 1)) * 100)}%` }} />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        Applied {applied} of {row.total}
        {conflicted > 0 && `, skipped ${conflicted} changed since review`}
        {failed > 0 && `, ${failed} failed`}
      </span>
    </div>
  );
}

function Preview({ orgId, batchId, filter, showStatus }: { orgId: Id<"orgs">; batchId: Id<"batches">; filter: Filter; showStatus: boolean }) {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const page = useQuery(api.batches.items, { orgId, batchId, ...(filter ? { status: filter } : {}), paginationOpts: { cursor: cursors.at(-1)!, numItems: PAGE } });
  if (!page) return <div className="h-24 animate-pulse rounded-md bg-muted/60" />;
  return (
    <div className="grid gap-1">
      <div className="overflow-hidden rounded-md border bg-background">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Record</TableHead>
              <TableHead>Change</TableHead>
              {showStatus && <TableHead className="w-20" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.page.map((item) => (
              <TableRow key={item._id}>
                <TableCell className="text-muted-foreground tabular-nums">{item.index + 1}</TableCell>
                <TableCell className="max-w-40 truncate">
                  {item.recordId && item.action !== "delete" ? (
                    <Link to={`/o/${orgId}/${item.objectKey}/${item.recordId}`} className="hover:text-primary">{item.recordTitle || "Untitled"}</Link>
                  ) : (
                    <span>{item.recordTitle || `New ${item.objectLabel.toLowerCase()}`}</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-normal">
                  <Change orgId={orgId} item={item} />
                </TableCell>
                {showStatus && (
                  <TableCell className={cn("text-xs", item.status === "applied" ? "text-muted-foreground" : "text-destructive")} title={item.error ?? undefined}>
                    {itemStatus[item.status]}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {(cursors.length > 1 || !page.isDone) && (
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={cursors.length === 1} onClick={() => setCursors(cursors.slice(0, -1))}>
            Previous
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">Page {cursors.length}</span>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={page.isDone} onClick={() => setCursors([...cursors, page.continueCursor])}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function Change({ orgId, item }: { orgId: Id<"orgs">; item: ItemRow }) {
  if (item.action === "delete") return <span className="text-destructive">Delete{item.impact ? `, clears ${plural(item.impact, "link")}` : ""}</span>;
  return (
    <span className="grid gap-0.5">
      {item.changes.map((change) => (
        <span key={change.fieldId} className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-muted-foreground">{change.label}</span>
          {item.action === "update" && change.field && change.before !== null && (
            <>
              <span className="text-muted-foreground line-through"><FieldValue orgId={orgId} field={change.field} value={change.before} plain /></span>
              <span className="text-muted-foreground">→</span>
            </>
          )}
          {change.field ? <FieldValue orgId={orgId} field={change.field} value={change.after} plain /> : String(change.after)}
          {change.after === null && <span className="text-muted-foreground">cleared</span>}
        </span>
      ))}
      {item.links.map((link) => (
        <span key={link.fieldId} className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-muted-foreground">{link.label}</span>
          {link.add.length > 0 && <span>add {link.add.join(", ")}</span>}
          {link.remove.length > 0 && <span className="text-destructive">remove {link.remove.join(", ")}</span>}
        </span>
      ))}
      {item.status === "conflicted" && <span className="text-xs text-destructive">Changed since review, so it was skipped</span>}
      {item.error && <span className="text-xs text-destructive">{item.error}</span>}
    </span>
  );
}
