import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Loading } from "@/components/Loading";
import { errorMessage } from "@/lib/errors";

type Kind = "person" | "company";
const KEYS = ["name", "title", "company", "email", "phone", "linkedin", "domain", "note"] as const;

// Opened by the browser extension with what it read from the page. Nothing is
// saved until the person checks it and presses Save.
export function CapturePage() {
  const [params] = useSearchParams();
  const orgs = useQuery(api.orgs.mine);
  const [orgId, setOrgId] = useState<Id<"orgs"> | null>(null);
  if (orgs === undefined) return <Loading page />;
  if (orgs.length === 0) return <p className="p-6 text-sm text-muted-foreground">Create an organisation in Remold first.</p>;
  const chosen = orgId ?? orgs[0]!.org._id;
  return (
    <div className="mx-auto grid max-w-md gap-4 p-4">
      <h1 className="text-lg font-semibold">Save to Remold</h1>
      {orgs.length > 1 && (
        <Select value={chosen} onValueChange={(id) => setOrgId(id as Id<"orgs">)}>
          <SelectTrigger className="w-full" aria-label="Organisation">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {orgs.map(({ org }) => (
              <SelectItem key={org._id} value={org._id}>
                {org.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <CaptureForm key={chosen} orgId={chosen} initial={Object.fromEntries(KEYS.map((k) => [k, params.get(k) ?? ""]))} initialKind={params.get("kind") === "company" ? "company" : "person"} />
    </div>
  );
}

function CaptureForm({ orgId, initial, initialKind }: { orgId: Id<"orgs">; initial: Record<string, string>; initialKind: Kind }) {
  const save = useMutation(api.capture.save);
  const objects = useQuery(api.objects.list, { orgId });
  const [kind, setKind] = useState<Kind>(initialKind);
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ recordId: string; objectKey: string } | null>(null);
  const set = (key: string) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value }));
  const objectId = (key: string) => objects?.find((o) => o.key === key)?._id;
  const personId = objectId("person"), companyId = objectId("company");
  const sameName = useQuery(api.records.search, objects && values.name!.trim().length >= 3 ? { orgId, objectId: kind === "person" ? personId : companyId, text: values.name!, limit: 3 } : "skip");
  const companyHits = useQuery(api.records.search, companyId && kind === "person" && values.company!.trim() ? { orgId, objectId: companyId, text: values.company!, limit: 5 } : "skip");
  const companyExists = companyHits?.some((hit) => hit.title.trim().toLowerCase() === values.company!.trim().toLowerCase());

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const fields = kind === "person" ? ["title", "company", "email", "phone", "linkedin", "domain"] : ["domain"];
      const extra = Object.fromEntries(fields.map((k) => [k, values[k] || undefined]));
      setSaved(await save({ orgId, kind, name: values.name!, note: values.note || undefined, ...extra }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (saved)
    return (
      <div className="grid gap-3 text-sm">
        <p>Saved {values.name}.</p>
        <div className="flex gap-2">
          <Button asChild>
            <Link to={`/o/${orgId}/${saved.objectKey}/${saved.recordId}`} target="_blank">
              Open in Remold
            </Link>
          </Button>
          <Button variant="outline" onClick={() => window.close()}>
            Close
          </Button>
        </div>
      </div>
    );

  const field = (key: string, label: string, type = "text") => (
    <div className="grid gap-1.5">
      <Label htmlFor={`capture-${key}`}>{label}</Label>
      <Input id={`capture-${key}`} type={type} value={values[key]} onChange={set(key)} />
    </div>
  );

  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="grid grid-cols-2 rounded-md border bg-card p-0.5">
        {(["person", "company"] as const).map((option) => (
          <Button key={option} type="button" size="sm" variant={kind === option ? "secondary" : "ghost"} aria-pressed={kind === option} onClick={() => setKind(option)}>
            {option === "person" ? "Person" : "Company"}
          </Button>
        ))}
      </div>
      {field("name", "Name")}
      {sameName && sameName.length > 0 && <p className="-mt-1 text-xs text-muted-foreground">Already have: {sameName.map((hit) => hit.title).join(", ")}</p>}
      {kind === "person" && (
        <>
          {field("title", "Title")}
          {field("company", "Company")}
          {values.company!.trim() && companyHits && <p className="-mt-1 text-xs text-muted-foreground">{companyExists ? "Links to the existing company" : "Creates a new company"}</p>}
          {field("email", "Email", "email")}
          {field("phone", "Phone", "tel")}
          {field("linkedin", "LinkedIn")}
        </>
      )}
      {kind === "company" && field("domain", "Website")}
      <div className="grid gap-1.5">
        <Label htmlFor="capture-note">Note</Label>
        <Textarea id="capture-note" rows={3} value={values.note} onChange={set("note")} placeholder="Where you met, what they need" />
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <Button type="submit" disabled={busy || !values.name!.trim()}>
        Save
      </Button>
    </form>
  );
}
