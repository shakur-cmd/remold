import { useState } from "react";
import { Link, Navigate, useNavigate, useOutletContext, useParams, useSearchParams } from "react-router";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { ArrowDown, ArrowUp, ArrowUpDown, CalendarDays, Columns3, ListFilter, Plus, Rows3, X } from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Board, type Range } from "@/components/Board";
import { Calendar } from "@/components/Calendar";
import { CsvTools } from "@/components/CsvTools";
import { FieldValue } from "@/components/FieldValue";
import { Loading } from "@/components/Loading";
import { FieldInput, RecordForm } from "@/components/RecordForm";
import { attempt } from "@/lib/errors";
import { dayRange, isEmpty, isSlotted, type Field } from "@/lib/fields";
import type { OrgContext } from "@/routes/OrgLayout";

type Sort = { fieldId: Id<"fields">; direction: "asc" | "desc" };
// A filter whose value is still undefined is being chosen and is not sent yet; null means "is empty".
type Filter = { fieldId: Id<"fields">; value: unknown };
type DayRange = { fieldId: Id<"fields">; from: string; to: string };
const MAX_FILTERS = 3;

export function ObjectList() {
  const { org, objects } = useOutletContext<OrgContext>();
  const { objectKey } = useParams();
  const object = objects.find((o) => o.key === objectKey);
  if (!object) return <Navigate to={`/o/${org._id}`} replace />;
  return <List key={object._id} orgId={org._id} objectId={object._id} />;
}

