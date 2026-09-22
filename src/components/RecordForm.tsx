import { useState, type FormEvent } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { type Field, type Values, dateToInput, inputToDate, isLongText } from "@/lib/fields";

type Props = {
  orgId: Id<"orgs">;
  fields: Field[];
  initial?: Values;
  hidden?: string[];
  submitLabel?: string;
  onSubmit: (values: Values) => Promise<void>;
  onCancel?: () => void;
};

export function RecordForm({ orgId, fields, initial = {}, hidden = [], submitLabel = "Save", onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<Values>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Polymorphic lookups (no target object) are set by the page, never typed by hand.
  const visible = fields.filter((f) => !f.retired && !hidden.includes(f._id) && !(f.type === "lookup" && !f.targetObjectId));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      {visible.map((field) => (
        <div key={field._id} className="grid gap-1.5">
          <Label htmlFor={field._id}>
            {field.label}
            {field.required && <span className="text-destructive"> *</span>}
          </Label>
          <FieldInput orgId={orgId} field={field} value={values[field._id]} onChange={(v) => setValues((prev) => ({ ...prev, [field._id]: v }))} />
        </div>
      ))}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function FieldInput({ orgId, field, value, onChange, autoFocus }: { orgId: Id<"orgs">; field: Field; value: unknown; onChange: (v: unknown) => void; autoFocus?: boolean }) {
  const id = field._id;
  switch (field.type) {
    case "text":
      return isLongText(field) ? (
        <Textarea id={id} autoFocus={autoFocus} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input id={id} autoFocus={autoFocus} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
      );
    case "number":
      return (
        <Input
          id={id}
          autoFocus={autoFocus}
          type="number"
          inputMode="decimal"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "date":
      return <Input id={id} autoFocus={autoFocus} type="date" value={dateToInput(value)} onChange={(e) => onChange(inputToDate(e.target.value))} />;
    case "boolean":
      return (
        <div className="flex h-9 items-center">
          <Checkbox id={id} checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked === true)} />
        </div>
      );
    case "select":
      return (
        <Select value={(value as string) ?? ""} onValueChange={(v) => onChange(v || null)}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "lookup":
      return <RecordSelect id={id} orgId={orgId} objectId={field.targetObjectId!} value={(value as string) ?? ""} onChange={(v) => onChange(v || null)} />;
    case "links":
      return <RecordMultiSelect orgId={orgId} objectId={field.targetObjectId!} value={(value as string[]) ?? []} onChange={onChange} />;
  }
}

function useRecordOptions(orgId: Id<"orgs">, objectId: Id<"objects">) {
  return usePaginatedQuery(api.records.list, { orgId, objectId }, { initialNumItems: 100 }).results;
}

function RecordSelect({ id, orgId, objectId, value, onChange }: { id: string; orgId: Id<"orgs">; objectId: Id<"objects">; value: string; onChange: (v: string) => void }) {
  const records = useRecordOptions(orgId, objectId);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="Choose" />
      </SelectTrigger>
      <SelectContent>
        {records.map((record) => (
          <SelectItem key={record._id} value={record._id}>
            {record.title || "Untitled"}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RecordMultiSelect({ orgId, objectId, value, onChange }: { orgId: Id<"orgs">; objectId: Id<"objects">; value: string[]; onChange: (v: string[]) => void }) {
  const records = useRecordOptions(orgId, objectId);
  const toggle = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter((v) => v !== id));
  return (
    <div className="grid max-h-48 gap-2 overflow-y-auto rounded-md border p-3">
      {records.length === 0 && <span className="text-sm text-muted-foreground">Nothing to link yet</span>}
      {records.map((record) => (
        <label key={record._id} className="flex items-center gap-2 text-sm">
          <Checkbox checked={value.includes(record._id)} onCheckedChange={(checked) => toggle(record._id, checked === true)} />
          {record.title || "Untitled"}
        </label>
      ))}
    </div>
  );
}
