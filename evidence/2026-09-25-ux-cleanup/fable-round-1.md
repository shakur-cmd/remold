**1. Verdict.** The current UI is a clean, competent shadcn default: legible, consistent, and honest about what the backend can do, which is a good foundation. It has no point of view yet, so a plumber or clinic owner sees a generic grey admin tool rather than something calm and theirs, and a few screens (board, tables, record page) hide the answers they came for behind raw values and jargon. The fix is a tighter token layer, a handful of per-screen edits that surface counts, money, staleness and next step, and deleting what isn't earning its place.

**2. Visual direction.** Warm paper, dark ink, one quiet teal. Everything sits on a faintly warm off-white; cards are pure white on that paper so they lift without shadows; hairlines are tinted, never pure grey. Text is Geist at a slightly denser rhythm than shadcn ships, with numbers in tabular figures. The single accent is a deep teal used sparingly for the one thing that matters on each screen: the primary button, the active nav mark, links, focus, and anything an agent proposed. Red stays for overdue and destructive only, amber for stale. It should read as a well-made ledger, not a dashboard.

Tokens (light mode; delete the dark block):

```
--background: oklch(0.985 0.004 80)   /* paper */
--card / --popover: oklch(1 0 0)
--foreground: oklch(0.22 0.012 60)    /* warm ink */
--muted: oklch(0.955 0.006 80)
--muted-foreground: oklch(0.50 0.012 60)
--border / --input: oklch(0.90 0.008 75)
--sidebar: oklch(0.965 0.006 80)
--primary: oklch(0.48 0.085 195)      /* teal accent, also --ring, --sidebar-primary */
--primary-foreground: oklch(0.99 0 0)
--accent: oklch(0.94 0.02 195)        /* teal wash: active nav, suggestion card border/bg */
--accent-foreground: oklch(0.32 0.07 195)
--destructive: oklch(0.55 0.19 27)
stale/warn: oklch(0.70 0.14 70) with 12% wash
--radius: 0.5rem (cards rounded-lg, controls rounded-md, badges rounded-md not pill)
```

Type: page title 20/600 tracking-tight; card and column titles 14/600; body 14/400; table and board 13/400; labels and meta 12/400 muted; `tabular-nums` on every number and date. Density: table rows 36px, list rows 32px, card padding 16px, page gap 20px. Borders over fills for containers; fills (accent wash) only to mark state. Primary button is teal, at most one per view; all other buttons outline or ghost.

**3. Prioritized changes.**

Shell and nav
- Must: delete the "New object" nav link. It points at Settings, so it highlights on Settings, and Settings already creates objects. (`src/components/AppShell.tsx:86`)
- Must: align nav text. Drop the three lucide icons or give every row the same left edge; today object rows sit 24px left of Today.
- Must: active nav item gets the accent wash plus a 2px teal left bar; suggestion count badge in teal.
- Must: when the user has one org, render the name as text, not a select with a chevron.
- Nice: move Sign out into the sidebar footer beside Settings, showing the user's email in small muted text.

Today
- Must: Follow-ups first, agent inbox second. The owner opens Today to see what to do, not to talk to the bot.
- Must: rename "Leave it" to "Leave note"; keep the placeholder example.
- Must: overdue rows get a red date, not a red group header, and the row shows relative words ("2 days ago", "Today", "Fri").
- Nice: one line under the title: "3 suggestions waiting" linking to Suggestions, using the existing pending list length.

List and table
- Must: dates render short locale ("Sep 22, 2026"), numbers with tabular figures and right alignment; empty cells render nothing, not a dot.
- Must: booleans render a real checkbox in tables; on Tasks the checkbox completes the task via records.update, same as Today.
- Must: sortable headers show a hover affordance; the current sort arrow uses the accent.
- Nice: choose the six columns from fields that have a value in at least one loaded row, falling back to field order. Companies currently shows four all-empty columns.
- Nice: "Load more" becomes a quiet text row inside the table foot.

Board
- Must: column header shows count and money total of loaded cards (sum of the first number field, formatted as currency without decimals) with "+" when more can load. Compute client-side from results.
- Must: stale flag: cards with updatedAt older than 14 days get a small amber dot and "3w quiet"; the record already carries updatedAt.
- Must: card body shows "$4,500 · Oct 13" on one line; drop the ISO date.
- Must: hide the "No stage" column when empty and status is not loading.
- Nice: column width 16rem so six stages fit at 1853px without a scrollbar.

