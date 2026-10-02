# Gmail sync

Puts a dated "Email sent" or "Email received" Activity on each person in Remold,
so their last contact is true. It is a Google Apps Script that runs daily inside
your own Google account. Remold never gets your Gmail credentials or any mail
content. The script reads only each message's id, date and From/To/Cc/Bcc
addresses, and only for people already in Remold.

Setup needs your Google sign-in and a Remold owner sign-in. It takes about ten
minutes, once.

1. In Remold, open Settings → Agents and press **Create Gmail sync key** (owners
   only). Copy the key and the base URL it shows. The key can read people's
   names and emails, read and create Activities, and nothing else. It expires
   after a year; make a new one then.
2. Go to <https://script.google.com>, signed in as the Gmail account to sync,
   and choose **New project**. Name it "Remold Gmail sync".
3. Replace the contents of `Code.gs` with `Code.gs` from this folder. Add a script
   file (+ → Script) named `logic` and paste `logic.js` into it.
4. Project Settings (gear) → tick **Show "appsscript.json" manifest file in
   editor**. Back in the editor, replace `appsscript.json` with the one here. It
   limits the script to Gmail, outbound requests, triggers and your address.
5. Project Settings → **Script Properties** → add:
   - `REMOLD_BASE_URL`: the base URL from step 1, without a trailing slash.
   - `REMOLD_KEY`: the key from step 1.
   - Optional `LOOKBACK_DAYS`: how far back it ever reads (default 90).
   - Optional `WINDOW_DAYS`: how many days of mail it reads at a time (default
     14). It halves this itself when one window does not fit in a run.
     Both day counts must be positive whole numbers like `30`; anything else
     means the default.
   - Optional `OWNER_EMAILS`: other addresses of yours, comma separated, if they
     are not Gmail aliases ("send mail as") of this account.
6. In the editor pick `syncGmail` and press **Run**. Google asks you to
   authorize; the app is your own script, so choose Advanced → Go to Remold Gmail
   sync. Check the execution log for a line like
   `{"people":120,"messages":340,"posted":95,"complete":true,...}`.
   A first run that is not complete just continues on the next run.
7. Pick `installDailyTrigger` and press **Run** once. It adds a daily trigger at
   about 6am (Triggers, the clock icon, shows it).

## How it behaves

- Reruns are safe: before posting a window it reads that window's Activities
  back from Remold and skips any email already logged for that person (source
  `gmail:<message id>`). Each post also carries an `Idempotency-Key` of
  `gmail:<message id>:<person id>`, which Remold honours for 24 hours per key,
  so a retried request never lands twice. An email Activity you delete in
  Remold comes back only if a later run reads that day again (the one-hour
  overlap, or after you delete `WATERMARK`).
- It reads Gmail in windows of `WINDOW_DAYS` (default 14), oldest first, until
  the run's 270 seconds are used, so a long first backlog spreads over a few
  runs. If one window cannot be read in a run, it halves `WINDOW_DAYS` itself.
- Script Property `WATERMARK` records how far it got. It is saved after each
  window whose posts all went through, so a run that fails or is stopped keeps
  the windows it finished. Delete it to re-read the last `LOOKBACK_DAYS` (for
  example after adding many people); nothing is duplicated.
- Any refusal from Remold (a 4xx other than rate limiting, or a 5xx) stops the
  run, keeps `WATERMARK` at the last finished window, writes `LAST_ERROR`, and
  fails the execution, which makes Google email you. Rate limits are waited out
  only while the wait fits in the run's 270 seconds; a longer one ends the run
  early and the next run carries on.
- A run that ends without moving `WATERMARK` (one window too slow to read, or a
  rate limit longer than the run) writes `LAST_ERROR` starting "No progress"
  without failing; a later run that moves it clears `LAST_ERROR`.
- Your own addresses are never searched for: mail to yourself is not contact,
  even if you are a person in Remold.
- Mail you sent counts as contact with everyone it went to; mail you received
  counts only for its sender. Drafts and chats are skipped.
- To stop: delete the trigger, or revoke the key in Remold Settings → Agents.
