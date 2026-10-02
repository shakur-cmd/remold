// Remold Gmail sync. Runs daily inside the owner's own Google account and posts
// one email Activity per message to or from a person already in Remold. It reads
// only each message's id, date, draft flag and From/To/Cc/Bcc addresses: never a
// subject, body or attachment. Setup: README.md. Pure helpers: logic.js.

const SYNC = { overlapMs: 3600000, lookbackDays: 90, windowDays: 14, batch: 10, pageSize: 100, budgetMs: 270000, retries: 5 };
const DAY = 86400000;

// The trigger passes an event object; tests pass a start time and overrides of SYNC.
function syncGmail(startedAt, options) {
  const cfg = Object.assign({}, SYNC, options);
  const now = cfg.now || Date.now, started = typeof startedAt === "number" ? startedAt : now();
  const props = PropertiesService.getScriptProperties();
  const base = String(props.getProperty("REMOLD_BASE_URL") || "").replace(/\/+$/, ""), key = props.getProperty("REMOLD_KEY");
  if (!base || !key) throw new Error("Set REMOLD_BASE_URL and REMOLD_KEY in Script Properties first");
  try {
    const watermark = props.getProperty("WATERMARK"), windowDays = wholeDays(props.getProperty("WINDOW_DAYS"), cfg.windowDays);
    const left = function () { return cfg.budgetMs - (now() - started); }, late = function () { return left() < 0; };
    const owners = ownerAddresses(Session.getEffectiveUser().getEmail(), GmailApp.getAliases(), props.getProperty("OWNER_EMAILS"));
    // The owner's own addresses never count as contact, so searching them would only read the whole mailbox.
    const people = peopleByEmail(fetchAll(base, key, "/api/v1/records?object=person&limit=100")), emails = Object.keys(people).filter(function (email) { return !owners[email]; });
    const save = function (at) { if (at > (Number(props.getProperty("WATERMARK")) || 0)) props.setProperty("WATERMARK", String(at)); };
    // Windows of WINDOW_DAYS, oldest first, until time runs out: a long backlog is read in pieces
    // that each fit a run, and the watermark moves only over pieces whose posts all went through.
    let since = startFrom(watermark, started, wholeDays(props.getProperty("LOOKBACK_DAYS"), cfg.lookbackDays), cfg.overlapMs);
    let messages = 0, posted = 0, windows = 0, mark = null, complete = false;
    const first = since, before = Number(watermark) || 0;
    for (;;) {
      const until = Math.min(started, since + windowDays * DAY), read = readMessages(emails, since, until < started ? until : null, late, cfg);
      messages += read.messages.length;
      if (read.timedOut) {
        // Not even one window fit: the next run tries half as many days.
        if (!windows) { if (windowDays <= 1) throw new Error("Reading one day of Gmail takes longer than a run allows"); props.setProperty("WINDOW_DAYS", String(Math.floor(windowDays / 2))); }
        break;
      }
      let posts = planPosts(read.messages, people, owners);
      if (posts.length) {
        const logged = loggedKeys(fetchAll(base, key, "/api/v1/records?object=activity&limit=100&range%5Bwhen%5D=" + encodeURIComponent(new Date(since).toISOString() + ".." + new Date(until).toISOString())));
        posts = posts.filter(function (post) { return !logged[post.key]; });
      }
      let i = 0;
      for (; i < posts.length && !late(); i++) {
        if (!remold(base, key, "post", "/api/v1/changes", posts[i].body, posts[i].key, left)) break;
        posted++;
        if (!posts[i + 1] || posts[i + 1].messageId !== posts[i].messageId) mark = posts[i].at;
      }
      if (i < posts.length) break;
      // Saved now, so a later window's failure or a killed run keeps this one.
      mark = until;
      save(mark);
      windows++;
      if (until === started) { complete = true; break; }
      if (late()) break;
      since = until;
    }
    if (mark !== null) save(mark);
    const summary = { people: emails.reduce(function (n, email) { return n + people[email].length; }, 0), messages: messages, posted: posted, complete: complete, from: new Date(first).toISOString(), through: new Date(Number(props.getProperty("WATERMARK")) || first).toISOString() };
    props.setProperty("LAST_RUN", new Date(started).toISOString() + " " + JSON.stringify(summary));
    // A run that moved nothing is stuck, and the next one would be too: say so where the owner looks.
    const moved = complete || (Number(props.getProperty("WATERMARK")) || 0) > before;
    props.setProperty("LAST_ERROR", moved ? "" : new Date(started).toISOString() + " No progress: read " + messages + " messages and posted " + posted + "; the watermark stayed at " + summary.through);
    console.log(JSON.stringify(summary));
    return summary;
  } catch (error) {
    // Failing the run makes Apps Script email the owner about it.
    props.setProperty("LAST_ERROR", new Date(started).toISOString() + " " + error.message);
    throw error;
  }
}

