import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { cn } from "cn";
import { Pause, Play, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RecordForm } from "@/components/RecordForm";
import { attempt } from "@/lib/errors";
import type { Field } from "@/lib/fields";

type Report = FunctionReturnType<typeof api.campaigns.report>;
type Email = Report["emails"][number];
const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const AUDIENCE: Record<string, string> = { everyone: "everyone", notOpened: "people who did not open", notClicked: "people who did not click", notReplied: "people who did not reply" };
// Approving fixes these two; the dialog lists only what still stands in the way after it.
const APPROVAL = /^Not approved/;

// A campaign's emails in order, with their numbers, and the campaign's go switch.
export function CampaignEmails({ orgId, recordId, status, admin }: { orgId: Id<"orgs">; recordId: Id<"records">; status?: { field: Field; value: unknown }; admin: boolean }) {
  const report = useQuery(api.campaigns.report, { orgId, campaignId: recordId });
  const objects = useQuery(api.objects.list, { orgId });
  const emailObject = objects?.find((o) => o.key === "email" && o.isStandard);
  const email = useQuery(api.objects.get, emailObject ? { orgId, objectId: emailObject._id } : "skip");
  const update = useMutation(api.records.update);
  const [creating, setCreating] = useState<"first" | "followUp" | null>(null);
  const [approving, setApproving] = useState<Email | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (!report || !emailObject) return null;
  const active = status?.value === "active";
  const last = report.emails.at(-1);
  const statusOf = (id: string) => email?.fields.find((f) => f.key === "status")?.options?.find((o) => o.id === id)?.label ?? id;
  const go = (next: string) => status && attempt(() => update({ orgId, recordId, values: { [status.field._id]: next } }), next === "active" ? "Campaign started" : "Campaign paused");

  return (
    <section className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Emails</h2>
        {status && (active ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-1.5 rounded-full bg-emerald-500" aria-hidden /> Running</span>
        ) : (
          <span className="text-xs text-muted-foreground">Not sending</span>
        ))}
        <div className="ml-auto flex gap-1">
          {status && (active ? (
            <Button size="sm" variant="outline" onClick={() => go("paused")}><Pause /> Pause</Button>
          ) : (
            <Button size="sm" onClick={() => go("active")}><Play /> Start campaign</Button>
          ))}
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setCreating("first")}><Plus /> New email</Button>
          {last && <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setCreating("followUp")}><Plus /> New follow-up</Button>}
        </div>
      </div>
      <div className="grid gap-2">
        {report.emails.length === 0 && <p className="rounded-lg border bg-card p-3 text-sm text-muted-foreground">No emails yet. Write the first one, then approve it and start the campaign.</p>}
        {report.emails.map((item) => {
          const state = String(item.status ?? "draft"), waiting = (state === "approved" || state === "sending") && item.problems.length > 0;
          return (
            <div key={item.id} className="grid min-w-0 gap-2 rounded-lg border bg-card p-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Link to={`/o/${orgId}/email/${item.id}`} className="min-w-0 truncate text-sm font-medium hover:underline">{String(item.subject ?? "") || "Untitled"}</Link>
                <Badge variant={state === "sent" ? "secondary" : state === "stopped" ? "destructive" : "outline"}>{statusOf(state)}</Badge>
                <div className="ml-auto flex gap-1">
                  {admin && (state === "draft" || state === "stopped") && <Button size="xs" variant="outline" onClick={() => setApproving(item)}>Approve</Button>}
                  {(state === "approved" || state === "sending") && <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => email && attempt(() => update({ orgId, recordId: item.id, values: { [email.fields.find((f) => f.key === "status")!._id]: "stopped" } }), "Email stopped")}>Stop</Button>}
                  {item.recipients.length > 0 && <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setOpen(open === item.id ? null : item.id)}>{open === item.id ? "Hide people" : "People"}</Button>}
                </div>
              </div>
              {item.followsUp != null && <p className="text-xs text-muted-foreground">Follow-up {item.waitDays ?? 3} {(item.waitDays ?? 3) === 1 ? "day" : "days"} later, to {AUDIENCE[String(item.sendTo ?? "notReplied")]}</p>}
              <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
                {[["Recipients", item.counts.recipients], ["Sent", item.counts.sent], ["Delivered", item.counts.delivered], ["Opened", percent(item.rates.opened)], ["Clicked", percent(item.rates.clicked)], ["Replied", item.counts.replied], ["Bounced", item.counts.bounced], ["Unsubscribed", item.counts.unsubscribed]].map(([label, value]) => (
                  <div key={label} className="flex gap-1"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{value}</dd></div>
                ))}
              </dl>
              {waiting && <p className="text-xs text-muted-foreground">Waiting: {item.problems.join(". ")}.</p>}
              {open === item.id && <Recipients orgId={orgId} rows={item.recipients} />}
            </div>
          );
        })}
      </div>
      {email && creating && <NewEmail orgId={orgId} campaignId={recordId} fields={email.fields} objectId={emailObject._id} followsUp={creating === "followUp" ? last?.id : undefined} onClose={() => setCreating(null)} />}
      {approving && <Approve orgId={orgId} email={approving} onClose={() => setApproving(null)} />}
    </section>
  );
}

