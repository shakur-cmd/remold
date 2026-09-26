Fresh Opus 5.5 review of A1 r2 (sha256 8038c3683bacc3931d36550b7db4e3f4976ea6b8b15cb6ba0864ae26fc7552c5), 2026-09-26, read-only. Verdict: REVISE.
All 15 own and 15 Fable r1 findings resolved. New:
1 Medium: SetupOp, meta and opsHash canonical form undefined; spell out the union.
2 Medium: approve-with-renamed-key contradicts hash check; add keyRenames or cut.
3 Medium: a thrown precondition rolls back, so proposal stays pending, cannot become closed; patch dismissed and return, or define.
4 Medium: fields on a same-proposal new object impossible; allow objectRef under 'new' scope.
5 Low: seeding exemption wrong; seed.ensureStandard adds to existing orgs; exempt by name or event as operator.
6 Low: stale proposals (epoch moved / grant dead) consume open cap; treat as closed.
7 Low: slot refusal only when kindFor returns a kind; say whether human path changes.
Owner decisions right; 10 ops and 3 open fine.
