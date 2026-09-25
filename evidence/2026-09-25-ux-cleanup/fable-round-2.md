**1. Acceptance bar**

1. PASS. Only Settings is highlighted in a-settings; the nav no longer has a "New object" entry (`src/components/AppShell.tsx:86-112`).
2. PASS. a-today shows one text edge for every row, teal wash and left bar on the active item (`AppShell.tsx:77`).
3. PASS. a-board headers read "3 · $44,300"; two cards carry the amber "2w quiet" marker.
4. PASS. a-board cards show "$4,500 · Oct 13"; no ISO dates in any after screenshot, timeline uses formatTime (`src/lib/fields.ts:38`).
5. PASS. a-task and a-task-done show working checkboxes; FieldValue returns null for empty (`src/components/FieldValue.tsx:23`); DB check 1 confirms the write.
6. PASS. a-record-opp right column is Suggested, Next step, Timeline with "Sep 25, 6:50 AM" timestamps.
7. PASS. a-record-opp shows "Tasks 1" and "Notes 1"; via only renders on a collision (`src/routes/RecordPage.tsx:126`).
8. PASS. a-newperson opens with four inputs and "Show 2 more fields"; the picker list is focus-gated (`src/components/RecordPicker.tsx:44-50`).
9. PASS. a-suggestions has no pending badge; a-suggestions-applied shows one line per applied item.
10. PASS. a-search highlights the first result before any key (`src/components/SearchDialog.tsx:82`); check 2 covers arrows and Enter.
11. PASS. index.css has no .dark block; src/ nets 234 lines removed outside index.css.
12. PASS. One filled teal button per screen; nav count badge and links are not buttons. a-newperson shows two only because the trigger sits under the overlay.
13. PASS on your report. I could not run typecheck, tests or build myself, so this item is awaiting independent verification.
14. PASS. Removed deps, template files, ui primitives and dist are listed with reasons.

**2. Regressions and new problems**

- **Money formatting disagrees between board and everywhere else.** FieldValue only formats a number as currency when the field key is "amount" (`FieldValue.tsx:39`), but Board formats the first number field on any object as USD (`src/components/Board.tsx:24,50,82`). A custom "Jobs" object with an "Hours" field will show "$8" on the board and "8" in the table. Use one shared rule, such as an isMoney(field) helper in fields.ts, in both places. This is the only change I require.
- **The same task appears twice on a record page.** a-record-opp lists "Send phased plan to Lena" under both Next step and the Tasks panel, and they run parallel related queries (`RecordPage.tsx:251` and `:314`). Hide the Tasks related panel when Next step is present, or show only the remaining open tasks there.
- **Two words for stale.** Today says "20 days quiet" (`src/routes/Today.tsx:79`), the board says "2w quiet". Pick one phrase.
- **Table columns can shift after load.** Column choice depends on loaded rows (`src/routes/ObjectList.tsx:50-52`), so the header changes once the first page arrives and again on Load more. Acceptable for now, but consider freezing columns after the first page.
- **Currency is hard-coded to USD** (`fields.ts:35`). Fine for the US price test, but note it for the first non-US customer.
- **Minor:** RecordPicker, Suggestions and SearchDialog reference the React namespace for types while AppShell imports the type; harmless, just uneven.

Deviations (a) through (e) are all accepted. The outline Apply is the right call on a page that holds several suggestions.

**3. Verdict**

NOT YET

Minimum change: make Board use the same money rule as FieldValue through one shared helper, then re-shoot a-board and add a screenshot of a board on an object whose first number field is not an amount, showing a plain number. Fix the duplicate task on the record page if it is cheap, but I will not hold the verdict on it.