function NewEmail({ orgId, campaignId, objectId, fields, followsUp, onClose }: { orgId: Id<"orgs">; campaignId: Id<"records">; objectId: Id<"objects">; fields: Field[]; followsUp?: Id<"records">; onClose: () => void }) {
  const create = useMutation(api.records.create);
  const by = (key: string) => fields.find((f) => f.key === key && !f.retired);
  const set = [by("campaign"), by("followsUp"), by("status")];
  // A first email may be scheduled; a follow-up is timed by its wait instead.
  const hidden = [...set, ...(followsUp ? [by("sendAt")] : [by("waitDays"), by("sendTo")])].flatMap((f) => (f ? [f._id] : []));
  const initial = followsUp ? Object.fromEntries([[by("waitDays")?._id, 3], [by("sendTo")?._id, "notReplied"]].filter(([id]) => id)) : {};
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>{followsUp ? "New follow-up" : "New email"}</DialogTitle></DialogHeader>
        <p className="-mt-2 text-sm text-muted-foreground">Plain text. Use {"{{firstName|there}}"}, {"{{name}}"} or {"{{company}}"} to personalise it. It stays a draft until an admin approves it.</p>
        <RecordForm orgId={orgId} fields={fields} hidden={hidden} initial={initial} submitLabel="Save draft" onCancel={onClose} onSubmit={async (values) => {
          await create({ orgId, objectId, values: { ...values, [by("campaign")!._id]: campaignId, [by("status")!._id]: "draft", ...(followsUp && by("followsUp") ? { [by("followsUp")!._id]: followsUp } : {}) } });
          toast.success("Draft saved");
          onClose();
        }} />
      </DialogContent>
    </Dialog>
  );
}

function Approve({ orgId, email, onClose }: { orgId: Id<"orgs">; email: Email; onClose: () => void }) {
  const preview = useQuery(api.campaigns.preview, { orgId, emailId: email.id });
  const approve = useMutation(api.campaigns.approve);
  const [agreed, setAgreed] = useState(false);
  const reasons = Object.entries((preview?.excluded ?? []).reduce<Record<string, number>>((all, row) => ({ ...all, [row.reason!]: (all[row.reason!] ?? 0) + 1 }), {}));
  const still = preview?.problems.filter((p) => !APPROVAL.test(p)) ?? [];
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>Approve this email</DialogTitle></DialogHeader>
        {!preview ? <p className="text-sm text-muted-foreground">Loading</p> : (
          <div className="grid gap-4 text-sm">
            <div className="grid gap-1">
              <p><span className="font-medium tabular-nums">{preview.counts.recipients}</span> {preview.counts.recipients === 1 ? "person gets" : "people get"} this email{preview.counts.waiting > 0 && <>, and <span className="tabular-nums">{preview.counts.waiting}</span> more once their wait is over</>}.</p>
              {reasons.length > 0 && <p className="text-muted-foreground">Left out: {reasons.map(([reason, n]) => `${n} ${reason}`).join(", ")}.</p>}
            </div>
            {preview.rendered && (
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">As {preview.rendered.person.name} sees it</span>
                <div className="rounded-md border bg-muted/40 p-3">
                  <p className="font-medium">{preview.rendered.subject}</p>
                  <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">{preview.rendered.text}</p>
                </div>
              </div>
            )}
            {still.length > 0 && (
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">Still needed before it sends</span>
                <ul className="grid gap-0.5">{still.map((p) => <li key={p} className="flex items-center gap-2"><span className="size-1.5 rounded-full bg-warning" aria-hidden />{p}</li>)}</ul>
              </div>
            )}
            <label className="flex items-start gap-2">
              <Checkbox checked={agreed} onCheckedChange={(on) => setAgreed(on === true)} className="mt-0.5" aria-label="Everyone on this list agreed to hear from me" />
              <span>Everyone on this list agreed to hear from me or already works with me.</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button disabled={!agreed} onClick={async () => { if (await attempt(() => approve({ orgId, emailId: email.id, confirmed: agreed }), "Approved")) onClose(); }}>Approve</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Recipients({ orgId, rows }: { orgId: Id<"orgs">; rows: Email["recipients"] }) {
  const mark = useMutation(api.campaigns.markReplied);
  const yes = (on: boolean) => (on ? "Yes" : <span className="text-muted-foreground">No</span>);
  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow><TableHead>Person</TableHead><TableHead>Email</TableHead><TableHead>Status</TableHead><TableHead>Opened</TableHead><TableHead>Clicked</TableHead><TableHead>Replied</TableHead></TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.sendId}>
            <TableCell><Link to={`/o/${orgId}/person/${row.person.id}`} className="hover:underline">{row.name ?? "Hidden"}</Link></TableCell>
            <TableCell className="text-muted-foreground">{row.address ?? "Hidden"}</TableCell>
            <TableCell className={cn(row.status === "failed" && "text-destructive")}>{row.status === "skipped" ? `Skipped: ${row.skipReason}` : row.status === "failed" ? `Failed${row.failReason ? `: ${row.failReason}` : ""}` : row.status[0]!.toUpperCase() + row.status.slice(1)}</TableCell>
            <TableCell>{yes(row.opened)}</TableCell>
            <TableCell>{yes(row.clicked)}</TableCell>
            <TableCell>{row.replied ? "Yes" : row.status === "sent" ? <Button size="xs" variant="ghost" className="-ml-2 text-muted-foreground" onClick={() => attempt(() => mark({ orgId, sendId: row.sendId }), "Marked replied")}>Mark replied</Button> : <span className="text-muted-foreground">No</span>}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
