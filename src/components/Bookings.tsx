import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { attempt } from "@/lib/errors";

const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.success("Copied"), () => toast.error("Could not copy"));
const time = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Admins paste the Stripe webhook signing secret here. It is never shown again.
export function PaymentsCard({ orgId }: { orgId: Id<"orgs"> }) {
  const data = useQuery(api.bookings.paymentSettings, { orgId });
  const save = useMutation(api.bookings.savePaymentSecret);
  const [secret, setSecret] = useState("");
  if (!data) return null;
  const submit = (e: FormEvent) => { e.preventDefault(); void attempt(() => save({ orgId, secret }), "Signing secret saved").then((ok) => ok && setSecret("")); };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments</CardTitle>
        <CardDescription>Paid booking pages use your own Stripe Payment Link. Money goes straight to your Stripe account; Remold only hears that a payment happened.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <p className="text-muted-foreground">1. In Stripe, add a webhook endpoint for the event <span className="font-mono text-foreground">checkout.session.completed</span> at this address:</p>
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 truncate rounded-md border bg-muted px-2 py-1 text-xs">{data.webhookUrl}</code>
          <Button size="icon-xs" variant="ghost" aria-label="Copy webhook address" onClick={() => copy(data.webhookUrl)}><Copy /></Button>
        </div>
        <form className="grid gap-1.5" onSubmit={submit}>
          <span className="text-muted-foreground">2. Paste the endpoint's signing secret. Use the live mode secret: with a test mode secret, test payments would confirm real bookings.</span>
          <div className="flex gap-2">
            <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={data.secretSet ? "Saved. Paste a new one to replace it" : "whsec_..."} aria-label="Signing secret" />
            <Button type="submit" variant="outline" disabled={!secret.trim()}>Save</Button>
          </div>
        </form>
        <p className="flex items-center gap-2">
          {data.secretSet ? <><Check className="size-4 text-emerald-600" aria-hidden /> Signing secret saved. Paid bookings confirm when Stripe reports the payment.</> : <span className="text-muted-foreground">No signing secret yet. Paid bookings stay on hold until one is saved.</span>}
        </p>
        <p className="text-xs text-muted-foreground">A payment below the page's price, or in another currency, waits for you on the booking page. That includes promotion codes you allow on the Payment Link: confirm those with Confirm anyway.</p>
        {data.secretSet && <Button size="sm" variant="ghost" className="justify-self-start text-muted-foreground" onClick={() => attempt(() => save({ orgId, secret: "" }), "Signing secret removed")}>Remove secret</Button>}
      </CardContent>
    </Card>
  );
}

// On a Booking page record: its public link and its bookings, upcoming first.
export function PageBookings({ orgId, recordId }: { orgId: Id<"orgs">; recordId: Id<"records"> }) {
  const rows = useQuery(api.bookings.forPage, { orgId, pageId: recordId });
  const page = useQuery(api.bookings.page, { pageId: recordId });
  const cancel = useMutation(api.bookings.cancel);
  const resolve = useMutation(api.bookings.resolve);
  const link = `${window.location.origin}/book/${recordId}`;
  const now = Date.now();
  return (
    <section className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Bookings</h2>
        {page && (page.open ? <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-1.5 rounded-full bg-emerald-500" aria-hidden /> Taking bookings</span> : <span className="text-xs text-muted-foreground">Not taking bookings</span>)}
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => copy(link)}><Copy /> Copy link</Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground" asChild><a href={link} target="_blank" rel="noreferrer"><ExternalLink /> Open</a></Button>
        </div>
      </div>
      {page && "notice" in page && page.notice && <p className="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{page.notice}</p>}
      {page && !page.open && <p className="text-xs text-muted-foreground">Turn Live on, set hours and a timezone, and make sure REMOLD_BOOKING_DAILY_CAP is set for this Remold.</p>}
      {rows && rows.length === 0 && <p className="rounded-lg border bg-card p-3 text-sm text-muted-foreground">No bookings yet.</p>}
      {rows && rows.length > 0 && (
        <ul className="grid divide-y rounded-lg border bg-card text-sm">
          {rows.map((b) => (
            <li key={b.id} className={b.end < now || b.status === "cancelled" ? "flex flex-wrap items-center gap-2 p-2.5 text-muted-foreground" : "flex flex-wrap items-center gap-2 p-2.5"}>
              <span className="tabular-nums">{time(b.start)}</span>
              {b.personId ? <Link to={`/o/${orgId}/person/${b.personId}`} className="font-medium hover:underline">{b.name}</Link> : <span>Hidden</span>}
              {b.email && <span className="text-xs text-muted-foreground">{b.email}</span>}
              {b.status !== "confirmed" && <Badge variant={b.status === "cancelled" ? "destructive" : "outline"}>{b.attention && b.status === "held" ? "Needs your decision" : b.held ? "Waiting for payment" : b.status === "held" ? "Hold ran out" : "Cancelled"}</Badge>}
              {b.paid && <Badge variant="secondary">Paid {b.paid}{b.test ? " (test)" : ""}</Badge>}
              {b.attention && <span className="text-xs text-destructive">{b.attention}.</span>}
              {b.decide && (
                <span className="flex gap-1">
                  <Button size="xs" variant="outline" onClick={() => attempt(() => resolve({ orgId, bookingId: b.id, action: "confirm" }), "Booking confirmed")}>Confirm anyway</Button>
                  <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => window.confirm("Release this time? Refund the payment in Stripe yourself.") && attempt(() => resolve({ orgId, bookingId: b.id, action: "release" }), "Released. Refund it in Stripe.")}>Release</Button>
                </span>
              )}
              {b.note && <span className="basis-full text-xs text-muted-foreground">{b.note}</span>}
              {b.status !== "cancelled" && !b.attention && b.end >= now && (
                <Button size="xs" variant="ghost" className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => {
                  if (!window.confirm("Cancel this booking? The time opens up again.")) return;
                  void attempt(() => cancel({ orgId, bookingId: b.id, notify: !!b.email && window.confirm("Email them that it is cancelled?") }), "Booking cancelled");
                }}>Cancel</Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
