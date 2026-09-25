import { useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { cn } from "cn";
import { LogOut, Menu } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { useIdentity } from "@/lib/identity";
import { SearchDialog } from "@/components/SearchDialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

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
      <aside className="sticky top-0 hidden h-dvh flex-col border-r bg-sidebar md:flex">
        <div className="px-5 pt-5 pb-4 text-[15px] font-semibold tracking-tight">Remold</div>
        {nav}
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur md:px-8">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Menu">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 gap-0 bg-sidebar p-0">
              <SheetTitle className="px-5 pt-5 pb-4 text-[15px]">Remold</SheetTitle>
              {nav}
            </SheetContent>
          </Sheet>
          {orgs.length > 1 ? (
            <Select value={org._id} onValueChange={(id) => navigate(`/o/${id}`)}>
              <SelectTrigger className="h-9 max-w-52 border-none bg-transparent px-2 font-medium shadow-none" aria-label="Organisation">
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
          ) : (
            <span className="truncate px-2 text-sm font-medium">{org.name}</span>
          )}
          <div className="ml-auto">
            <SearchDialog orgId={org._id} />
          </div>
        </header>
        <main className="min-w-0 flex-1 px-3 py-5 md:px-8 md:py-7">{children}</main>
      </div>
    </div>
  );
}

function Nav({ org, objects, onNavigate }: { org: Doc<"orgs">; objects: Doc<"objects">[]; onNavigate: () => void }) {
  const pending = useQuery(api.suggestions.list, { orgId: org._id, status: "pending" })?.length ?? 0;
  const identity = useIdentity();
  const link = ({ isActive }: { isActive: boolean }) =>
    cn(
      "relative flex h-8 items-center rounded-md px-3 text-sm",
      isActive
        ? "bg-accent font-medium text-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary"
        : "text-muted-foreground hover:bg-muted hover:text-foreground",
    );
  const item = (to: string, label: ReactNode) => (
    <NavLink to={`/o/${org._id}/${to}`} className={link} onClick={onNavigate}>
      {label}
    </NavLink>
  );
  return (
    <nav className="flex flex-1 flex-col gap-0.5 px-2 pb-3">
      {item("today", "Today")}
      {item(
        "suggestions",
        <>
          Suggestions
          {pending > 0 && <span className="ml-auto rounded-md bg-primary px-1.5 text-xs font-medium text-primary-foreground tabular-nums">{pending}</span>}
        </>,
      )}
      <div className="mt-4 mb-1 px-3 text-xs text-muted-foreground">Records</div>
      {objects.map((object) => (
        <NavLink key={object._id} to={`/o/${org._id}/${object.key}`} className={link} onClick={onNavigate}>
          {object.labelPlural}
        </NavLink>
      ))}
      <div className="mt-auto grid gap-0.5 border-t pt-3">
        {item("settings", "Settings")}
        <div className="flex items-center gap-1 pt-1 pl-3">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={identity.user?.email}>
            {identity.user?.email}
          </span>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Sign out" title="Sign out" onClick={() => identity.signOut()}>
            <LogOut />
          </Button>
        </div>
      </div>
    </nav>
  );
}
