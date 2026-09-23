import { Link, useOutletContext } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Loading } from "@/components/Loading";
import { errorMessage } from "@/lib/errors";
import type { OrgContext } from "@/routes/OrgLayout";
import { InboxCard } from "@/components/InboxCard";

const DAY = 86400000;
// Date fields hold UTC midnight of the chosen day, so "today" is encoded the same way.
const localToday = () => { const now = new Date(); return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()); };

export function Today() {
  const { org } = useOutletContext<OrgContext>();
  const today = localToday();
  const data = useQuery(api.today.get, { orgId: org._id, today });
  const update = useMutation(api.records.update);
  if (!data) return <Loading />;
  const { task } = data;

  const groups = [
    { label: "Overdue", rows: data.tasks.filter((r) => due(r) < today) },
    { label: "Today", rows: data.tasks.filter((r) => due(r) === today) },
    { label: "This week", rows: data.tasks.filter((r) => due(r) > today) },
  ];
  function due(record: Doc<"records">) {
    return task ? (record.values[task.dueFieldId] as number) : 0;
  }
  async function complete(recordId: Id<"records">) {
    if (!task?.doneFieldId) return;
    try {
      await update({ orgId: org._id, recordId, values: { [task.doneFieldId]: true } });
      toast.success("Done");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="grid max-w-2xl gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Today</h1>
      <InboxCard orgId={org._id} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Follow-ups</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {data.tasks.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing due this week. Add a task with a due date from any record and it shows up here.</p>
          )}
          {groups.map((group) =>
            group.rows.length === 0 ? null : (
              <section key={group.label} className="grid gap-1">
                <h2 className={group.label === "Overdue" ? "text-xs font-medium text-destructive" : "text-xs font-medium text-muted-foreground"}>{group.label}</h2>
                {group.rows.map((record) => (
                  <div key={record._id} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent">
                    {task?.doneFieldId && <Checkbox aria-label={`Mark ${record.title} done`} onCheckedChange={() => complete(record._id)} />}
                    <Link to={`/o/${org._id}/${task!.objectKey}/${record._id}`} className="min-w-0 flex-1 truncate text-sm">
                      {record.title || "Untitled"}
                    </Link>
                    <span className="text-xs text-muted-foreground">{new Date(due(record)).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" })}</span>
                  </div>
                ))}
              </section>
            ),
          )}
        </CardContent>
      </Card>
      {data.quiet.length > 0 && data.dealKey && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Gone quiet</CardTitle>
            <p className="text-sm text-muted-foreground">Open opportunities nobody has touched in two weeks.</p>
          </CardHeader>
          <CardContent className="grid gap-1">
            {data.quiet.map((record) => (
              <Link key={record._id} to={`/o/${org._id}/${data.dealKey}/${record._id}`} className="flex items-baseline gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                <span className="min-w-0 flex-1 truncate">{record.title || "Untitled"}</span>
                <span className="text-xs text-muted-foreground">{Math.floor((Date.now() - record.updatedAt) / DAY)} days</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
