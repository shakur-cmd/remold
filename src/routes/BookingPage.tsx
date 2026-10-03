import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, Clock } from "lucide-react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loading } from "@/components/Loading";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

// The public page behind a booking link. No sign-in. Times are shown in the
// visitor's own zone; the server checks the chosen time again when they book.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayKey = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: zone });
const dayLabel = (ms: number) => new Date(ms).toLocaleDateString(undefined, { timeZone: zone, weekday: "short", month: "short", day: "numeric" });
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { timeZone: zone, hour: "numeric", minute: "2-digit" });
const full = (ms: number) => new Date(ms).toLocaleString(undefined, { timeZone: zone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const zoneName = new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: "long" }).formatToParts(Date.now()).find((p) => p.type === "timeZoneName")?.value;

export function BookingPage() {
  const { pageId = "" } = useParams();
  const [params] = useSearchParams();
  const page = useQuery(api.bookings.page, { pageId });
  const book = useMutation(api.bookings.book);
  const [day, setDay] = useState<string | null>(null);
  const [start, setStart] = useState<number | null>(null);
  const [form, setForm] = useState({ name: "", email: "", note: "", hp: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<number | null>(null);
  const days = useMemo(() => {
    const out = new Map<string, number[]>();
    for (const slot of page?.open ? page.slots : []) out.set(dayKey(slot), [...(out.get(dayKey(slot)) ?? []), slot]);
    return [...out];
  }, [page]);

  if (page === undefined) return <Loading page />;
  if (!page.open) return <Shell><p className="text-center text-muted-foreground">{page.message}</p></Shell>;
  if (booked !== null) return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-tight">You are booked</h1>
      <p>{page.name} on {full(booked)}.</p>
    </Shell>
  );
  const chosenDay = day ?? days[0]?.[0] ?? null, times = days.find(([key]) => key === chosenDay)?.[1] ?? [];
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (start === null) return;
    setBusy(true); setError(null);
    try {
      const result = await book({ pageId, start, name: form.name, email: form.email, ...(form.note.trim() ? { note: form.note } : {}), zone, ...(params.get("s") ? { s: params.get("s")! } : {}), ...(form.hp ? { hp: form.hp } : {}) });
      if (result.status === "held") { window.location.assign(result.pay); return; }
      if (result.status === "confirmed") setBooked(start);
      else if (result.status === "taken") { setStart(null); setError("Someone just took that time. Please pick another."); }
      else if (result.status === "limited") setError("This page is busy right now, or you already have a time waiting for payment. Please try again in a few minutes.");
      else setError("This page is not taking bookings.");
    } catch (err) { setError(errorMessage(err)); }
    setBusy(false);
  }

  return (
    <Shell>
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{page.name}</h1>
        <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-1"><Clock className="size-3.5" aria-hidden /> {page.minutes} minutes</span>
          {page.price != null && page.price > 0 && <span>{page.currency ? new Intl.NumberFormat(undefined, { style: "currency", currency: page.currency.toUpperCase(), minimumFractionDigits: page.price % 1 ? 2 : 0 }).format(page.price) : page.price}{page.paid ? ", paid when you book" : ""}</span>}
        </p>
        {page.description && <p className="mt-1 whitespace-pre-line text-sm">{page.description}</p>}
      </header>
      {"notice" in page && page.notice && <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{page.notice}</p>}

      {start === null ? (
        <section className="grid gap-3">
          <p className="text-xs text-muted-foreground">Times are in your time zone: {zoneName ? `${zoneName} (${zone})` : zone}.</p>
          {days.length === 0 && <p className="text-sm text-muted-foreground">No open times right now. Please check back later.</p>}
          {days.length > 0 && (
            <>
              <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="listbox" aria-label="Day">
                {days.map(([key, slots]) => (
                  <button key={key} type="button" role="option" aria-selected={key === chosenDay} onClick={() => setDay(key)}
                    className={cn("shrink-0 rounded-md border px-3 py-1.5 text-sm", key === chosenDay ? "border-foreground bg-foreground text-background" : "bg-card hover:bg-muted")}>
                    {dayLabel(slots[0]!)}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4" aria-label="Time">
                {times.map((slot) => <Button key={slot} variant="outline" onClick={() => { setStart(slot); setError(null); }}>{clock(slot)}</Button>)}
              </div>
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </section>
      ) : (
        <form className="grid gap-3" onSubmit={submit}>
          <div className="flex items-center gap-2">
            <Button type="button" size="icon-xs" variant="ghost" aria-label="Pick another time" onClick={() => setStart(null)}><ArrowLeft /></Button>
            <p className="text-sm font-medium">{full(start)}</p>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="name">Name</Label><Input id="name" required autoComplete="name" value={form.name} onChange={set("name")} /></div>
          <div className="grid gap-1.5"><Label htmlFor="email">Email</Label><Input id="email" type="email" required autoComplete="email" value={form.email} onChange={set("email")} /></div>
          <div className="grid gap-1.5"><Label htmlFor="note">Anything we should know? (optional)</Label><Textarea id="note" rows={3} value={form.note} onChange={set("note")} /></div>
          {/* Left empty by people; bots fill it in. A name and no label that autofill does not recognise. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden"><input name="x_hp7" tabIndex={-1} autoComplete="off" data-1p-ignore data-lpignore="true" value={form.hp} onChange={set("hp")} /></div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={busy}>{page.paid ? "Continue to payment" : "Book this time"}</Button>
          {page.paid && <p className="text-xs text-muted-foreground">We hold this time for 30 minutes while you pay with Stripe.</p>}
        </form>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <main className="mx-auto grid max-w-xl gap-5 px-4 py-10">{children}</main>;
}
