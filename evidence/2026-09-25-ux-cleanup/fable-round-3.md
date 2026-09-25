Both required fixes are proven: a-board-jobs shows "3.5 hours" and "19.5 hours" where round one would have printed dollars, a-board keeps "$44,300", and the shared rule lives in one place (`src/lib/fields.ts:36-38`) used by both FieldValue and Board. The record page now lists the task once under Next step, and a-record-opp-done shows the card flipping to "No next step yet · 1 done" after the checkbox write.

Remaining problems, none blocking:

- **State set during render.** `src/routes/ObjectList.tsx:55` calls setFirstPage inside the render body. React tolerates this for the same component, but it is a pattern that surprises the next reader. Move it to a small effect keyed on status, or derive the frozen column list with a ref. Behaviour is correct today.
- **Next step silently ignores a third task relation.** `RecordPage.tsx:314` destructures only two sources. The standard Task object has one lookup, so this cannot happen now, but a custom third lookup to tasks would vanish without a hint. A short comment or a map over all sources would close it.
- **Phone screenshots predate this round.** Only the record page changed for phones, and m-record still reads correctly, so I accept them. Re-shoot m-record when convenient so the evidence set is uniform.
- **USD stays hard-coded** (`fields.ts:37`). Fine for the price test. Log it in the decisions file as a known limit for the first non-US customer.

PLEASED