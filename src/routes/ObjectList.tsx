import { useState } from "react";
import { Link, Navigate, useOutletContext, useParams, useSearchParams } from "react-router";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { ArrowDown, ArrowUp, Columns3, Plus, Rows3 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Board } from "@/components/Board";
import { CsvTools } from "@/components/CsvTools";
import { FieldValue } from "@/components/FieldValue";
import { Loading } from "@/components/Loading";
import { RecordForm } from "@/components/RecordForm";
import { isSlotted } from "@/lib/fields";
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
  const [sort, setSort] = useState<Sort | undefined>();
  const [filter, setFilter] = useState<Filter | undefined>();
  const [open, setOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const board = params.get("view") === "board";
  const { results, status, loadMore } = usePaginatedQuery(api.records.list, board ? "skip" : { orgId, objectId, sort, filter }, { initialNumItems: 50 });

  if (!detail) return <Loading />;
  const { object, fields } = detail;
  const selectFields = fields.filter((f) => f.type === "select" && isSlotted(f));
  const columns = fields.filter((f) => f._id !== object.titleFieldId).slice(0, 6);
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
            <div className="flex rounded-md border p-0.5">
              <Button variant={board ? "ghost" : "secondary"} size="icon" className="size-7" aria-label="Table view" onClick={() => setParams({}, { replace: true })}>
                <Rows3 />
              </Button>
              <Button variant={board ? "secondary" : "ghost"} size="icon" className="size-7" aria-label={`Board by ${groupBy.label}`} onClick={() => setParams({ view: "board" }, { replace: true })}>
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
              <SelectTrigger className="h-9" aria-label={`Filter by ${field.label}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All {field.label.toLowerCase()}s</SelectItem>
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
                <Plus /> New
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90dvh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>New {object.label}</DialogTitle>
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
      <>
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{fields.find((f) => f._id === object.titleFieldId)?.label ?? "Title"}</TableHead>
              {columns.map((field) => (
                <TableHead key={field._id}>
                  {isSlotted(field) && (!filter || filter.fieldId === field._id) ? (
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort(field._id)}>
                      {field.label}
                      {sort?.fieldId === field._id && (sort.direction === "desc" ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
                    </button>
                  ) : (
                    <span title={isSlotted(field) ? "Clear the filter to sort by this column" : undefined}>{field.label}</span>
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {results.map((record) => (
              <TableRow key={record._id}>
                <TableCell className="font-medium">
                  <Link to={`/o/${orgId}/${object.key}/${record._id}`} className="block">
                    {record.title || "Untitled"}
                  </Link>
                </TableCell>
                {columns.map((field) => (
                  <TableCell key={field._id} className="max-w-64 truncate">
                    <FieldValue orgId={orgId} field={field} value={record.values[field._id]} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {status !== "LoadingFirstPage" && results.length === 0 && (
              <TableRow>
                <TableCell colSpan={columns.length + 1} className="py-10 text-center text-muted-foreground">
                  No {object.labelPlural.toLowerCase()} yet
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {status === "CanLoadMore" && (
        <Button variant="outline" className="justify-self-center" onClick={() => loadMore(50)}>
          Load more
        </Button>
      )}
      </>
      )}
    </div>
  );
}
