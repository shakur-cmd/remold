VERDICT: REVISE

I am Astra (gpt-6-astra) via Codex, independently verifying F-m7 at commit `2953d93` against `origin/integ/m3`. Evidence level: SIM. No hosted services, deployments, or real email.

**Must-fix defects**

1. **Company balances omit invoices beyond 500.**  
   `convex/invoices.ts:24–29` truncates rows before calculating totals. With 501 unpaid $1 invoices, expected billed/open is **$501**; actual is **$500**. The UI presents these partial amounts as totals.

   Fix: calculate totals independently of the display limit, preserving read scopes. Explicitly indicate incomplete totals until the calculation is complete. Add a regression exceeding 500 mixed paid/unpaid invoices.

   Evidence: [balance probe](/tmp/verify-F-m7/probes.log).

2. **Paid history can hide overdue invoices on Today.**  
   `convex/lib/daily.ts:21–22` uses the 1,000-row scan cap in `convex/authority/reads.ts:19–22`. With 1,000 older paid invoices followed by an unpaid overdue invoice, Today returns `{invoice:null, titles:[]}`. The invoice card disappears.

   Fix: support bounded continuation through paid history or an indexed unpaid lookup. An exhausted scan budget must not imply that nothing is overdue.

   Evidence: [Today probe](/tmp/verify-F-m7/history-probe.log).

Temporarily increasing both scratch limits by one made all nine tests pass, confirming the boundary causes. Raising limits is not a durable fix. [Diagnostic evidence](/tmp/verify-F-m7/boundary-diagnostic.log).

**Should-fix**

Extend the six invoice tests with display-cap and scan-cap regressions. Their small-data cases miss both defects.

**Verified independently**

- `pnpm install --frozen-lockfile`: completed; already up to date.
- `pnpm typecheck`: passed.
- `pnpm test`: **131 passed**, 33 files.
- `pnpm test:authority`: **99 passed**, 17 files.
- `pnpm verify:release`: **19 passed**, 0 failed.
- `pnpm build`: passed; bundle-size warning.

No timeout failures or flake reruns occurred.

Every behavioral Done-when item has a test: mixed paid/unpaid balances, overdue removal after payment, and blocked agent paid-on writes. Additive migration/idempotency, hidden amounts, record scopes, and proposal defaults passed. My additional foreign-workspace company-ID probe passed.

The schema is unchanged against the job base and rollback target `63dc87b`. New writes reuse applyChange and attributed events; no payment or sending path was added.

**Mutations caught / survived**

Using the installed Vitest binary in a scratch copy:

| Mutation | Result |
|---|---|
| Sum unpaid invoices as paid | Caught: 2 failures |
| Treat only boolean true as closed | Caught: Today failure |
| Remove paid-on agent protection | Caught: 2 failures |
| Reduce display cap from 500 to 5 | **Survived: 6/6 passed** |

Baseline and restored implementation both passed 6/6. [Mutation summary](/tmp/verify-F-m7/mutations-summary.txt).

**Not verified**

I did not independently exercise the browser UI or capture screenshots. No isolated backend was launched; the supplied harness expects `/usr/bin/google-chrome`, which is absent. Builder screenshots remain builder evidence. Actual PDFs, production data, hosted behavior, and runtime rollback were not checked.

Tracked files remain unchanged; no commits were made. Temporary test copies were removed, and evidence logs remain. Both defects require fixes and fresh independent verification.

[Saved verdict](/tmp/verify-F-m7/verdict.md)