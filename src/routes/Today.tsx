import { Link, useOutletContext } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { cn } from "cn";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Loading } from "@/components/Loading";
import { InboxCard } from "@/components/InboxCard";
import { attempt } from "@/lib/errors";
import { localSpan } from "@/lib/calendar";
import { uniqueById, useFollow } from "@/lib/pages";
import { localDay, localToday, optionLabel, quietFor, relativeDay, timeOfDay } from "@/lib/fields";
import type { OrgContext } from "@/routes/OrgLayout";

export function Today() {
  const { org } = useOutletContext<OrgContext>();
  const today = localToday();
  const { start, end } = localSpan(today, today);
  const data = useQuery(api.today.get, { orgId: org._id, today, start, end });
  const waiting = useQuery(api.suggestions.list, { orgId: org._id, status: "pending" })?.length ?? 0;
  const update = useMutation(api.records.update);
  // The first page of today's posts comes with the day; a busy day continues here.
  const rest = useFollow<{ posts: Doc<"records">[]; done: boolean; cursor: string | null }>(api.today.posts, data && !data.postsDone && data.postsCursor ? { orgId: org._id, today, start, end } : null, data?.postsCursor ?? undefined);
  if (!data) return <Loading />;
  const { task } = data;
  const at = (record: Doc<"records">) => (task ? (record.values[task.dueFieldId] as number) : 0);
  const due = (record: Doc<"records">) => localDay(task?.dueField, at(record));
  const groups = [
    { label: "Overdue", rows: data.tasks.filter((r) => due(r) < today) },
    { label: "Today", rows: data.tasks.filter((r) => due(r) === today) },
    { label: "This week", rows: data.tasks.filter((r) => due(r) > today) },
  ];
  const planned = (record: Doc<"records">) => (data.post ? (record.values[data.post.plannedFieldId] as number) : 0);
  const posts = uniqueById([...data.posts, ...rest.pages.flatMap((page) => page?.posts ?? [])]);
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
      {data.post && (posts.length > 0 || rest.loading || rest.more) && (
        <Card>
          <CardHeader>
            <CardTitle>Posts today</CardTitle>
            <CardDescription>
              Planned for today and not yet published. Post them, then paste the link back.{" "}
              <Link to={`/o/${org._id}/${data.post.objectKey}?view=calendar`} className="text-primary hover:underline">
                Social calendar
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-0.5">
            {posts.map((record) => {
              const status = data.post!.statusField, value = status && record.values[status._id];
              return (
                <Link key={record._id} to={`/o/${org._id}/${data.post!.objectKey}/${record._id}`} className="flex h-8 items-center gap-3 rounded-md px-2 text-sm hover:bg-muted">
                  <span className="min-w-0 flex-1 truncate">{record.title || "Untitled"}</span>
                  {status && value !== undefined && <span className="text-xs text-muted-foreground">{optionLabel(status, value)}</span>}
                  <span className="text-xs text-muted-foreground tabular-nums">{timeOfDay(data.post!.plannedField, planned(record)) ?? "Today"}</span>
                </Link>
              );
            })}
            {rest.loading && <p className="px-2 text-xs text-muted-foreground">Looking for more…</p>}
            {rest.more && (
              <button type="button" className="px-2 py-1 text-left text-xs text-primary hover:underline" onClick={rest.loadMore}>
                Look for more posts today
              </button>
            )}
          </CardContent>
        </Card>
      )}
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
