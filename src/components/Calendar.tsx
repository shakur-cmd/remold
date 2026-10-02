import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { DndContext, PointerSensor, TouchSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "cn";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { attempt } from "@/lib/errors";
import { byDay, dayKey, fetchRange, monthDays, moveToDay, parseDay, shiftAnchor, swatch, weekDays } from "@/lib/calendar";
import { type Field, isSlotted, localToday, optionLabel, timeOfDay } from "@/lib/fields";

type Mode = "month" | "week";
const NONE = "none";
const WEEKDAYS = weekDays(Date.UTC(2026, 9, 4)).map((day) => new Date(day).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short" }));
const wide = () => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches;

// Month or week of an object's records, placed by one of its indexed date fields
// in the viewer's zone and colored by one of its select fields. Choices live in
// the URL so a view can be linked. Dragging to another day keeps the time.
export function Calendar({ orgId, object, fields }: { orgId: Id<"orgs">; object: Doc<"objects">; fields: Field[] }) {
  const [params, setParams] = useSearchParams();
  const update = useMutation(api.records.update);
  const dates = fields.filter((f) => f.type === "date" && isSlotted(f) && !f.retired);
  const selects = fields.filter((f) => f.type === "select" && !f.retired);
  const dateField = dates.find((f) => f._id === params.get("date")) ?? dates[0];
  const colorParam = params.get("color");
  const colorField = colorParam === NONE ? undefined : (selects.find((f) => f._id === colorParam) ?? selects.find((f) => f.key === "status") ?? selects[0]);
  const mode: Mode = params.get("cal") === "week" || (params.get("cal") !== "month" && !wide()) ? "week" : "month";
  const today = localToday();
  const anchor = parseDay(params.get("at")) ?? today;
  const days = mode === "month" ? monthDays(anchor) : weekDays(anchor);
  const result = useQuery(api.records.inRange, dateField ? { orgId, objectId: object._id, fieldId: dateField._id, ...fetchRange(days) } : "skip");
  const set = (changes: Record<string, string>) => setParams((current) => { const next = new URLSearchParams(current); for (const [k, v] of Object.entries(changes)) next.set(k, v); return next; }, { replace: true });
  if (!dateField) return <p className="py-12 text-center text-sm text-muted-foreground">Add an indexed date field to see {object.labelPlural.toLowerCase()} on a calendar.</p>;

  const first = new Date(days[0]!), last = new Date(days.at(-1)!), shown = new Date(anchor);
  const title = mode === "month"
    ? shown.toLocaleDateString(undefined, { timeZone: "UTC", month: "long", year: "numeric" })
    : `${first.toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" })} – ${last.toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })}`;

  function onMove(recordId: Id<"records">, day: number) {
    const record = result?.records.find((r) => r._id === recordId), at = record?.values[dateField!._id];
    if (typeof at !== "number") return;
    const value = moveToDay(dateField!, at, day);
    if (value !== at) void attempt(() => update({ orgId, recordId, values: { [dateField!._id]: value } }));
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" aria-label="Previous" onClick={() => set({ at: dayKey(shiftAnchor(anchor, mode, -1)) })}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="sm" onClick={() => set({ at: dayKey(today) })}>
            Today
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="Next" onClick={() => set({ at: dayKey(shiftAnchor(anchor, mode, 1)) })}>
            <ChevronRight />
          </Button>
        </div>
        <h2 className="text-sm font-semibold tabular-nums">{title}</h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border bg-card p-0.5">
            {(["month", "week"] as const).map((m) => (
              <Button key={m} variant={mode === m ? "secondary" : "ghost"} size="sm" className="h-7 capitalize" onClick={() => set({ cal: m })}>
                {m}
              </Button>
            ))}
          </div>
          {dates.length > 1 && (
            <Select value={dateField._id} onValueChange={(id) => set({ date: id })}>
              <SelectTrigger size="sm" className="bg-card" aria-label="Date field">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dates.map((f) => <SelectItem key={f._id} value={f._id}>{f.label}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {selects.length > 0 && (
            <Select value={colorField?._id ?? NONE} onValueChange={(id) => set({ color: id })}>
              <SelectTrigger size="sm" className="bg-card" aria-label="Color by">
                <span className="text-muted-foreground">Color:</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None</SelectItem>
                {selects.map((f) => <SelectItem key={f._id} value={f._id}>{f.label}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
      {colorField && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {colorField.options?.map((option) => (
            <span key={option.id} className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", swatch(colorField, option.id))} aria-hidden />
              {option.label}
            </span>
          ))}
        </div>
      )}
      <CalendarGrid orgId={orgId} objectKey={object.key} mode={mode} days={days} month={shown.getUTCMonth()} records={result?.records ?? []} dateField={dateField} colorField={colorField} today={today} onMove={onMove} />
      {result?.truncated && <p className="text-xs text-muted-foreground">Showing the first 500 in this range.</p>}
    </div>
  );
}

// Releasing a drag over a chip also clicks its link. dnd-kit stops that click
// reaching React but not the browser following the href, so it is cancelled here,
// and the listener goes once the click has passed (dnd-kit waits 50 ms too).
const swallow = (event: Event) => event.preventDefault();
const release = () => setTimeout(() => document.removeEventListener("click", swallow, true), 50);

type GridProps = { orgId: Id<"orgs">; objectKey: string; mode: Mode; days: number[]; month: number; records: Doc<"records">[]; dateField: Field; colorField?: Field; today: number; onMove: (recordId: Id<"records">, day: number) => void };

// A month is a 7-column grid; on a phone its cells show dots and a tapped day is
// listed below. A week is seven columns, stacked into a list on a phone.
export function CalendarGrid({ orgId, objectKey, mode, days, month, records, dateField, colorField, today, onMove }: GridProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }));
  const placed = byDay(records, dateField);
  const [picked, setPicked] = useState<number | null>(null);
  const selected = picked !== null && days.includes(picked) ? picked : days.includes(today) ? today : null;
  const chip = { orgId, objectKey, dateField, colorField };

  function onDragEnd(event: DragEndEvent) {
    release();
    if (event.over) onMove(event.active.id as Id<"records">, Number(event.over.id));
  }

  return (
    <DndContext sensors={sensors} onDragStart={() => document.addEventListener("click", swallow, true)} onDragEnd={onDragEnd} onDragCancel={release}>
      {mode === "month" ? (
        <>
          <div className="overflow-hidden rounded-lg border bg-card">
            <div className="grid grid-cols-7 border-b text-center text-xs text-muted-foreground">
              {WEEKDAYS.map((name) => <div key={name} className="py-1.5">{name}</div>)}
            </div>
            <div className="grid grid-cols-7">
              {days.map((day) => (
                <Day key={day} day={day} className={cn("min-h-14 border-r border-b p-1 md:min-h-28 [&:nth-child(7n)]:border-r-0", new Date(day).getUTCMonth() !== month && "bg-muted/40 text-muted-foreground")}>
                  <button type="button" className={cn("flex w-full flex-col items-center gap-1 md:hidden", selected === day && "rounded-md bg-accent")} onClick={() => setPicked(day)}>
                    <DayNumber day={day} today={today} />
                    <span className="flex flex-wrap justify-center gap-0.5">
                      {placed.get(day)?.map((r) => <span key={r._id} className={cn("size-1.5 rounded-full", swatch(colorField, colorField && r.values[colorField._id]))} />)}
                    </span>
                  </button>
                  <div className="hidden gap-0.5 md:grid">
                    <DayNumber day={day} today={today} />
                    {placed.get(day)?.map((r) => <Chip key={r._id} record={r} {...chip} />)}
                  </div>
                </Day>
              ))}
            </div>
          </div>
          {selected !== null && (
            <div data-list className="grid gap-1 md:hidden">
              <h3 className="px-1 text-xs text-muted-foreground">{new Date(selected).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" })}</h3>
              {placed.get(selected)?.map((r) => <Chip key={r._id} record={r} {...chip} still />) ?? <p className="px-1 text-sm text-muted-foreground">Nothing planned.</p>}
            </div>
          )}
        </>
      ) : (
        <div className="grid gap-2 md:grid-cols-7 md:gap-0 md:overflow-hidden md:rounded-lg md:border md:bg-card">
          {days.map((day) => (
            <Day key={day} day={day} className="grid content-start gap-1 rounded-lg border bg-card p-2 md:min-h-96 md:rounded-none md:border-0 md:border-r md:last:border-r-0">
              <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground md:flex-col md:items-center md:gap-0">
                <span>{new Date(day).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short" })}</span>
                <DayNumber day={day} today={today} />
              </div>
              {placed.get(day)?.map((r) => <Chip key={r._id} record={r} {...chip} detailed />)}
            </Day>
          ))}
        </div>
      )}
    </DndContext>
  );
}

function Day({ day, className, children }: { day: number; className: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: String(day) });
  return <div ref={setNodeRef} data-day={dayKey(day)} className={cn(className, isOver && "bg-primary/5 ring-2 ring-primary/40 ring-inset")}>{children}</div>;
}

const DayNumber = ({ day, today }: { day: number; today: number }) => (
  <span className={cn("inline-flex size-6 items-center justify-center rounded-full text-xs tabular-nums", day === today && "bg-primary font-semibold text-primary-foreground")}>{new Date(day).getUTCDate()}</span>
);

// `still` chips are a second copy of a record (the phone's day list) and are not draggable.
function Chip({ orgId, objectKey, record, dateField, colorField, detailed = false, still = false }: { orgId: Id<"orgs">; objectKey: string; record: Doc<"records">; dateField: Field; colorField?: Field; detailed?: boolean; still?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: record._id, disabled: still });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined;
  const time = timeOfDay(dateField, record.values[dateField._id] as number);
  const color = colorField && record.values[colorField._id];
  const label = colorField && color !== undefined ? optionLabel(colorField, color) : null;
  return (
    <Link
      ref={still ? undefined : setNodeRef}
      style={style}
      {...(still ? {} : { ...listeners, ...attributes })}
      to={`/o/${orgId}/${objectKey}/${record._id}`}
      title={[time, record.title, label].filter(Boolean).join(" · ")}
      className={cn("flex min-w-0 touch-manipulation items-start gap-1.5 rounded-md px-1.5 py-1 text-xs hover:bg-muted", detailed && "border bg-card py-1.5", still && "border bg-card py-2 text-sm", isDragging && "relative z-10 bg-card shadow-md")}
    >
      <span className={cn("mt-1 size-2 shrink-0 rounded-full", swatch(colorField, color))} aria-hidden />
      <span className="grid min-w-0">
        <span className={cn("font-medium", !detailed && !still && "truncate")}>
          {time && !detailed && <span className="mr-1 font-normal text-muted-foreground tabular-nums">{time}</span>}
          {record.title || "Untitled"}
        </span>
        {(detailed || still) && (time || label) && <span className="text-muted-foreground tabular-nums">{[time, label].filter(Boolean).join(" · ")}</span>}
        {!detailed && !still && label && <span className="sr-only">{label}</span>}
      </span>
    </Link>
  );
}
