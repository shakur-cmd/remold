import { Link } from "react-router";
import { useMutation, usePaginatedQuery } from "convex/react";
import { DndContext, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { FieldValue } from "@/components/FieldValue";
import { errorMessage } from "@/lib/errors";
import type { Field } from "@/lib/fields";
import { cn } from "@/lib/utils";

type Props = { orgId: Id<"orgs">; object: Doc<"objects">; groupBy: Field; fields: Field[] };
const EMPTY = "__empty";

// One column per option of a select field; drag a card to change its value.
// Each column is its own indexed, paginated query, so a big pipeline stays fast.
export function Board({ orgId, object, groupBy, fields }: Props) {
  const update = useMutation(api.records.update);
  // A short press-and-hold on touch, so the board still scrolls sideways.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }));
  const columns = [...(groupBy.options ?? []).map((option) => ({ id: option.id, label: option.label })), { id: EMPTY, label: `No ${groupBy.label.toLowerCase()}` }];
  const preview = fields.filter((f) => f._id !== object.titleFieldId && f._id !== groupBy._id && (f.type === "number" || f.type === "lookup" || f.type === "date")).slice(0, 2);

  async function onDragEnd(event: DragEndEvent) {
    const to = event.over?.id as string | undefined;
    const from = event.active.data.current?.column as string | undefined;
    if (!to || to === from) return;
    try {
      await update({ orgId, recordId: event.active.id as Id<"records">, values: { [groupBy._id]: to === EMPTY ? null : to } });
    } catch (error) {
      toast.error(errorMessage(error));
    }
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

function Column({ orgId, object, groupBy, column, preview }: { orgId: Id<"orgs">; object: Doc<"objects">; groupBy: Field; column: { id: string; label: string }; preview: Field[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const filter = { fieldId: groupBy._id, value: column.id === EMPTY ? null : column.id };
  const { results, status, loadMore } = usePaginatedQuery(api.records.list, { orgId, objectId: object._id, filter }, { initialNumItems: 25 });
  return (
    <section ref={setNodeRef} className={cn("flex w-72 shrink-0 snap-start flex-col gap-2 rounded-lg bg-muted/50 p-2", isOver && "ring-2 ring-primary/40")}>
      <h2 className="flex items-baseline justify-between px-1 text-sm font-medium">
        {column.label}
        <span className="text-xs font-normal text-muted-foreground">
          {results.length}
          {status === "CanLoadMore" ? "+" : ""}
        </span>
      </h2>
      {results.map((record) => (
        <Card key={record._id} orgId={orgId} object={object} record={record} column={column.id} preview={preview} />
      ))}
      {status === "CanLoadMore" && (
        <Button variant="ghost" size="sm" onClick={() => loadMore(25)}>
          More
        </Button>
      )}
      {status !== "LoadingFirstPage" && results.length === 0 && <p className="px-1 py-4 text-center text-xs text-muted-foreground">Drop here</p>}
    </section>
  );
}

function Card({ orgId, object, record, column, preview }: { orgId: Id<"orgs">; object: Doc<"objects">; record: Doc<"records">; column: string; preview: Field[] }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: record._id, data: { column } });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes} className={cn("touch-manipulation rounded-md border bg-background p-3 text-sm shadow-xs", isDragging && "relative z-10 opacity-80 shadow-md")}>
      <Link to={`/o/${orgId}/${object.key}/${record._id}`} className="font-medium hover:underline">
        {record.title || "Untitled"}
      </Link>
      {preview.map((field) =>
        record.values[field._id] === undefined ? null : (
          <div key={field._id} className="mt-1 truncate text-xs text-muted-foreground">
            <FieldValue orgId={orgId} field={field} value={record.values[field._id]} plain />
          </div>
        ),
      )}
    </div>
  );
}
