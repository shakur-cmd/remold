Round 2 of your judgment. Read-only; do not edit.

Changes since your NOT YET (diff: /tmp/rux/diff.patch, working tree is current):
1. Required fix: one money rule. src/lib/fields.ts now has isMoney(field) (standard "amount" key only), formatNumber(field, value) and quietFor(updatedAt). FieldValue and Board both use formatNumber. On the board a non-money number is labelled with its field name ("3.5 hours", column total "19.5 hours") so it can't read as a count or dollars. Evidence: /tmp/rux/a-board-jobs.png (a custom Jobs object whose first number field is Hours, created through the real objects/fields mutations) and /tmp/rux/a-board.png (opportunities, still $). Two new tests in src/lib/fields.test.ts ("shows any other number as a plain number, so hours never read as dollars"). 73 tests pass; typecheck and build pass.
2. Duplicate task removed: task panels that feed Next step are no longer rendered as separate Tasks panels; Next step lists all open tasks, earliest due first (first one emphasized), plus "N done". Its + Task adds through the same relation. Evidence: /tmp/rux/a-record-opp.png, and /tmp/rux/a-record-opp-done.png after ticking the Next step checkbox (DB confirmed the task's done value became true; the card then reads "No next step yet" and "1 done").
3. One stale phrase: "20 days quiet" on both Today and the board (quietFor).
4. Table columns are chosen once from the first page and then frozen (src/routes/ObjectList.tsx).
5. Type imports made uniform (ReactNode / KeyboardEvent imported from react).
6. Net src lines outside index.css and the test file: 886 insertions, 1107 deletions.

All after screenshots in /tmp/rux/a-*.png were re-shot after these changes; phone shots m-*.png are from before this round (layout code for phones did not change this round except the record page, see m-record.png).

Deliver: remaining problems, if any (most important first), then one line exactly "PLEASED" or "NOT YET". If NOT YET, the minimum remaining changes.
