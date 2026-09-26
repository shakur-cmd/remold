# Remold

Build from docs/build-plan.html, the approved 2026-09-22 r3 plan (source SHA256 prefix 74a7c7965e4c). This file resolves stale instructions in the earlier build prompt.

- AGPL-3.0-only, from scratch, public repository. No copied Twenty code.
- Use pnpm. Convex for all backend data and functions; Clerk behind one identity module.
- React, Vite, strict TypeScript, React Router, Tailwind, shadcn/ui, TanStack Table, dnd-kit when the frontend step begins. No UI during the Step 0 design spike.
- Metadata first. Standard and custom objects use the same path.
- Every production write goes through applyChange and an attributed event. Agents suggest by default. No LLM key or provider adapter; subscription sessions connect over MCP/REST. Jev later, with rules fallback.
- The spike branch contains internal-only benchmark functions, synthetic data and both candidate schemas. Do not deploy it to production or treat it as the selected schema.
- Step 0 requires 50,000 records per candidate, 12 fields, correct IDs and cursor order, three runs of 20 samples, engine timing and read evidence, and an independent verifier. Local emulator timings do not qualify.
- Do not progress to Step 1 before the design gate passes. Builder evidence is not independent certification.
- Keep reports and handovers single-file HTML. Preserve before/after evidence. Never invent performance numbers.
