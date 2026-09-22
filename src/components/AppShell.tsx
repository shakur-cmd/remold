import { useState, type FormEvent, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { UserButton } from "@clerk/clerk-react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { Input } from "@/components/ui/input";
import { Menu, Plus, Settings } from "lucide-react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type Props = {
  org: Doc<"orgs">;
  orgs: { org: Doc<"orgs">; role: string }[];
  objects: Doc<"objects">[];
  children: ReactNode;
};

export function AppShell({ org, orgs, objects, children }: Props) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const nav = <Nav org={org} objects={objects} onNavigate={() => setOpen(false)} />;
  return (
    <div className="min-h-dvh w-full max-w-full overflow-x-hidden md:grid md:grid-cols-[14rem_minmax(0,1fr)]">
      <aside className="hidden border-r bg-muted/30 md:flex md:flex-col">
        <div className="px-4 py-4 text-lg font-semibold tracking-tight">Remold</div>
        {nav}
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur md:px-6">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Menu">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <SheetTitle className="px-4 py-4 text-lg">Remold</SheetTitle>
              {nav}
            </SheetContent>
          </Sheet>
          <Select value={org._id} onValueChange={(id) => navigate(`/o/${id}`)}>
            <SelectTrigger className="h-9 max-w-52 border-none bg-transparent font-medium shadow-none" aria-label="Organisation">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {orgs.map(({ org: o }) => (
                <SelectItem key={o._id} value={o._id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <GoToCode orgId={org._id} />
            <UserButton />
          </div>
        </header>
        <main className="min-w-0 flex-1 px-3 py-4 md:px-6 md:py-6">{children}</main>
      </div>
    </div>
  );
}

// Paste a record code (three words) to jump straight to it.
function GoToCode({ orgId }: { orgId: Doc<"orgs">["_id"] }) {
  const convex = useConvex();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  async function go(e: FormEvent) {
    e.preventDefault();
    const found = await convex.query(api.records.byRef, { orgId, ref: code });
    if (!found) return toast.error("No record with that code");
    setCode("");
    navigate(`/o/${orgId}/${found.object.key}/${found.record._id}`);
  }
  return (
    <form onSubmit={go} className="hidden sm:block">
      <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Go to code" aria-label="Go to record code" className="h-8 w-40 font-mono text-xs" />
    </form>
  );
}

function Nav({ org, objects, onNavigate }: { org: Doc<"orgs">; objects: Doc<"objects">[]; onNavigate: () => void }) {
  const link = ({ isActive }: { isActive: boolean }) =>
    cn("flex items-center gap-2 rounded-md px-3 py-2 text-sm", isActive ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground");
  return (
    <nav className="flex flex-1 flex-col gap-0.5 px-2 pb-4">
      {objects.map((object) => (
        <NavLink key={object._id} to={`/o/${org._id}/${object.key}`} className={link} onClick={onNavigate}>
          {object.labelPlural}
        </NavLink>
      ))}
      <NavLink to={`/o/${org._id}/settings`} className={link} onClick={onNavigate}>
        <Plus className="size-4" /> New object
      </NavLink>
      <div className="mt-auto pt-4">
        <NavLink to={`/o/${org._id}/settings`} className={link} onClick={onNavigate}>
          <Settings className="size-4" /> Settings
        </NavLink>
      </div>
    </nav>
  );
}
