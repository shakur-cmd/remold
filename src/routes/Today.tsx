import { useEffect } from "react";
import { Link, useOutletContext } from "react-router";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { cn } from "cn";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Loading } from "@/components/Loading";
import { InboxCard } from "@/components/InboxCard";
import { attempt } from "@/lib/errors";
import { formatMoney, localDay, quietFor, relativeDay, timeOfDay } from "@/lib/fields";
import type { OrgContext } from "@/routes/OrgLayout";

// Date fields hold UTC midnight of the chosen day, so "today" is encoded the same way.
const localToday = () => { const now = new Date(); return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()); };

export function Today() {
  const { org, objects } = useOutletContext<OrgContext>();
  const today = localToday();
  const data = useQuery(api.today.get, { orgId: org._id, today });
  const waiting = useQuery(api.suggestions.list, { orgId: org._id, status: "pending" })?.length ?? 0;
  const update = useMutation(api.records.update);
  if (!data) return <Loading />;
  const { task } = data;
  const at = (record: Doc<"records">) => (task ? (record.values[task.dueFieldId] as number) : 0);
  const due = (record: Doc<"records">) => localDay(task?.dueField, at(record));
  const groups = [
    { label: "Overdue", rows: data.tasks.filter((r) => due(r) < today) },
    { label: "Today", rows: data.tasks.filter((r) => due(r) === today) },
    { label: "This week", rows: data.tasks.filter((r) => due(r) > today) },
  ];
  const complete = (recordId: Id<"records">) => task?.doneFieldId && attempt(() => update({ orgId: org._id, recordId, values: { [task.doneFieldId!]: true } }), "Done");

  return (
    <div className="grid max-w-2xl gap-5">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Today</h1>
        {waiting > 0 && (
          <Link to={`/o/${org._id}/suggestions`} className="text-sm text-primary hover:underline">
            {waiting} {waiting === 1 ? "suggestion" : "suggestions"} waiting for you
          </Link>
        )}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Follow-ups</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {data.tasks.length === 0 && <p className="text-sm text-muted-foreground">Nothing due this week. Add a task with a due date from any record and it shows up here.</p>}
          {groups.map((group) =>
            group.rows.length === 0 ? null : (
              <section key={group.label} className="grid gap-0.5">
                <h2 className="px-2 pb-1 text-xs text-muted-foreground">{group.label}</h2>
                {group.rows.map((record) => (
                  <div key={record._id} className="flex h-8 items-center gap-3 rounded-md px-2 hover:bg-muted">
                    {task?.doneFieldId && <Checkbox aria-label={`Mark ${record.title} done`} onCheckedChange={() => complete(record._id)} />}
                    <Link to={`/o/${org._id}/${task!.objectKey}/${record._id}`} className="min-w-0 flex-1 truncate text-sm">
                      {record.title || "Untitled"}
                    </Link>
                    {data.funnels[record._id] && (
                      <Link to={`/o/${org._id}/campaign/${data.funnels[record._id]!._id}`} className="max-w-40 shrink-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground" title="Funnel">
                        {data.funnels[record._id]!.title || "Untitled funnel"}
                      </Link>
                    )}
                    <span className={cn("text-xs tabular-nums", due(record) < today ? "font-medium text-destructive" : "text-muted-foreground")}>
                      {relativeDay(due(record), today)}
                      {task && timeOfDay(task.dueField, at(record)) && ` ${timeOfDay(task.dueField, at(record))}`}
                    </span>
                  </div>
                ))}
              </section>
            ),
          )}
        </CardContent>
      </Card>
      <UnpaidInvoices orgId={org._id} invoice={objects.find((o) => o.key === "invoice")} today={today} />
      {data.quiet.length > 0 && data.dealKey && (
        <Card>
          <CardHeader>
            <CardTitle>Gone quiet</CardTitle>
            <CardDescription>Open opportunities nobody has touched in two weeks.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-0.5">
            {data.quiet.map((record) => (
              <Link key={record._id} to={`/o/${org._id}/${data.dealKey}/${record._id}`} className="flex h-8 items-center gap-3 rounded-md px-2 text-sm hover:bg-muted">
                <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{record.title || "Untitled"}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{quietFor(record.updatedAt)}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
      <InboxCard orgId={org._id} />
    </div>
  );
}

const PAGE = 200, SHOW = 20;

// Unpaid invoices past due. Pages can hold only paid history and come back empty,
// so it keeps loading until it has enough to show or has looked at every invoice.
function UnpaidInvoices({ orgId, invoice, today }: { orgId: Id<"orgs">; invoice?: Doc<"objects">; today: number }) {
  const detail = useQuery(api.objects.get, invoice ? { orgId, objectId: invoice._id } : "skip");
  const { results, status, loadMore } = usePaginatedQuery(api.invoices.pastDue, invoice ? { orgId, today } : "skip", { initialNumItems: PAGE });
  const update = useMutation(api.records.update);
  useEffect(() => { if (status === "CanLoadMore" && results.length < SHOW) loadMore(PAGE); }, [status, results.length, loadMore]);
  const field = (key: string) => detail?.fields.find((f) => f.key === key);
  const due = field("due"), paidOn = field("paidOn"), amount = field("amount");
  const searching = status === "LoadingMore" || (status === "CanLoadMore" && results.length < SHOW);
  if (!invoice || !due || (results.length === 0 && !searching)) return null;
  const paid = (recordId: Id<"records">) => paidOn && attempt(() => update({ orgId, recordId, values: { [paidOn._id]: today } }), "Marked paid today");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Unpaid invoices</CardTitle>
        <CardDescription>Past their due date with no paid date.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-0.5">
        {results.map((record) => {
          const value = amount ? record.values[amount._id] : undefined;
          return (
            <div key={record._id} className="flex h-8 items-center gap-3 rounded-md px-2 hover:bg-muted">
              <Link to={`/o/${orgId}/${invoice.key}/${record._id}`} className="min-w-0 flex-1 truncate text-sm">
                {record.title || "Untitled"}
              </Link>
              {typeof value === "number" && <span className="text-sm tabular-nums">{formatMoney(value)}</span>}
              <span className="text-xs font-medium text-destructive tabular-nums">due {relativeDay(record.values[due._id] as number, today).toLowerCase()}</span>
              {paidOn && (
                <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => paid(record._id)}>
                  Mark paid
                </Button>
              )}
            </div>
          );
        })}
        {searching && <p className="px-2 text-sm text-muted-foreground">Checking older invoices…</p>}
        {status === "CanLoadMore" && !searching && (
          <Button variant="ghost" size="sm" className="justify-self-start text-muted-foreground" onClick={() => loadMore(PAGE)}>
            Load more
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
