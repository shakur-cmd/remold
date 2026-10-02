// Pure helpers for Code.gs. Apps Script loads every file of a project into one
// global scope, and sync.test.ts loads this file the same way. Nothing here
// touches Gmail or Remold.

const ADDRESS = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/g;

// Only plain addresses go into a Gmail query; anything else could change its meaning.
function cleanEmail(value) {
  const email = String(value == null ? "" : value).trim().toLowerCase();
  return /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email) ? email : null;
}

// Addresses in an address header. Quoted display names can hold an address-like text, so they go first.
function addressesIn(header) {
  return String(header || "").toLowerCase().replace(/"[^"]*"/g, "").match(ADDRESS) || [];
}

// The sender is the address in angle brackets when there is one: "Ada <ada@x> (via owner@y)" is Ada.
function senderOf(from) {
  const text = String(from || "").replace(/"[^"]*"/g, ""), angle = /<([^>]*)>/.exec(text);
  return cleanEmail(angle ? angle[1] : addressesIn(text)[0]);
}

// A Script Property that must be a count of days: "1.5", "1e1", "-3" or "0x10" mean the default.
function wholeDays(value, fallback) {
  const text = String(value == null ? "" : value).trim();
  return /^\d+$/.test(text) && Number(text) > 0 ? Number(text) : fallback;
}

function ownerAddresses(user, aliases, extra) {
  const owners = {};
  [user].concat(aliases || [], String(extra || "").split(",")).forEach(function (value) { const email = cleanEmail(value); if (email) owners[email] = true; });
  return owners;
}

function direction(from, owners) {
  return owners[senderOf(from)] ? "sent" : "received";
}

function buildQuery(emails, afterMs, beforeMs) {
  const terms = emails.map(function (email) { return ["from", "to", "cc", "bcc"].map(function (op) { return op + ":" + email; }).join(" OR "); });
  return "(" + terms.join(" OR ") + ") after:" + Math.floor(afterMs / 1000) + (beforeMs ? " before:" + Math.ceil(beforeMs / 1000) : "") + " -in:chats";
}

// Email -> person ids, from Remold's People records. People without a usable email are left out.
function peopleByEmail(records) {
  const people = {};
  records.forEach(function (record) {
    const email = cleanEmail(record.values && record.values.email);
    if (!email) return;
    people[email] = people[email] || [];
    if (people[email].indexOf(record.id) < 0) people[email].push(record.id);
  });
  return people;
}

// Who a message was contact with: for mail the owner sent, the people it went to;
// for mail the owner received, only the person who sent it.
function contactsOf(message, people, owners) {
  const addresses = direction(message.from, owners) === "sent" ? addressesIn([message.to, message.cc, message.bcc].join(",")) : [senderOf(message.from)];
  const ids = [];
  addresses.forEach(function (address) { if (!owners[address]) (people[address] || []).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); }); });
  return ids;
}

function activityFor(message, personId, owners) {
  const sent = direction(message.from, owners) === "sent";
  return { action: "create", object: "activity", values: { title: sent ? "Email sent" : "Email received", type: "email", when: new Date(message.at).toISOString(), about: personId, source: "gmail:" + message.id }, reason: "Gmail sync" };
}

// Oldest first, so a run cut short has posted a prefix and the watermark can stop where it did.
// One message can be contact with several people; each gets its own Activity and key.
function planPosts(messages, people, owners) {
  const posts = [];
  messages.slice().sort(function (a, b) { return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }).forEach(function (message) {
    contactsOf(message, people, owners).forEach(function (personId) {
      posts.push({ messageId: message.id, at: message.at, key: "gmail:" + message.id + ":" + personId, body: activityFor(message, personId, owners) });
    });
  });
  return posts;
}

// Activities Remold already holds from Gmail, keyed like the posts: "gmail:<message id>:<person id>".
// Idempotency-Keys last 24 hours, so reruns over older mail rely on this instead.
function loggedKeys(records) {
  const keys = {};
  records.forEach(function (record) {
    const values = record.values || {}, about = values.about && values.about.id;
    if (/^gmail:/.test(values.source || "") && about) keys[values.source + ":" + about] = true;
  });
  return keys;
}

// Reruns overlap the last watermark a little, for mail Gmail indexed late; loggedKeys makes the overlap free.
// Nothing older than the lookback is read, even after a long pause.
function startFrom(watermark, now, lookbackDays, overlapMs) {
  const mark = Number(watermark), floor = now - lookbackDays * 86400000;
  return watermark && Number.isFinite(mark) ? Math.max(floor, mark - overlapMs) : floor;
}
