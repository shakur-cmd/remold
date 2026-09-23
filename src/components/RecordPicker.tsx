import { useState } from "react";
import { useQuery } from "convex/react";
import { X } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Input } from "@/components/ui/input";
import { RecordLink } from "@/components/FieldValue";

type Props = { id?: string; orgId: Id<"orgs">; objectId: Id<"objects">; autoFocus?: boolean };

// Type to search by name. With an empty box it lists the most recently
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
          <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => onPick(hit._id)}>
            {hit.title || "Untitled"}
          </button>
        </li>
      ))}
    </ul>
  );
}

function SearchBox({ id, autoFocus, text, setText, placeholder }: { id?: string; autoFocus?: boolean; text: string; setText: (text: string) => void; placeholder: string }) {
  return (
    <Input
      id={id}
      autoFocus={autoFocus}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      // Enter would submit the surrounding form before a result is picked.
      onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
    />
  );
}

export function RecordPicker({ id, orgId, objectId, autoFocus, value, onChange }: Props & { value: string; onChange: (id: string | null) => void }) {
  const [text, setText] = useState("");
  const [searching, setSearching] = useState(!value || !!autoFocus);
  if (value && !searching) {
    return (
      <div className="flex min-h-9 items-center gap-2 rounded-md border px-3">
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
    <div className="rounded-md border">
      <SearchBox id={id} autoFocus={autoFocus} text={text} setText={setText} placeholder="Search by name" />
      <Results orgId={orgId} objectId={objectId} text={text} exclude={value ? [value] : []} onPick={(picked) => { onChange(picked); setText(""); setSearching(false); }} />
    </div>
  );
}

export function RecordMultiPicker({ id, orgId, objectId, autoFocus, value, onChange }: Props & { value: string[]; onChange: (ids: string[]) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="rounded-md border">
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
      <SearchBox id={id} autoFocus={autoFocus} text={text} setText={setText} placeholder="Search to add" />
      <Results orgId={orgId} objectId={objectId} text={text} exclude={value} onPick={(picked) => { onChange([...value, picked]); setText(""); }} />
    </div>
  );
}