Record page
- Must: "Tasks via About" becomes "Tasks"; show "via X" only when two panels from the same object would otherwise collide.
- Must: next step above history. Right column order: Suggested, then "Next step" (the earliest open related task with a checkbox, from the Tasks related panel data), then Timeline.
- Must: timeline timestamps become short ("Sep 25, 6:50 AM"); "Created · Updated" line uses the same format.
- Must: pending suggestion card uses the accent wash border, not primary/40.
- Nice: field grid labels in 12px muted with 2px gap; remove the inner button padding jump on hover by giving the view state the same padding as the input.

Suggestions
- Must: drop the "pending" badge inside "Waiting for you"; show a badge only for conflicted or applied.
- Must: "Recently applied" renders one compact line per item (agent, verb, target, time), not full cards.
- Must: the "Apply" button is the accent primary; "Dismiss" is ghost.

Settings
- Must: agent grants grid gets column headers (create, update, delete) and object rows, replacing the per-row repeated labels.
- Must: the issued-key panel uses the accent wash, and the two `pre` blocks get a copy button.
- Nice: field rename uses an inline input instead of `prompt()`.

Dialogs and forms
- Must: RecordPicker shows results only while focused or typing. The New Person dialog currently opens with the full company list expanded.
- Must: first create form shows the title field plus the first three fields; a "Show N more fields" toggle reveals the rest, reusing the record page pattern.
- Must: required marker is a muted "required" word, not a red asterisk.

Search
- Must: first result is visibly highlighted so Enter is predictable; arrow keys move the highlight.
- Must: results grouped by object label in the right column, in 12px muted.

Sign-in, empty, loading
- Must: Loading renders a Skeleton-shaped placeholder for lists (three rows) instead of the word "Loading" centred in 40vh; delete the unused label prop.
- Must: empty table state includes the "New" action in the message.
- Nice: sign-in page gets the paper background and the tagline in ink, button in teal.

**4. Cleanup targets (deletions first).**
- Delete `src/components/ui/tabs.tsx`, `skeleton.tsx`, `separator.tsx` if unused after this pass; only Skeleton should survive if Loading adopts it.
- Delete the `.dark` block, the `@custom-variant dark`, and all chart tokens in `src/index.css`. Light mode is primary and nothing reads them.
- One `attempt(action, successMessage)` in `src/lib/errors.ts` replaces the `run` helper in Settings and the six hand-rolled try/toast blocks in Today, Board, InboxCard, RecordPage, AgentsCard and SuggestionCard.
- One `toKey(label)` helper replaces the duplicated regex at `src/routes/Settings.tsx:151` and `:211`.
- RelatedPanel already loads the source object; pass its body field to NoteComposer and drop the second objects.get query.
- Timeline's `show` formatter duplicates FieldValue; use FieldValue with plain.
- `src/components/ui/button.tsx` imports cn from "cn" while app code uses "@/lib/utils". Pick one.
- CapturePage hand-rolls a segmented control and a native select; use the existing primitives.

**5. Do not.**
- No dark mode work, charts, dashboards, workflow canvases, or per-object icon maps.
- No new dependencies (no cmdk, date-fns, tanstack table for this pass).
- No edits under convex/, no new query shapes, no client-side full-table fetches to fake totals.
- No second accent, no gradients, no shadows beyond the dialog.
- No splitting RecordPage into more files unless a piece is reused.

**6. Acceptance bar.**
1. Settings screenshot shows only Settings highlighted; the "New object" nav entry is gone.
2. All nav rows share one left text edge; active row has the teal wash and bar.
3. Board columns show "3 · $44,300" style headers; at least one card carries an amber stale marker in the demo data.
4. Board cards show currency and short date on one line; no ISO dates anywhere in screenshots.
5. Tables show no "·" placeholders; Tasks rows have working checkboxes that complete a task.
6. Record page right column reads Suggested, Next step, Timeline, top to bottom, with short timestamps.
7. No "via About" text on record pages with a single relation from that object.
8. New Person dialog opens with the company list collapsed and no more than four inputs visible.
9. Suggestions page has no "pending" badges in the waiting section; applied items are one line each.
10. Search dialog highlights the first result before any key press.
11. `src/index.css` has no `.dark` block; `git diff --stat` shows net lines removed in src/ outside index.css.
12. Primary teal appears at most once per screenshot as a filled button.
13. `pnpm tsc --noEmit` and `pnpm vitest run` pass, and the twelve after-screenshots are captured at the same 1853x801 viewport with the same demo data.
14. Every removed file or helper is listed in the handover with the reason it was dead.