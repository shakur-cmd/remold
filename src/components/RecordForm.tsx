import { useState, type FormEvent } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RecordMultiPicker, RecordPicker } from "@/components/RecordPicker";
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
  // When creating, warn about existing records with a similar name.
  duplicates?: { objectId: Id<"objects">; titleFieldId?: Id<"fields"> };
};

export function RecordForm({ orgId, fields, initial = {}, hidden = [], submitLabel = "Save", onSubmit, onCancel, duplicates }: Props) {
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
          {duplicates && field._id === duplicates.titleFieldId && <Similar orgId={orgId} objectId={duplicates.objectId} text={String(values[field._id] ?? "")} />}
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
      return <RecordPicker id={id} autoFocus={autoFocus} orgId={orgId} objectId={field.targetObjectId!} value={(value as string) ?? ""} onChange={onChange} />;
    case "links":
      return <RecordMultiPicker id={id} autoFocus={autoFocus} orgId={orgId} objectId={field.targetObjectId!} value={(value as string[]) ?? []} onChange={onChange} />;
  }
}

function Similar({ orgId, objectId, text }: { orgId: Id<"orgs">; objectId: Id<"objects">; text: string }) {
  const hits = useQuery(api.records.search, text.trim().length >= 3 ? { orgId, objectId, text, limit: 3 } : "skip");
  if (!hits?.length) return null;
  return (
    <p className="text-xs text-amber-700 dark:text-amber-400">
      Already have: {hits.map((hit) => hit.title || "Untitled").join(", ")}
    </p>
  );
}
