import type { ReactNode } from "react";
import { Link, useOutletContext } from "react-router";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { SuggestionCard, type SuggestionRow } from "@/components/SuggestionCard";
import { Loading } from "@/components/Loading";
import { formatTime } from "@/lib/fields";
import type { OrgContext } from "@/routes/OrgLayout";

const done = { create: "created", update: "changed", delete: "deleted" } as const;

export function Suggestions() {
  const { org } = useOutletContext<OrgContext>();
  const pending = useQuery(api.suggestions.list, { orgId: org._id, status: "pending" });
  const conflicted = useQuery(api.suggestions.list, { orgId: org._id, status: "conflicted" });
  const applied = useQuery(api.suggestions.list, { orgId: org._id, status: "applied" });
  if (!pending || !conflicted || !applied) return <Loading />;
  return (
    <div className="grid max-w-2xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Suggestions</h1>
        <p className="text-sm text-muted-foreground">Changes your agents proposed. Nothing lands until someone applies it.</p>
      </div>
      <Section title="Waiting for you" count={pending.length}>
        {pending.length === 0 && <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">Nothing waiting. When an agent proposes a change it appears here.</p>}
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
