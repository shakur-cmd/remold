You are the design lead reviewing Remold, a small-business CRM (React 19, Vite, Tailwind v4, shadcn/ui, Convex). You are in the repo root of a working copy. Read-only: do not edit anything.

The owner, Shakur, asked: "Clean up all the code for remold, improve the user experience and visuals. Done means: Fable is pleased with the work." You are Fable. I (Claude Opus) will implement; you set direction now and will judge the result later against the bar you write today.

Context
- Product: "A CRM you reshape as you go": custom objects/fields without code, every change attributed, AI agents as team members who propose changes that humans apply. Target: owner-operated service businesses (plumbers, clinics, studios). Price test USD 49/workspace/month.
- Owner's taste: simple and meaningful; the change that shrinks the system wins; no bloat; remove complexity without losing what works.
- Earlier plan notes you (Fable 5.1) and Opus wrote after reviewing 23 CRM reference screens: no visual workflow canvases; first create form should be short; one pipeline board with per-stage count and money total plus stale flag; next step above history on each record; compact attributed agent activity; saved filters phrased as sentences; outcome-named recipes.
- Hard constraints for THIS pass: frontend only (src/). The Convex backend API (convex/) is frozen on this branch by release gates, so use only existing queries/mutations (read convex/*.ts to see what exists, e.g. api.records.list supports one sort or one filter on an indexed field; api.today.get; api.suggestions.*; api.records.related). Keep the stack (Tailwind, shadcn/ui primitives in src/components/ui, lucide icons, Geist font is installed). No new dependencies unless clearly worth it. Light mode is primary.

Baseline screenshots (1853x801 desktop, realistic demo data) are PNGs in /tmp/rux/: b-today, b-person, b-company, b-opportunity, b-board, b-task, b-record-opp, b-record-company, b-suggestions, b-settings, b-newperson, b-search. Open each with Read. The source is in src/ (routes/, components/, index.css). Read it.

Deliver, concisely (under ~1200 words), in this order:
1. Verdict on the current UI in 3 sentences.
2. Visual direction: one paragraph plus concrete tokens (palette with oklch values incl. one accent color, radius, type scale/weights, density, borders vs fills, how to use the accent). It should feel distinctive and calm, not a default shadcn template, and suit a trustworthy tool for small-business owners.
3. Prioritized changes, per screen (shell/nav, Today, list/table, board, record page, suggestions, settings, dialogs/forms, search, sign-in/empty/loading states). Each item: what and why, implementable with existing backend queries. Mark must-have vs nice-to-have. Include bugs you notice (e.g. the sidebar "New object" link is highlighted on Settings).
4. Code cleanup targets in src/ you see (duplication, dead code, awkward patterns), prioritizing deletions.
5. Things NOT to do.
6. Your acceptance bar: a numbered checklist (8 to 15 items) of what must be true in the after-screenshots and code for you to say you're pleased. Make each item checkable.
