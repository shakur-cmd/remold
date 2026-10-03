// Shared by convex/imports.ts and ops/import/records.mjs, so it imports nothing
// and uses only erasable TypeScript that Node can run directly.
export type ImportRecord = { tmpId: string; object: string; values: Record<string, unknown> };

// Standard field keys per importable object: "" is a plain value, otherwise the
// object a lookup points at ("*" for any, "[]" for a list). A test keeps this equal to standard.ts.
export const importFields: Record<string, Record<string, string>> = {
  company: { name: "", domain: "", city: "", notes: "", street: "", state: "", postalCode: "", country: "" },
  person: { name: "", email: "", phone: "", title: "", company: "company", linkedin: "" },
  opportunity: { name: "", amount: "", stage: "", closeDate: "", company: "company", person: "person", campaign: "campaign" },
  project: { name: "", status: "", company: "company" },
  task: { title: "", dueDate: "", done: "", project: "project", blockedBy: "task[]", about: "*", assignee: "" },
  note: { body: "", about: "*" },
  activity: { title: "", type: "", when: "", about: "*", source: "" },
  campaign: { name: "", status: "", channel: "", startDate: "", goal: "", people: "person[]", companies: "company[]" },
  invoice: { number: "", company: "company", amount: "", sent: "", due: "", paidOn: "", monthly: "", document: "" },
};
const aliases: Record<string, Record<string, string>> = {
  company: { website: "domain" },
  opportunity: { value: "amount" },
  task: { due: "dueDate", due_date: "dueDate", completed: "done" },
  note: { text: "body", content: "body" },
};
const MAX = 500;

const secretWord = /password|passwd|secret|token|api[\s_-]?key/i;
const secretPrefix = /(?:^|[^A-Za-z0-9])(?:(?:sk|pk|re)_|sk-)[A-Za-z0-9]/;
// Any unbroken run of 40+ base64, base64url or hex characters, whatever its mix,
// unless the word holding it is clearly a path or URL: it starts with ~/, /Users/
// or http(s)://, or with a dotted lowercase host.
const encoded = /[A-Za-z0-9+/=_-]{40,}/;
const pathOrUrl = /^(?:~\/|\/Users\/|https?:\/\/|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/:?#]|$))/;
const longRun = (text: string) => text.split(/\s+/).some((word) => encoded.test(word) && !pathOrUrl.test(word.replace(/^[("'<[]+/, "")));
export function credentialReason(text: string): string | null {
  const word = secretWord.exec(text)?.[0];
  if (word) return `mentions "${word.toLowerCase()}"`;
  if (secretPrefix.test(text)) return "has a key prefix (sk_, pk_, re_, sk-)";
  if (longRun(text)) return "has a long key-like string";
  return null;
}

const own = <T>(map: Record<string, T>, key: string) => (Object.hasOwn(map, key) ? map[key] : undefined);
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : isPlain(value) ? Object.values(value).flatMap(strings) : [];

// Every problem in the file at once, so the drafter can fix them in one pass.
export function checkBatch(batch: unknown): { records: ImportRecord[]; problems: string[] } {
  const list = isPlain(batch) ? batch.records : undefined;
  if (!Array.isArray(list) || list.length === 0) return { records: [], problems: ['Expected {"records": [...]} with at least one record'] };
  if (list.length > MAX) return { records: [], problems: [`At most ${MAX} records per batch; split the file`] };
  const problems: string[] = [], records: ImportRecord[] = [], objectOf = new Map<string, string>();
  for (const [index, raw] of list.entries()) {
    const tmpId = isPlain(raw) && typeof raw.tmpId === "string" && raw.tmpId.trim() ? raw.tmpId : null;
    const label = tmpId ?? `record ${index + 1}`;
    if (!tmpId) { problems.push(`${label}: needs a tmpId`); continue; }
    if (objectOf.has(tmpId)) problems.push(`${label}: tmpId used twice`);
    const object = (raw as Record<string, unknown>).object, values = (raw as Record<string, unknown>).values;
    const fields = typeof object === "string" ? own(importFields, object) : undefined;
    if (!fields) { problems.push(`${label}: unknown object ${JSON.stringify(object)}; use one of ${Object.keys(importFields).join(", ")}`); continue; }
    if (!isPlain(values)) { problems.push(`${label}: values must be an object`); continue; }
    const normalized: Record<string, unknown> = {}, unknown: string[] = [];
    for (const [rawKey, value] of Object.entries(values)) {
      const key = own(own(aliases, object as string) ?? {}, rawKey) ?? rawKey;
      if (!Object.hasOwn(fields, key)) { unknown.push(rawKey); continue; }
      if (Object.hasOwn(normalized, key)) problems.push(`${label}.${key}: given twice (as ${rawKey} and an alias)`);
      normalized[key] = value;
      const target = fields[key]!;
      for (const ref of target ? strings(value).filter((text) => text.startsWith("@")) : []) {
        const referenced = objectOf.get(ref.slice(1));
        const wanted = target.replace("[]", "");
        if (!referenced) problems.push(`${label}.${key}: "${ref}" is not an earlier record in this file`);
        else if (wanted !== "*" && referenced !== wanted) problems.push(`${label}.${key}: ${ref} is a ${referenced}, not a ${wanted}`);
      }
      for (const text of strings(value)) { const reason = credentialReason(text); if (reason) problems.push(`${label}.${key}: looks like a credential (${reason}); remove it`); }
    }
    if (unknown.length) problems.push(`${label} (${object}): unknown keys ${unknown.map((key) => JSON.stringify(key)).join(", ")}; known keys: ${Object.keys(fields).join(", ")}`);
    objectOf.set(tmpId, object as string);
    records.push({ tmpId, object: object as string, values: normalized });
  }
  return { records, problems };
}

// FNV-1a 64-bit over the normalized records: the same file always gets the same key.
export function batchKey(records: ImportRecord[]) {
  let hash = 0xcbf29ce484222325n;
  for (const char of JSON.stringify(records)) hash = ((hash ^ BigInt(char.codePointAt(0)!)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return hash.toString(16).padStart(16, "0");
}
