import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { attempt } from "@/lib/errors";

// Notes for the next agent session: a call summary, a voice memo transcript,
// anything the code cannot turn into records by itself.
export function InboxCard({ orgId }: { orgId: Id<"orgs"> }) {
  const items = useQuery(api.inbox.list, { orgId, status: "pending" });
  const add = useMutation(api.inbox.add);
  const remove = useMutation(api.inbox.remove);
  const [text, setText] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await attempt(() => add({ orgId, text: text.trim(), source: "web" }), "Left for your agent")) setText("");
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>For your agent</CardTitle>
        <CardDescription>Drop a call note here. The next agent session picks it up first and proposes the records.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <form onSubmit={submit} className="grid gap-2">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Spoke with Dana at Atlas, wants a proposal by Friday, budget around 4k" rows={2} aria-label="Note for your agent" />
          <Button type="submit" variant="outline" size="sm" className="justify-self-end" disabled={!text.trim()}>
            Leave note
          </Button>
        </form>
        {items?.map((item) => (
          <div key={item._id} className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <p className="min-w-0 flex-1 whitespace-pre-wrap">{item.text}</p>
            <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={() => attempt(() => remove({ orgId, id: item._id }))}>
              Remove
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
