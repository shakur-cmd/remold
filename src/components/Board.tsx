import { Link } from "react-router";
import { useMutation, usePaginatedQuery } from "convex/react";
import { DndContext, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { cn } from "cn";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { RecordLink } from "@/components/FieldValue";
import { attempt } from "@/lib/errors";
import { type Field, formatNumber, isMoney, quietFor } from "@/lib/fields";

type Props = { orgId: Id<"orgs">; object: Doc<"objects">; groupBy: Field; fields: Field[] };
type Preview = { number?: Field; date?: Field; lookup?: Field };
const EMPTY = "__empty";
// Money reads on its own ("$4,500"); any other number needs its name ("3.5 hours").
const show = (field: Field, value: number) => (isMoney(field) ? formatNumber(field, value) : `${formatNumber(field, value)} ${field.label.toLowerCase()}`);
const STALE = 14 * 86400000;

// One column per option of a select field; drag a card to change its value.
// Each column is its own indexed, paginated query, so a big pipeline stays fast.
export function Board({ orgId, object, groupBy, fields }: Props) {
  const update = useMutation(api.records.update);
  // A short press-and-hold on touch, so the board still scrolls sideways.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }));
  const columns = [...(groupBy.options ?? []).map((option) => ({ id: option.id, label: option.label })), { id: EMPTY, label: `No ${groupBy.label.toLowerCase()}` }];
  const others = fields.filter((f) => f._id !== object.titleFieldId && f._id !== groupBy._id && !f.retired);
  const preview: Preview = { number: others.find((f) => f.type === "number"), date: others.find((f) => f.type === "date"), lookup: others.find((f) => f.type === "lookup" && f.targetObjectId) };

  function onDragEnd(event: DragEndEvent) {
    const to = event.over?.id as string | undefined;
    const from = event.active.data.current?.column as string | undefined;
    if (!to || to === from) return;
    void attempt(() => update({ orgId, recordId: event.active.id as Id<"records">, values: { [groupBy._id]: to === EMPTY ? null : to } }));
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="-mx-3 flex snap-x gap-3 overflow-x-auto px-3 pb-4 md:mx-0 md:px-0">
        {columns.map((column) => (
          <Column key={column.id} orgId={orgId} object={object} groupBy={groupBy} column={column} preview={preview} />
        ))}
      </div>
    </DndContext>
  );
}

function Column({ orgId, object, groupBy, column, preview }: { orgId: Id<"orgs">; object: Doc<"objects">; groupBy: Field; column: { id: string; label: string }; preview: Preview }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const filter = { fieldId: groupBy._id, value: column.id === EMPTY ? null : column.id };
  const { results, status, loadMore } = usePaginatedQuery(api.records.list, { orgId, objectId: object._id, filter }, { initialNumItems: 25 });
  const more = status === "CanLoadMore" ? "+" : "";
  // Totals cover the loaded cards; "+" says more are waiting to load.
  const total = preview.number ? results.reduce((sum, r) => sum + ((r.values[preview.number!._id] as number | undefined) ?? 0), 0) : 0;
  if (column.id === EMPTY && status === "Exhausted" && results.length === 0) return null;
  return (
    <section ref={setNodeRef} className={cn("flex w-60 shrink-0 snap-start flex-col self-start gap-2 rounded-lg bg-muted/70 p-2", isOver && "ring-2 ring-primary/40")}>
      <h2 className="flex items-baseline gap-2 px-1 pt-0.5 text-sm font-semibold">
        {column.label}
        <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
          {results.length}
          {more}
          {total > 0 && ` · ${show(preview.number!, total)}${more}`}
        </span>
      </h2>
      {results.map((record) => (
        <Card key={record._id} orgId={orgId} object={object} record={record} column={column.id} preview={preview} />
      ))}
      {status === "CanLoadMore" && (
        <button type="button" className="py-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => loadMore(25)}>
          Load more
        </button>
      )}
      {status !== "LoadingFirstPage" && results.length === 0 && <p className="rounded-md border border-dashed px-1 py-5 text-center text-xs text-muted-foreground">Drag a card here</p>}
    </section>
  );
}

function Card({ orgId, object, record, column, preview }: { orgId: Id<"orgs">; object: Doc<"objects">; record: Doc<"records">; column: string; preview: Preview }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: record._id, data: { column } });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  const number = preview.number && (record.values[preview.number._id] as number | undefined);
  const date = preview.date && (record.values[preview.date._id] as number | undefined);
  const lookup = preview.lookup && (record.values[preview.lookup._id] as Id<"records"> | undefined);
  const quiet = Date.now() - record.updatedAt > STALE;
  const meta = [typeof number === "number" && show(preview.number!, number), date && new Date(date).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" })].filter(Boolean).join(" · ");
  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes} className={cn("grid touch-manipulation gap-1 rounded-md border bg-card p-3 text-[13px]", isDragging && "relative z-10 shadow-md")}>
      <Link to={`/o/${orgId}/${object.key}/${record._id}`} className="font-medium hover:text-primary">
        {record.title || "Untitled"}
      </Link>
      {lookup && (
        <span className="truncate text-xs text-muted-foreground">
          <RecordLink orgId={orgId} recordId={lookup} plain />
        </span>
      )}
      {(meta || quiet) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
          {meta}
          {quiet && (
            <span className="ml-auto flex items-center gap-1" title="No changes in over two weeks">
              <span className="size-1.5 rounded-full bg-warning" aria-hidden />
              {quietFor(record.updatedAt)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
