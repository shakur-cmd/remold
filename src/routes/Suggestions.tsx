import { useOutletContext } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SuggestionCard } from "@/components/SuggestionCard";
import { Loading } from "@/components/Loading";
import type { OrgContext } from "@/routes/OrgLayout";

export function Suggestions() {
  const { org } = useOutletContext<OrgContext>();
  const pending = useQuery(api.suggestions.list, { orgId: org._id, status: "pending" });
  const conflicted = useQuery(api.suggestions.list, { orgId: org._id, status: "conflicted" });
  const applied = useQuery(api.suggestions.list, { orgId: org._id, status: "applied" });
  if (!pending || !conflicted || !applied) return <Loading />;
  const sections = [
    { title: "Waiting for you", rows: pending, empty: "Nothing waiting. When an agent proposes a change it appears here for you to apply or dismiss." },
    { title: "Changed underneath", rows: conflicted, empty: null },
    { title: "Recently applied", rows: applied.slice(0, 20), empty: null },
  ];
  return (
    <div className="grid max-w-2xl gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Suggestions</h1>
      {sections.map(({ title, rows, empty }) =>
        rows.length === 0 && !empty ? null : (
          <Card key={title}>
            <CardHeader>
              <CardTitle className="text-base">{title}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {rows.length === 0 && <p className="text-sm text-muted-foreground">{empty}</p>}
              {rows.map((row) => (
                <SuggestionCard key={row.suggestion._id} orgId={org._id} row={row} />
              ))}
            </CardContent>
          </Card>
        ),
      )}
    </div>
  );
}
