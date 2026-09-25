import { useState } from "react";
import { Link, Navigate, useOutletContext, useParams, useSearchParams } from "react-router";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, Plus, Rows3 } from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Board } from "@/components/Board";
import { CsvTools } from "@/components/CsvTools";
import { FieldValue } from "@/components/FieldValue";
import { Loading } from "@/components/Loading";
import { RecordForm } from "@/components/RecordForm";
import { attempt } from "@/lib/errors";
import { isEmpty, isSlotted } from "@/lib/fields";
import type { OrgContext } from "@/routes/OrgLayout";

type Sort = { fieldId: Id<"fields">; direction: "asc" | "desc" };
type Filter = { fieldId: Id<"fields">; value: string };

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
  const [filter, setFilter] = useState<Filter | undefined>();
  const [open, setOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const [firstPage, setFirstPage] = useState<Id<"fields">[] | null>(null);
  const board = params.get("view") === "board";
  const { results, status, loadMore } = usePaginatedQuery(api.records.list, board ? "skip" : { orgId, objectId, sort, filter }, { initialNumItems: 50 });

  if (!detail) return <Loading />;
  const { object, fields } = detail;
  const selectFields = fields.filter((f) => f.type === "select" && isSlotted(f));
  // Up to six columns, skipping fields no loaded row has filled in (all of them while the list is empty).
  // Checkboxes always show: an unticked box is information, and ticking it is the point.
  const candidates = fields.filter((f) => f._id !== object.titleFieldId && !(f.type === "lookup" && !f.targetObjectId));
  // Chosen once from the first page, so the header does not shift on Load more or while editing.
  const used = firstPage ?? candidates.filter((f) => f.type === "boolean" || results.some((r) => !isEmpty(r.values[f._id]))).map((f) => f._id);
  const columns = (used.length ? candidates.filter((f) => used.includes(f._id)) : candidates).slice(0, 6);
  if (!firstPage && status !== "LoadingFirstPage" && !board) setFirstPage(used);
  const groupBy = selectFields[0];

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
          {groupBy && (
            <div className="flex rounded-md border bg-card p-0.5">
              <Button variant={board ? "ghost" : "secondary"} size="icon-sm" aria-label="Table view" onClick={() => setParams({}, { replace: true })}>
                <Rows3 />
              </Button>
              <Button variant={board ? "secondary" : "ghost"} size="icon-sm" aria-label={`Board by ${groupBy.label}`} onClick={() => setParams({ view: "board" }, { replace: true })}>
                <Columns3 />
              </Button>
            </div>
          )}
          {!board && selectFields.map((field) => (
            <Select
              key={field._id}
              value={filter?.fieldId === field._id ? filter.value : "all"}
              onValueChange={(value) => {
                // The server sorts and filters through one index, so a filter drops a sort on another column.
                if (value !== "all" && sort && sort.fieldId !== field._id) setSort(undefined);
                setFilter(value === "all" ? undefined : { fieldId: field._id, value });
              }}
            >
              <SelectTrigger size="sm" className="bg-card" aria-label={`Filter by ${field.label}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any {field.label.toLowerCase()}</SelectItem>
                {field.options?.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
          <CsvTools orgId={orgId} object={object} fields={fields} />
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus /> New {object.label.toLowerCase()}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>New {object.label.toLowerCase()}</DialogTitle>
              </DialogHeader>
              <RecordForm
                orgId={orgId}
                fields={fields}
                duplicates={{ objectId, titleFieldId: object.titleFieldId }}
                submitLabel="Create"
                onCancel={() => setOpen(false)}
                onSubmit={async (values) => {
                  await create({ orgId, objectId, values });
                  setOpen(false);
                  toast.success(`${object.label} created`);
                }}
              />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {board && groupBy ? (
        <Board orgId={orgId} object={object} groupBy={groupBy} fields={fields} />
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-9 pl-4 text-xs font-medium text-muted-foreground">{fields.find((f) => f._id === object.titleFieldId)?.label ?? "Title"}</TableHead>
                {columns.map((field) => {
                  const sortable = isSlotted(field) && (!filter || filter.fieldId === field._id);
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
                        <span title={isSlotted(field) ? "Clear the filter to sort by this column" : undefined}>{field.label}</span>
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
                    No {object.labelPlural.toLowerCase()} yet.{" "}
                    <button type="button" className="text-primary hover:underline" onClick={() => setOpen(true)}>
                      Add the first one
                    </button>
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
