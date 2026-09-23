import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { Search } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const isRef = (text: string) => /^[a-z]+-[a-z]+-[a-z]+$/.test(text.trim().toLowerCase());

// One box for everything: a name finds records of any object, a three-word
// code jumps straight to its record. Cmd+K or Ctrl+K opens it anywhere.
export function SearchDialog({ orgId }: { orgId: Id<"orgs"> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
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
  function go(result: { _id: string; objectKey: string }) {
    setOpen(false);
    setText("");
    navigate(`/o/${orgId}/${result.objectKey}/${result._id}`);
  }

  return (
    <>
      <Button variant="outline" size="sm" className="gap-2 text-muted-foreground" onClick={() => setOpen(true)} aria-label="Search">
        <Search />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded border px-1 font-mono text-[10px] sm:inline">⌘K</kbd>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[15%] translate-y-0 gap-0 p-0">
          <DialogTitle className="sr-only">Search</DialogTitle>
          <form
            className="border-b p-3 pr-12"
            onSubmit={(e) => {
              e.preventDefault();
              if (results[0]) go(results[0]);
            }}
          >
            <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Search names or paste a code" className="border-none shadow-none focus-visible:ring-0" />
          </form>
          <ul className="max-h-[60dvh] overflow-y-auto py-1">
            {results.map((result) => (
              <li key={result._id}>
                <button type="button" className="flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm hover:bg-accent" onClick={() => go(result)}>
                  <span className="min-w-0 flex-1 truncate">{result.title || "Untitled"}</span>
                  <span className="text-xs text-muted-foreground">{result.objectLabel}</span>
                </button>
              </li>
            ))}
            {text.trim() && hits !== undefined && results.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">No matches</li>}
            {!text.trim() && <li className="px-4 py-3 text-sm text-muted-foreground">Type a name, like a company or person</li>}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
