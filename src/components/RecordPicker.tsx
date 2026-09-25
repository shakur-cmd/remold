import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { X } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Input } from "@/components/ui/input";
import { RecordLink } from "@/components/FieldValue";

type Props = { id?: string; orgId: Id<"orgs">; objectId: Id<"objects">; autoFocus?: boolean };

// Type to search by name. Focusing an empty box lists the most recently
// updated, so short lists still work by tapping.
function Results({ orgId, objectId, text, exclude, onPick }: { orgId: Id<"orgs">; objectId: Id<"objects">; text: string; exclude: string[]; onPick: (id: string) => void }) {
  const hits = useQuery(api.records.search, { orgId, objectId, text, limit: 8 });
  if (hits === undefined) return <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>;
  const shown = hits.filter((hit) => !exclude.includes(hit._id));
  if (shown.length === 0) return <p className="px-3 py-2 text-sm text-muted-foreground">{text ? "No matches" : "Nothing to pick yet"}</p>;
  return (
    <ul className="max-h-56 overflow-y-auto py-1">
      {shown.map((hit) => (
        <li key={hit._id}>
          {/* mousedown keeps focus in the box so the list does not close before the pick lands */}
          <button type="button" className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(hit._id)}>
            {hit.title || "Untitled"}
          </button>
        </li>
      ))}
    </ul>
  );
}

// The box plus its result list, which shows only while the box has focus.
function SearchBox({ id, autoFocus, placeholder, results }: { id?: string; autoFocus?: boolean; placeholder: string; results: (text: string, close: () => void) => ReactNode }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(!!autoFocus);
  return (
    <div>
      <Input
        id={id}
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        className="border-none shadow-none focus-visible:ring-0"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => setText(e.target.value)}
        // Enter would submit the surrounding form before a result is picked.
        onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
      />
      {open && <div className="border-t">{results(text, () => setText(""))}</div>}
    </div>
  );
}

export function RecordPicker({ id, orgId, objectId, autoFocus, value, onChange }: Props & { value: string; onChange: (id: string | null) => void }) {
  const [searching, setSearching] = useState(!value || !!autoFocus);
  if (value && !searching) {
    return (
      <div className="flex min-h-8 items-center gap-2 rounded-md border bg-card px-3">
        <span className="min-w-0 flex-1 truncate text-sm">
          <RecordLink orgId={orgId} recordId={value as Id<"records">} />
        </span>
        <button type="button" className="text-sm text-muted-foreground hover:text-foreground" onClick={() => setSearching(true)}>
          Change
        </button>
        <button type="button" aria-label="Clear" className="text-muted-foreground hover:text-foreground" onClick={() => onChange(null)}>
          <X className="size-4" />
        </button>
      </div>
    );
  }
  return (
    <div className="rounded-md border bg-card">
      <SearchBox id={id} autoFocus={autoFocus || !!value} placeholder="Search by name" results={(text, clear) => (
        <Results orgId={orgId} objectId={objectId} text={text} exclude={value ? [value] : []} onPick={(picked) => { onChange(picked); clear(); setSearching(false); }} />
      )} />
    </div>
  );
}

export function RecordMultiPicker({ id, orgId, objectId, autoFocus, value, onChange }: Props & { value: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="rounded-md border bg-card">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b p-2">
          {value.map((recordId) => (
            <span key={recordId} className="flex items-center gap-1 rounded-md bg-secondary px-2 py-1 text-sm">
              <RecordLink orgId={orgId} recordId={recordId as Id<"records">} />
              <button type="button" aria-label="Remove" className="text-muted-foreground hover:text-foreground" onClick={() => onChange(value.filter((v) => v !== recordId))}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <SearchBox id={id} autoFocus={autoFocus} placeholder="Search to add" results={(text, clear) => (
        <Results orgId={orgId} objectId={objectId} text={text} exclude={value} onPick={(picked) => { onChange([...value, picked]); clear(); }} />
      )} />
    </div>
  );
}
