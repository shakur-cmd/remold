import { useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { ArrowLeft, ArrowRight, MoreHorizontal, Pencil, Pin, PinOff, Trash2, UserRound } from "lucide-react";
import { cn } from "cn";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { attempt } from "@/lib/errors";

export type View = FunctionReturnType<typeof api.views.list>[number];
// What the list shows right now, in the shape a view is saved in.
export type ViewSettings = Omit<FunctionArgs<typeof api.views.create>, "orgId" | "objectId" | "name" | "shared" | "pinned">;
const PARTS: Record<string, string> = { column: "column", filter: "filter", range: "date range", sort: "sort", board: "board grouping", calendar: "calendar date" };

// "All" plus the saved views of one object: shared ones first, then the person's own.
export function ViewsBar({ orgId, objectId, views, active, current, dirty, admin, onSelect }: { orgId: Id<"orgs">; objectId: Id<"objects">; views: View[]; active?: View; current: ViewSettings; dirty: boolean; admin: boolean; onSelect: (view?: View, id?: Id<"views">) => void }) {
  const create = useMutation(api.views.create);
  const update = useMutation(api.views.update);
  const reorder = useMutation(api.views.reorder);
  const remove = useMutation(api.views.remove);
  const [dialog, setDialog] = useState<"save" | "rename" | null>(null);
  const tab = (selected: boolean) => cn("-mb-px flex h-9 shrink-0 items-center gap-1 border-b-2 px-3 text-sm", selected ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground");
  const siblings = active ? views.filter((v) => v.shared === active.shared) : [];
  const at = active ? siblings.findIndex((v) => v._id === active._id) : -1;
  function move(by: number) {
    const ids = siblings.map((v) => v._id), [id] = ids.splice(at, 1);
    ids.splice(at + by, 0, id!);
    void attempt(() => reorder({ orgId, viewIds: ids }));
  }
  const cleared = { range: current.range ?? null, sort: current.sort ?? null, groupFieldId: current.groupFieldId ?? null, dateFieldId: current.dateFieldId ?? null };

  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2 border-b">
        <div className="flex min-w-0 flex-1 overflow-x-auto">
          <button type="button" className={tab(!active)} onClick={() => onSelect()}>
            All
          </button>
          {views.map((view) => (
            <button key={view._id} type="button" className={tab(view._id === active?._id)} onClick={() => onSelect(view)} title={view.shared ? undefined : "Only you see this view"}>
              {!view.shared && <UserRound className="size-3 text-muted-foreground" aria-label="Personal" />}
              {view.name}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1 pb-1">
          {active?.editable && (dirty || active.dropped.length > 0) && (
            <Button size="sm" variant="ghost" onClick={() => attempt(() => update({ orgId, viewId: active._id, ...current, ...cleared }), "View saved")}>
              Save changes
            </Button>
          )}
          {(dirty || !active) && (
            <Button size="sm" variant="outline" onClick={() => setDialog("save")}>
              Save view
            </Button>
          )}
          {active?.editable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="View options">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setDialog("rename")}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                {at > 0 && (
                  <DropdownMenuItem onSelect={() => move(-1)}>
                    <ArrowLeft /> Move left
                  </DropdownMenuItem>
                )}
                {at < siblings.length - 1 && (
                  <DropdownMenuItem onSelect={() => move(1)}>
                    <ArrowRight /> Move right
                  </DropdownMenuItem>
                )}
                {active.shared && (
                  <DropdownMenuItem onSelect={() => attempt(() => update({ orgId, viewId: active._id, pinned: !active.pinned }), active.pinned ? "Removed from the menu" : "Pinned in the menu")}>
                    {active.pinned ? <PinOff /> : <Pin />} {active.pinned ? "Unpin from menu" : "Pin in menu"}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem className="text-destructive" onSelect={() => confirm(`Delete the view ${active.name}? Records are not affected.`) && attempt(async () => { await remove({ orgId, viewId: active._id }); onSelect(); }, "View deleted")}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {active && active.dropped.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Retired fields left this view: {active.dropped.map((d) => `${d.field} (${PARTS[d.part]})`).join(", ")}.{active.editable && " Save changes to clear this note."}
        </p>
      )}
      <NameDialog
        key={dialog ?? "closed"}
        open={dialog !== null}
        title={dialog === "rename" ? "Rename view" : "Save view"}
        initial={dialog === "rename" ? active?.name ?? "" : ""}
        sharing={dialog === "save" && admin}
        onClose={() => setDialog(null)}
        onSubmit={async (name, shared, pinned) => {
          if (dialog === "rename" && active) await update({ orgId, viewId: active._id, name });
          else onSelect(undefined, await create({ orgId, objectId, name, ...current, shared, pinned }));
          setDialog(null);
        }}
      />
    </div>
  );
}

// A new view is personal unless an admin shares it; only shared views can be pinned in the menu.
function NameDialog({ open, title, initial, sharing, onClose, onSubmit }: { open: boolean; title: string; initial: string; sharing: boolean; onClose: () => void; onSubmit: (name: string, shared: boolean, pinned: boolean) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [shared, setShared] = useState(false);
  const [pinned, setPinned] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void attempt(() => onSubmit(name, shared, shared && pinned)); }}>
          <div className="grid gap-1.5">
            <Label htmlFor="view-name">Name</Label>
            <Input id="view-name" autoFocus maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Quotes needing follow-up" />
          </div>
          {sharing && (
            <div className="grid gap-2 text-sm">
              <label className="flex items-center gap-2">
                <Checkbox checked={shared} onCheckedChange={(c) => setShared(c === true)} /> Share with the workspace
              </label>
              {shared && (
                <label className="flex items-center gap-2">
                  <Checkbox checked={pinned} onCheckedChange={(c) => setPinned(c === true)} /> Pin in the menu
                </label>
              )}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