function fetchAll(base, key, path) {
  let records = [], cursor = null;
  do {
    const page = remold(base, key, "get", path + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    records = records.concat(page.records);
    cursor = page.cursor;
  } while (cursor);
  return records;
}

// The only Gmail reads in this project. Do not add getSubject, getBody,
// getPlainBody, getRawContent, getAttachments or getHeader here.
function readMessages(emails, since, until, late, cfg) {
  const seen = {}, out = [];
  const take = function (threads) {
    GmailApp.getMessagesForThreads(threads).forEach(function (messages) {
      messages.forEach(function (message) {
        const id = message.getId();
        if (seen[id] || message.isDraft()) return;
        seen[id] = true;
        const at = message.getDate().getTime();
        if (at >= since && (until === null || at < until)) out.push({ id: id, at: at, from: message.getFrom(), to: message.getTo(), cc: message.getCc(), bcc: message.getBcc() });
      });
    });
  };
  for (let b = 0; b < emails.length; b += cfg.batch) {
    const query = buildQuery(emails.slice(b, b + cfg.batch), since, until);
    let start = 0;
    for (; ; start += cfg.pageSize) {
      if (late()) return { messages: out, timedOut: true };
      const threads = GmailApp.search(query, start, cfg.pageSize);
      take(threads);
      if (threads.length < cfg.pageSize) break;
    }
    // Gmail lists threads by their newest message, so one that got mail while later pages were read
    // jumped to the front, past the offsets already read. Reading the first page again catches it.
    if (start > 0) take(GmailApp.search(query, 0, cfg.pageSize));
  }
  // A read that ended past the limit leaves no time to post; counting it as out of time halves the next window instead of repeating it.
  return { messages: out, timedOut: late() };
}

// Returns null, having posted nothing, when a rate-limit wait would outlast the run's time left.
function remold(base, key, method, path, body, idempotencyKey, left) {
  for (let attempt = 0; ; attempt++) {
    const headers = { Authorization: "Bearer " + key };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const params = { method: method, headers: headers, muteHttpExceptions: true, followRedirects: false };
    if (body) { params.contentType = "application/json"; params.payload = JSON.stringify(body); }
    const response = UrlFetchApp.fetch(base + path, params), status = response.getResponseCode(), text = response.getContentText();
    if (status >= 200 && status < 300) return JSON.parse(text);
    if (status === 429 && attempt < SYNC.retries) {
      const wait = 1000 * (Number(headerOf(response, "retry-after")) || 30);
      // Apps Script kills a run at six minutes; stopping here lets the next run continue cleanly.
      if (left && wait > left()) return null;
      Utilities.sleep(wait);
      continue;
    }
    let error = {};
    try { error = JSON.parse(text).error || {}; } catch (ignored) { /* not JSON */ }
    throw new Error("Remold refused " + method.toUpperCase() + " " + path.split("?")[0] + ": " + status + " " + (error.code || "") + ": " + (error.message || ""));
  }
}

function headerOf(response, name) {
  const headers = response.getHeaders() || {};
  for (const header in headers) if (header.toLowerCase() === name) return headers[header];
  return null;
}

// Run once by hand: replaces any earlier daily trigger for syncGmail with one at about 6am.
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) { if (trigger.getHandlerFunction() === "syncGmail") ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger("syncGmail").timeBased().everyDays(1).atHour(6).create();
}
