import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { cn } from "cn";
import { Search } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

const isRef = (text: string) => /^[a-z]+-[a-z]+-[a-z]+$/.test(text.trim().toLowerCase());

// One box for everything: a name finds records of any object, a three-word
// code jumps straight to its record. Cmd+K or Ctrl+K opens it anywhere.
export function SearchDialog({ orgId }: { orgId: Id<"orgs"> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const hits = useQuery(api.records.search, open && text.trim() ? { orgId, text, limit: 12 } : "skip");
  const byRef = useQuery(api.records.byRef, open && isRef(text) ? { orgId, ref: text } : "skip");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = [
    ...(byRef ? [{ _id: byRef.record._id, title: byRef.record.title, objectKey: byRef.object.key, objectLabel: byRef.object.label }] : []),
    ...(hits ?? []).filter((hit) => hit._id !== byRef?.record._id),
  ];
  const current = Math.min(active, Math.max(results.length - 1, 0));
  function go(result: { _id: string; objectKey: string }) {
    setOpen(false);
    setText("");
    navigate(`/o/${orgId}/${result.objectKey}/${result._id}`);
  }
  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Enter" && results[current]) {
      e.preventDefault();
      go(results[current]);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((current + (e.key === "ArrowDown" ? 1 : results.length - 1)) % Math.max(results.length, 1));
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" className="w-9 gap-2 bg-card px-0 text-muted-foreground sm:w-56 sm:justify-start sm:px-2.5" onClick={() => setOpen(true)} aria-label="Search">
        <Search />
        <span className="hidden sm:inline">Search</span>
        <kbd className="ml-auto hidden rounded border px-1 font-mono text-[10px] sm:inline">⌘K</kbd>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[15%] translate-y-0 gap-0 p-0" showCloseButton={false}>
          <DialogTitle className="sr-only">Search</DialogTitle>
          <div className="flex items-center gap-2 border-b px-4">
            <Search className="size-4 text-muted-foreground" />
            <input
              autoFocus
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search names or paste a code"
              aria-label="Search"
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul className="max-h-[60dvh] overflow-y-auto p-1.5" role="listbox">
            {results.map((result, index) => (
              <li key={result._id} role="option" aria-selected={index === current}>
                <button type="button" className={cn("flex w-full items-baseline gap-3 rounded-md px-3 py-2 text-left text-sm", index === current ? "bg-accent text-accent-foreground" : "hover:bg-muted")} onMouseEnter={() => setActive(index)} onClick={() => go(result)}>
                  <span className="min-w-0 flex-1 truncate">{result.title || "Untitled"}</span>
                  <span className="text-xs text-muted-foreground">{result.objectLabel}</span>
                </button>
              </li>
            ))}
            {text.trim() && hits !== undefined && results.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No matches</li>}
            {!text.trim() && <li className="px-3 py-2 text-sm text-muted-foreground">Type a name, like a company or person, or paste a three-word code</li>}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
