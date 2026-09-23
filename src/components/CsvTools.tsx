import { useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { Download, MoreHorizontal, Upload } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { parseCsv, toCsv } from "@/lib/csv";
import { errorMessage } from "@/lib/errors";
import type { Field } from "@/lib/fields";

const BATCH = 100;
const SKIP = "skip";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
// Common spreadsheet headers for the standard fields, compared after norm().
const ALIASES: Record<string, string[]> = {
  name: ["fullname", "contactname", "displayname", "companyname", "accountname"],
  email: ["emailaddress", "mail"],
  phone: ["phonenumber", "mobile", "cell", "telephone"],
  domain: ["website", "url", "web"],
  postalCode: ["zip", "zipcode", "postcode"],
  title: ["jobtitle", "position", "role"],
};
const matches = (field: Field, header: string) => {
  const h = norm(header);
  return h === norm(field.label) || h === norm(field.key) || (ALIASES[field.key] ?? []).includes(h);
};

export function CsvTools({ orgId, object, fields }: { orgId: Id<"orgs">; object: Doc<"objects">; fields: Field[] }) {
  const convex = useConvex();
  const [importing, setImporting] = useState(false);

  async function exportCsv() {
    try {
      const rows: string[][] = [];
      let header: string[] = [], cursor: string | null = null;
      for (;;) {
        const page: { header: string[]; rows: string[][]; cursor: string; done: boolean } = await convex.query(api.csv.exportPage, { orgId, objectId: object._id, cursor });
        header = page.header;
        rows.push(...page.rows);
        if (page.done) break;
        cursor = page.cursor;
      }
      const url = URL.createObjectURL(new Blob([toCsv([header, ...rows])], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${object.labelPlural.toLowerCase()}-${new Date().toLocaleDateString("en-CA")}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${rows.length} ${object.labelPlural.toLowerCase()}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="More actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setImporting(true)}>
            <Upload /> Import CSV
          </DropdownMenuItem>
          <DropdownMenuItem onClick={exportCsv}>
            <Download /> Export CSV
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={importing} onOpenChange={setImporting}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import {object.labelPlural}</DialogTitle>
          </DialogHeader>
          {importing && <ImportForm orgId={orgId} object={object} fields={fields} onDone={() => setImporting(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ImportForm({ orgId, object, fields, onDone }: { orgId: Id<"orgs">; object: Doc<"objects">; fields: Field[]; onDone: () => void }) {
  const importRows = useMutation(api.csv.importRows);
  const [header, setHeader] = useState<string[] | null>(null);
  const [rows, setRows] = useState<string[][]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [createMissing, setCreateMissing] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<{ created: number; skipped: number; errors: { row: number; message: string }[] } | null>(null);
  const writable = fields.filter((f) => !(f.type === "lookup" && !f.targetObjectId));

  async function load(file: File) {
    const [head, ...body] = parseCsv(await file.text());
    if (!head) return toast.error("That file has no rows");
    setHeader(head);
    setRows(body);
    // Match columns to fields by label or key, ignoring case and punctuation.
    setColumns(head.map((name) => writable.find((f) => matches(f, name))?._id ?? SKIP));
    setResult(null);
  }

  async function run() {
    const mapped = columns.map((c) => (c === SKIP ? null : (c as Id<"fields">)));
    const total = { created: 0, skipped: 0, errors: [] as { row: number; message: string }[] };
    try {
      for (let start = 0; start < rows.length; start += BATCH) {
        setProgress(start);
        // Row numbers match the spreadsheet: row 1 is the header.
        const batch = await importRows({ orgId, objectId: object._id, columns: mapped, rows: rows.slice(start, start + BATCH), firstRow: start + 2, skipDuplicates, createMissing });
        total.created += batch.created;
        total.skipped += batch.skipped;
        total.errors.push(...batch.errors);
      }
      setResult(total);
      toast.success(`Imported ${total.created} ${object.labelPlural.toLowerCase()}`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setProgress(null);
    }
  }

  if (result)
    return (
      <div className="grid gap-3 text-sm">
        <p>
          Created {result.created}. Skipped {result.skipped} {result.skipped === 1 ? "duplicate" : "duplicates"}. {result.errors.length} {result.errors.length === 1 ? "row" : "rows"} had problems.
        </p>
        {result.errors.length > 0 && (
          <ul className="grid max-h-60 gap-1 overflow-y-auto rounded-md border p-2 text-xs">
            {result.errors.map((error) => (
              <li key={error.row}>
                <span className="font-medium">Row {error.row}:</span> {error.message}
              </li>
            ))}
          </ul>
        )}
        <Button className="justify-self-end" onClick={onDone}>
          Done
        </Button>
      </div>
    );

  return (
    <div className="grid gap-4 text-sm">
      <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
      {header && (
        <>
          <p className="text-muted-foreground">
            {rows.length} rows. Check which field each column goes into.
          </p>
          <div className="grid gap-2">
            {header.map((name, index) => (
              <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{name || `Column ${index + 1}`}</div>
                  <div className="truncate text-xs text-muted-foreground">{rows[0]?.[index] || "·"}</div>
                </div>
                <Select value={columns[index]} onValueChange={(value) => setColumns((prev) => prev.map((c, i) => (i === index ? value : c)))}>
                  <SelectTrigger className="w-full" aria-label={`Field for ${name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SKIP}>Don't import</SelectItem>
                    {writable.map((field) => (
                      <SelectItem key={field._id} value={field._id}>
                        {field.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <Checkbox checked={skipDuplicates} onCheckedChange={(v) => setSkipDuplicates(v === true)} /> Skip rows whose name already exists
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={createMissing} onCheckedChange={(v) => setCreateMissing(v === true)} /> Create linked records that don't exist yet (like a new company)
          </label>
          <Button onClick={run} disabled={progress !== null || rows.length === 0 || columns.every((c) => c === SKIP)}>
            {progress === null ? `Import ${rows.length} rows` : `Importing… ${progress} of ${rows.length}`}
          </Button>
        </>
      )}
    </div>
  );
}