function List({ orgId, objectId }: { orgId: Id<"orgs">; objectId: Id<"objects"> }) {
  const detail = useQuery(api.objects.get, { orgId, objectId });
  const create = useMutation(api.records.create);
  const update = useMutation(api.records.update);
  const [sort, setSort] = useState<Sort | undefined>();
  const [filters, setFilters] = useState<Filter[]>([]);
  const [days, setDays] = useState<DayRange | undefined>();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [firstPage, setFirstPage] = useState<Id<"fields">[] | null>(null);
  const board = params.get("view") === "board", calendar = params.get("view") === "calendar";
  const applied = filters.filter((f) => f.value !== undefined);
  const dateField = days && detail?.fields.find((f) => f._id === days.fieldId);
  const range: Range | undefined = days && dateField && (days.from || days.to) ? { fieldId: days.fieldId, ...dayRange(dateField, days.from, days.to) } : undefined;
  const { results, status, loadMore } = usePaginatedQuery(api.records.list, board || calendar ? "skip" : { orgId, objectId, sort, filters: applied, range }, { initialNumItems: 50 });

  if (!detail) return <Loading />;
  const { object, fields } = detail;
  // A campaign is a funnel: creating one opens it with the step input ready.
  const noun = object.key === "campaign" ? "funnel" : object.label.toLowerCase();
  const selectFields = fields.filter((f) => f.type === "select" && isSlotted(f));
  // Up to six columns, skipping fields no loaded row has filled in (all of them while the list is empty).
  // Checkboxes always show: an unticked box is information, and ticking it is the point.
  const candidates = fields.filter((f) => f._id !== object.titleFieldId && !(f.type === "lookup" && !f.targetObjectId));
  // Chosen once from the first page, so the header does not shift on Load more or while editing.
  const used = firstPage ?? candidates.filter((f) => f.type === "boolean" || results.some((r) => !isEmpty(r.values[f._id]))).map((f) => f._id);
  const columns = (used.length ? candidates.filter((f) => used.includes(f._id)) : candidates).slice(0, 6);
  if (!firstPage && status !== "LoadingFirstPage" && !board && !calendar) setFirstPage(used);
  const groupBy = selectFields[0];
  const dated = fields.some((f) => f.type === "date" && !f.retired);

  function toggleSort(fieldId: Id<"fields">) {
    setSort((current) =>
      current?.fieldId !== fieldId ? { fieldId, direction: "desc" } : current.direction === "desc" ? { fieldId, direction: "asc" } : undefined,
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{object.labelPlural}</h1>
        <div className="ml-auto flex items-center gap-2">
          {(groupBy || dated) && (
            <div className="flex rounded-md border bg-card p-0.5">
              <Button variant={board || calendar ? "ghost" : "secondary"} size="icon-sm" aria-label="Table view" onClick={() => setParams({}, { replace: true })}>
                <Rows3 />
              </Button>
              {groupBy && (
                <Button variant={board ? "secondary" : "ghost"} size="icon-sm" aria-label={`Board by ${groupBy.label}`} onClick={() => setParams({ view: "board" }, { replace: true })}>
                  <Columns3 />
                </Button>
              )}
              {dated && (
                <Button variant={calendar ? "secondary" : "ghost"} size="icon-sm" aria-label="Calendar view" onClick={() => setParams({ view: "calendar" }, { replace: true })}>
                  <CalendarDays />
                </Button>
              )}
            </div>
          )}
          <CsvTools orgId={orgId} object={object} fields={fields} filters={applied} range={range} />
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus /> New {noun}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>New {noun}</DialogTitle>
              </DialogHeader>
              <RecordForm
                orgId={orgId}
                fields={fields}
                duplicates={{ objectId, titleFieldId: object.titleFieldId }}
                submitLabel="Create"
                onCancel={() => setOpen(false)}
                onSubmit={async (values) => {
                  const { recordId } = await create({ orgId, objectId, values });
                  setOpen(false);
                  if (object.key === "campaign") navigate(`/o/${orgId}/${object.key}/${recordId}?steps=1`);
                  else toast.success(`${object.label} created`);
                }}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {!calendar && <FilterBar orgId={orgId} fields={fields} titleFieldId={object.titleFieldId} filters={filters} onFilters={setFilters} days={days} onDays={setDays} />}

      {calendar && dated ? (
        <Calendar orgId={orgId} object={object} fields={fields} />
      ) : board && groupBy ? (
        <Board orgId={orgId} object={object} groupBy={groupBy} fields={fields} filters={applied} range={range} />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-9 pl-4 text-xs font-medium text-muted-foreground">{fields.find((f) => f._id === object.titleFieldId)?.label ?? "Title"}</TableHead>
                {columns.map((field) => {
                  const sortable = isSlotted(field);
                  const active = sort?.fieldId === field._id;
                  const Arrow = !active ? ArrowUpDown : sort.direction === "desc" ? ArrowDown : ArrowUp;
                  return (
                    <TableHead key={field._id} className={cn("h-9 text-xs font-medium text-muted-foreground", field.type === "number" && "text-right")}>
                      {sortable ? (
                        <button type="button" className={cn("group/sort inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")} onClick={() => toggleSort(field._id)}>
                          {field.label}
                          <Arrow className={cn("size-3", active ? "text-primary" : "opacity-0 group-hover/sort:opacity-60")} />
                        </button>
                      ) : (
                        <span>{field.label}</span>
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((record) => (
                <TableRow key={record._id} className="h-9">
                  <TableCell className="py-1.5 pl-4 font-medium">
                    <Link to={`/o/${orgId}/${object.key}/${record._id}`} className="block hover:text-primary">
                      {record.title || "Untitled"}
                    </Link>
                  </TableCell>
                  {columns.map((field) => (
                    <TableCell key={field._id} className={cn("max-w-64 truncate py-1.5", field.type === "number" && "text-right")}>
                      {field.type === "boolean" ? (
                        <Checkbox
                          checked={record.values[field._id] === true}
                          aria-label={`${field.label}: ${record.title}`}
                          onCheckedChange={(checked) => attempt(() => update({ orgId, recordId: record._id, values: { [field._id]: checked === true } }))}
                        />
                      ) : (
                        <FieldValue orgId={orgId} field={field} value={record.values[field._id]} />
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {status !== "LoadingFirstPage" && results.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length + 1} className="py-12 text-center text-muted-foreground">
                    {applied.length || range ? (
                      `No ${object.labelPlural.toLowerCase()} match these filters.`
                    ) : (
                      <>
                        No {object.labelPlural.toLowerCase()} yet.{" "}
                        <button type="button" className="text-primary hover:underline" onClick={() => setOpen(true)}>
                          Add the first one
                        </button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              )}
              {status === "CanLoadMore" && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length + 1} className="p-0">
                    <button type="button" className="w-full py-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => loadMore(50)}>
                      Load more
                    </button>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// Up to three field filters, combined with AND, plus one date range. Only indexed
// fields are offered: the server filters through the same index path as the REST API.
function FilterBar({ orgId, fields, titleFieldId, filters, onFilters, days, onDays }: { orgId: Id<"orgs">; fields: Field[]; titleFieldId?: Id<"fields">; filters: Filter[]; onFilters: (next: Filter[]) => void; days?: DayRange; onDays: (next?: DayRange) => void }) {
  const usable = fields.filter((f) => isSlotted(f) && !f.retired && f._id !== titleFieldId);
  const choices = usable.filter((f) => f.type !== "date" && (f.type !== "lookup" || f.targetObjectId) && !filters.some((x) => x.fieldId === f._id));
  const dates = usable.filter((f) => f.type === "date");
  const byId = new Map(fields.map((f) => [f._id, f]));
  const set = (index: number, value: unknown) => onFilters(filters.map((f, i) => (i === index ? { ...f, value } : f)));
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {filters.map((filter, index) => {
        const field = byId.get(filter.fieldId);
        return field ? (
          <div key={filter.fieldId} className="flex items-center gap-1 rounded-md border bg-card py-0.5 pr-0.5 pl-2">
            <span className="text-xs text-muted-foreground">{field.label}</span>
            <FilterValue orgId={orgId} field={field} value={filter.value} onChange={(value) => set(index, value)} />
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${field.label} filter`} onClick={() => onFilters(filters.filter((_, i) => i !== index))}>
              <X />
            </Button>
          </div>
        ) : null;
      })}
      {filters.length < MAX_FILTERS && choices.length > 0 && (
        <Select value="" onValueChange={(id) => onFilters([...filters, { fieldId: id as Id<"fields">, value: undefined }])}>
          <SelectTrigger size="sm" className="bg-card" aria-label="Add filter">
            <ListFilter className="size-3.5" />
            <SelectValue placeholder="Filter" />
          </SelectTrigger>
          <SelectContent>
            {choices.map((field) => (
              <SelectItem key={field._id} value={field._id}>
                {field.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {dates.length > 0 && (
        <div className="flex items-center gap-1 rounded-md border bg-card py-0.5 pr-0.5 pl-1">
          <Select value={days?.fieldId ?? ""} onValueChange={(id) => onDays({ fieldId: id as Id<"fields">, from: days?.from ?? "", to: days?.to ?? "" })}>
            <SelectTrigger size="sm" className="border-0 shadow-none" aria-label="Date range field">
              <SelectValue placeholder="Date range" />
            </SelectTrigger>
            <SelectContent>
              {dates.map((field) => (
                <SelectItem key={field._id} value={field._id}>
                  {field.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {days && (
            <>
              <Input type="date" className="h-7 w-36" aria-label="From" value={days.from} max={days.to || undefined} onChange={(e) => onDays({ ...days, from: e.target.value })} />
              <span className="text-xs text-muted-foreground">to</span>
              <Input type="date" className="h-7 w-36" aria-label="To" value={days.to} min={days.from || undefined} onChange={(e) => onDays({ ...days, to: e.target.value })} />
              <Button variant="ghost" size="icon-sm" aria-label="Remove date range" onClick={() => onDays(undefined)}>
                <X />
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Select and yes/no fields pick from a list that includes "empty"; the rest reuse the record form's input.
function FilterValue({ orgId, field, value, onChange }: { orgId: Id<"orgs">; field: Doc<"fields">; value: unknown; onChange: (value: unknown) => void }) {
  if (field.type === "select" || field.type === "boolean") {
    const options = field.type === "boolean" ? [{ id: "true", label: "Yes" }, { id: "false", label: "No" }] : (field.options ?? []);
    const toValue = (id: string) => (id === "__empty" ? null : field.type === "boolean" ? id === "true" : id);
    return (
      <Select value={value === undefined ? "" : value === null ? "__empty" : String(value)} onValueChange={(id) => onChange(toValue(id))}>
        <SelectTrigger size="sm" className="h-7 border-0 shadow-none" aria-label={`${field.label} value`}>
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
          <SelectItem value="__empty">Empty</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  return (
    <div className="w-56">
      <FieldInput orgId={orgId} field={field} value={value ?? null} onChange={(next) => onChange(next === "" ? undefined : (next ?? undefined))} />
    </div>
  );
}
