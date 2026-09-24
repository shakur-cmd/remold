import { useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { useIdentity } from "@/lib/identity";
import { SearchDialog } from "@/components/SearchDialog";
import { CalendarCheck, Menu, Plus, Settings, Sparkles } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
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
  const identity = useIdentity();
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
            <SearchDialog orgId={org._id} />
            <Button variant="ghost" size="sm" onClick={() => identity.signOut()} title={identity.user?.email}>Sign out</Button>
          </div>
        </header>
        <main className="min-w-0 flex-1 px-3 py-4 md:px-6 md:py-6">{children}</main>
      </div>
    </div>
  );
}

function Nav({ org, objects, onNavigate }: { org: Doc<"orgs">; objects: Doc<"objects">[]; onNavigate: () => void }) {
  const pending = useQuery(api.suggestions.list, { orgId: org._id, status: "pending" })?.length ?? 0;
  const link = ({ isActive }: { isActive: boolean }) =>
    cn("flex items-center gap-2 rounded-md px-3 py-2 text-sm", isActive ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground");
  return (
    <nav className="flex flex-1 flex-col gap-0.5 px-2 pb-4">
      <NavLink to={`/o/${org._id}/today`} className={link} onClick={onNavigate}>
        <CalendarCheck className="size-4" /> Today
      </NavLink>
      {objects.map((object) => (
        <NavLink key={object._id} to={`/o/${org._id}/${object.key}`} className={link} onClick={onNavigate}>
          {object.labelPlural}
        </NavLink>
      ))}
      <NavLink to={`/o/${org._id}/suggestions`} className={link} onClick={onNavigate}>
        <Sparkles className="size-4" /> Suggestions
        {pending > 0 && <span className="ml-auto rounded-full bg-primary px-2 text-xs font-medium text-primary-foreground">{pending}</span>}
      </NavLink>
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
