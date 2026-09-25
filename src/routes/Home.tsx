import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loading } from "@/components/Loading";
import { attempt } from "@/lib/errors";

export function Home() {
  const orgs = useQuery(api.orgs.mine);
  const create = useMutation(api.orgs.create);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (orgs?.length === 1) navigate(`/o/${orgs[0]!.org._id}`, { replace: true });
  }, [orgs, navigate]);

  if (orgs === undefined) return <Loading page />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    if (!(await attempt(async () => navigate(`/o/${await create({ name: name.trim() })}`)))) setBusy(false);
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-4 py-10">
      <div className="text-[15px] font-semibold tracking-tight">Remold</div>
      {orgs.length > 0 && (
        <section className="grid gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Your organisations</h2>
          {orgs.map(({ org, role }) => (
            <Link key={org._id} to={`/o/${org._id}`} className="flex items-center justify-between rounded-lg border bg-card px-4 py-3 hover:border-primary/40">
              <span className="font-medium">{org.name}</span>
              <span className="text-xs text-muted-foreground">{role}</span>
            </Link>
          ))}
        </section>
      )}
      <form onSubmit={submit} className="grid gap-4 rounded-lg border bg-card p-5">
        <div className="grid gap-1">
          <h1 className="font-semibold">{orgs.length ? "Create another organisation" : "Create your organisation"}</h1>
          <p className="text-sm text-muted-foreground">It starts with People, Companies, Opportunities, Projects, Tasks and Notes. Add your own objects in Settings.</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="org-name">Name</Label>
          <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="CodeMyVibe" required />
        </div>
        <Button type="submit" disabled={busy || !name.trim()}>
          Create
        </Button>
      </form>
    </div>
  );
}
