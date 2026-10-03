// The one MCP tool registry. The stdio server (index.ts) and the hosted /mcp endpoint (convex/mcp.ts) both serve it,
// so names, descriptions, schemas, argument checks and errors cannot drift. No imports: it runs in Node and in Convex.
// Each tool maps its arguments to a REST /api/v1 request; stdio sends it over HTTP, the hosted endpoint runs it in-process.

export const serverInfo = { name: "remold", version: "0.0.0" };
export const capabilities = { tools: {} };
export const instructions = `Remold is the team's CRM, and it is meant to be reshaped to fit how the team works. Records are named by a three-word code like brisk-ember-oyster; use codes or ids when you refer to one. Start with remold_map: it shows the whole workspace, your access and what you can do here in one call. Then call remold_inbox: pending items are work left for you. Then remold_today: mine is your ready queue. Prefer remold_propose_change; a person applies it. remold_apply_change only works for actions the team granted you. When the work needs a field, object or select option that does not exist, check remold_objects, then propose it with remold_propose_shape and say why. Propose retiring, archiving or reordering what no longer fits the same way. Once remold_shape_proposals shows it applied, use it. Saved views are the lists the team works from: read them with remold_views and remold_view_records, and propose new ones with remold_propose_shape kind addView. remold_me lists the objects you can read. If the work needs an object you cannot see, ask a person in the inbox to give you access (remold_inbox_add). Email campaigns: create a campaign record (channel email), link people in its people field (CSV import adds many), then draft email records (subject, body, campaign, status draft; merge tags {{firstName|there}}, {{name}}, {{company}}) and follow-ups (followsUp the earlier email, waitDays, sendTo notOpened, notClicked or notReplied). Check them with remold_email_preview. You cannot approve an email or start a campaign: ask a person to approve each email on the campaign page and press Start campaign. You may stop an email. Later, read remold_campaign_report, use remold_mark_replied for replies you learn of elsewhere, and draft follow-ups for people who did not reply. Automations make something happen every time without you: draft an automation record (status draft) with name, when (recordCreated, fieldChanged, dateReached or schedule), object (an object key), field and equals (e.g. stage, won), offsetDays (dateReached: -1 is the day before), schedule ("daily 09:00" or "weekly mon 09:00", UTC) and actions, a JSON array of up to 10: {"type":"createRecord","object":"project","values":{...}}, {"type":"updateTrigger","values":{...}}, {"type":"createTask","title":"...","dueInDays":1,"about":"trigger"}, {"type":"inbox","text":"..."}, {"type":"linkTrigger","field":"..."}. Values may use {{record.name}}, {{record.id}}, {{record.closeDate-1}}, {{today+3}} and {{created.project}} (a record made by an earlier action). Automations cannot delete, send, publish or change email, post, campaign or booking status. Check one with remold_automation_test on a real record: a draft renders as you, an automation that is on renders as the person who turned it on (renderedAs says which). Then ask a person to turn it on: you cannot, though you may pause one. It runs as that person, so they must be able to see every record of the object it watches and the field it watches. Read remold_automation_runs to see what it did.`;

// JSON Schema builders. In obj(), a key ending in "?" is optional.
type Schema = { [key: string]: unknown };
const described = (schema: Schema, description?: string): Schema => description ? { description, ...schema } : schema;
const str = (description?: string) => described({ type: "string" }, description);
const bool = (description?: string) => described({ type: "boolean" }, description);
const int = () => ({ type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const oneOf = (...values: string[]) => ({ type: "string", enum: values });
const arr = (items: Schema, extra: { maxItems?: number; description?: string } = {}) => described({ ...(extra.maxItems === undefined ? {} : { maxItems: extra.maxItems }), type: "array", items }, extra.description);
const anyValue = {};
const record = { type: "object", propertyNames: { type: "string" }, additionalProperties: anyValue };
function obj(shape: Record<string, Schema>, description?: string): Schema {
  const entries = Object.entries(shape).map(([key, schema]) => [key.replace(/\?$/, ""), schema, !key.endsWith("?")] as const);
  const required = entries.filter(([, , needed]) => needed).map(([key]) => key);
  return described({ type: "object", properties: Object.fromEntries(entries.map(([key, schema]) => [key, schema])), ...(required.length ? { required } : {}) }, description);
}

type Args = Record<string, any>;
export type Rest = { method: "GET" | "POST"; path: string; body?: Args; idempotencyKey?: string };
type Tool = { name: string; description: string; inputSchema: Schema; route: (args: Args) => Rest };

// filter (the original single form), filters and range become REST's filter[field]=value and range[field]=from..to.
function params(args: Args) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (key === "sort") { query.set("sort", value.field); query.set("direction", value.direction); }
    else if (key === "filter") query.append(`filter[${value.field}]`, String(value.value));
    else if (key === "filters") for (const filter of value) query.append(`filter[${filter.field}]`, String(filter.value));
    else if (key === "range") query.set(`range[${value.field}]`, `${value.from ?? ""}..${value.to ?? ""}`);
    else query.set(key, String(value));
  }
  return query.toString();
}
const get = (path: string, query: Args = {}): Rest => { const q = params(query); return { method: "GET", path: q ? `${path}?${q}` : path }; };
const post = (path: string, body: Args = {}): Rest => ({ method: "POST", path, body });
const id = encodeURIComponent;

const writeKey = { "idempotencyKey?": str("Stable operation key; reuse on retries") };
const changeShape = { ...writeKey, action: oneOf("create", "update", "delete"), "object?": str(), "record?": str(), "values?": record, reason: str() };
const fieldType = oneOf("text", "number", "select", "date", "boolean", "lookup", "links");
const fieldParts = { "options?": arr(obj({ id: str(), label: str(), "color?": str() }), { description: "select only" }), "target?": str("object key a lookup or links field points to"), "withTime?": bool("date only"), "required?": bool(), "indexed?": bool("false for a text field nobody sorts or filters by, such as notes; saves an index slot") };
const sort = obj({ field: str(), direction: oneOf("asc", "desc") });
const fieldValue = obj({ field: str(), value: str() });

export const tools: Tool[] = [
  { name: "remold_map", description: "Start here. One call returns the workspace: objects with fields, types, options and write modes, record counts as 0, 1-50, 50+ or unknown, standard features present, your own grants, pending counts, and what you can do here.", inputSchema: obj({}), route: () => get("/map") },
  { name: "remold_me", description: "Show the CRM organisation, this agent's grants, the objects it can read, and pending work counts.", inputSchema: obj({}), route: () => get("/me") },
  { name: "remold_objects", description: "List CRM objects in navigation order with their readable fields in order and each field's write modes, retired fields, title field, and slotsLeft: how many more indexed (searchable and sortable) fields of each kind the object can take. Select and lookup fields use text slots. Archived objects are left out unless includeArchived.", inputSchema: obj({ "includeArchived?": bool() }), route: (a) => get(a.includeArchived ? "/objects?include=archived" : "/objects") },
  { name: "remold_list_records", description: "List records for one object. Narrow with filters (all must match, e.g. people where company is Atlas) and one date or number range. Sort, filter and range fields must be indexed.", inputSchema: obj({ object: str(), "cursor?": str(), "limit?": int(), "sort?": sort, "filter?": described(fieldValue, "one filter; same as a single entry in filters"), "filters?": arr(fieldValue), "range?": obj({ field: str(), "from?": str(), "to?": str() }, "from and to are YYYY-MM-DD or ISO times; either may be left out") }), route: (a) => get("/records", a) },
  { name: "remold_get_record", description: "Get one record and its recent audit events by record id or three-word code.", inputSchema: obj({ idOrRef: str() }), route: (a) => get(`/records/${id(a.idOrRef)}`) },
  { name: "remold_record_events", description: "Read record audit events, following nextCursor for more pages.", inputSchema: obj({ idOrRef: str(), "cursor?": str(), "limit?": int() }), route: ({ idOrRef, ...q }) => get(`/records/${id(idOrRef)}/events`, q) },
  { name: "remold_search", description: "Search record titles, optionally within one object.", inputSchema: obj({ q: str(), "object?": str(), "limit?": int() }), route: (a) => get("/search", a) },
  { name: "remold_related", description: "Find records related to a record through objectKey.fieldKey.", inputSchema: obj({ idOrRef: str(), field: str() }), route: (a) => get(`/records/${id(a.idOrRef)}/related`, { field: a.field }) },
  { name: "remold_today", description: "Your daily queue. mine: your ready tasks (not blocked), due and overdue first, then undated. waiting: your tasks that are blocked, with the open tasks they wait on. Also tasks due this week, quiet opportunities, and today's date in the workspace's time zone. Start your work here.", inputSchema: obj({}), route: () => get("/today") },
  { name: "remold_my_tasks", description: "List your own ready tasks (assigned to you, not done, nothing open blocking them), due and overdue first, then undated, a page at a time. Follow cursor for more. Take a task by setting its assignee to you; hand it to a person by setting assignee to their name.", inputSchema: obj({ "cursor?": str(), "limit?": int() }), route: (a) => get("/my-tasks", a) },
  { name: "remold_propose_change", description: "Propose a CRM change for a person to review and apply.", inputSchema: obj({ ...changeShape, "inboxId?": str() }), route: (a) => post("/suggestions", a) },
  { name: "remold_apply_change", description: "Apply a granted CRM change immediately. Use a proposal when no grant exists.", inputSchema: obj(changeShape), route: (a) => post("/changes", a) },
  { name: "remold_list_suggestions", description: "List agent suggestions in this organisation.", inputSchema: obj({ "status?": oneOf("pending", "applied", "dismissed", "conflicted") }), route: (a) => get("/suggestions", a) },
  { name: "remold_propose_shape", description: "Propose a change to the CRM's shape for an admin to apply. addObject: key, label, labelPlural and up to 12 fields. addField: object plus the field's key, label, type. addOptions: object, field and the full option list (existing options unchanged, new ones added). relabel: object, optional field, label, and labelPlural for an object. retireField and restoreField: object and field (values are kept; standard fields features rely on cannot be retired). reorderFields: object and order, every live field key. reorderObjects: order, every object key not archived. reorderOptions: object, field and order, every option id. archiveObject and unarchiveObject: a custom object (hidden from navigation, search and remold_objects; records and links are kept). setTitleField: object and a text field. Nothing is ever deleted. addView: a shared saved view on object: name, layout (table, board with groupBy a select field, calendar with dateField), columns, up to 3 filters, one range (from/to YYYY-MM-DD or relative), sort, pinned to show it in the menu. Fields by key. Needs an admin agent.", inputSchema: obj({ ...writeKey, kind: oneOf("addObject", "addField", "addOptions", "relabel", "addView", "retireField", "restoreField", "reorderFields", "reorderObjects", "reorderOptions", "archiveObject", "unarchiveObject", "setTitleField"), reason: str(), "object?": str(), "field?": str(), "key?": str(), "label?": str(), "labelPlural?": str(), "icon?": str(), "type?": fieldType, ...fieldParts, "order?": arr(str(), { description: "keys or option ids in the new order" }), "name?": str("addView"), "layout?": oneOf("table", "board", "calendar"), "columns?": arr(str()), "filters?": arr(obj({ field: str(), value: anyValue }), { maxItems: 3 }), "range?": obj({ field: str(), "from?": str(), "to?": str(), "relative?": oneOf("today", "next7", "thisMonth", "overdue") }, "dates are calendar days in the reader's time zone"), "sort?": sort, "groupBy?": str(), "dateField?": str(), "pinned?": bool(), "fields?": arr(obj({ key: str("camelCase, starting with a lowercase letter"), label: str(), type: fieldType, ...fieldParts }), { maxItems: 12 }) }), route: (a) => post("/shape/proposals", a) },
  { name: "remold_shape_proposals", description: "List this agent's own shape proposals and what became of them. Applied ones name the object and fields created; failed ones say why.", inputSchema: obj({ "status?": oneOf("pending", "applied", "dismissed", "failed") }), route: (a) => get("/shape/proposals", a) },
  { name: "remold_views", description: "List the workspace's shared saved views, optionally for one object: layout, columns, filters, range and sort by field key. usable is false when a view uses a field this agent cannot read.", inputSchema: obj({ "object?": str() }), route: (a) => get("/views", a) },
  { name: "remold_view_records", description: "Run a saved view with this agent's own access and get one page of its records, with the view's columns. Relative ranges such as today are read in tz (an IANA zone, default UTC).", inputSchema: obj({ id: str(), "tz?": str(), "cursor?": str(), "limit?": int() }), route: ({ id: view, ...q }) => get(`/views/${id(view)}/records`, q) },
  { name: "remold_inbox", description: "List shared inbox work. Start here before other CRM work.", inputSchema: obj({ "status?": oneOf("pending", "resolved") }), route: (a) => get("/inbox", a) },
  { name: "remold_inbox_add", description: "Add a workspace note visible to its author and unrestricted workspace members.", inputSchema: obj({ ...writeKey, text: str(), "source?": str() }), route: (a) => post("/inbox", a) },
  { name: "remold_inbox_resolve", description: "Resolve a shared inbox item, optionally linking its suggestion or record.", inputSchema: obj({ ...writeKey, id: str(), "note?": str(), "suggestionId?": str(), "recordId?": str() }), route: ({ id: item, ...body }) => post(`/inbox/${id(item)}/resolve`, body) },
  { name: "remold_campaign_report", description: "Show a campaign's emails with status, what blocks sending, counts and rates, and each recipient's status, opens, clicks and replies.", inputSchema: obj({ idOrRef: str() }), route: (a) => get(`/campaigns/${id(a.idOrRef)}/report`) },
  { name: "remold_email_preview", description: "Render an email record for one person (or the first recipient), and list who would get it now and who is left out and why.", inputSchema: obj({ idOrRef: str(), "person?": str() }), route: (a) => get(`/emails/${id(a.idOrRef)}/preview`, { person: a.person }) },
  { name: "remold_automation_runs", description: "Show an automation in one sentence and its recent runs: status, error, the record that set it off, who it ran as, and what it created.", inputSchema: obj({ idOrRef: str() }), route: (a) => get(`/automations/${id(a.idOrRef)}/runs`) },
  { name: "remold_automation_test", description: "Dry run: show what an automation's actions would write for one record (id or code), and any problems, without writing anything. Renders as the person who turned it on when it is on, otherwise as you; renderedAs says which. Scheduled automations need no record.", inputSchema: obj({ idOrRef: str(), "record?": str() }), route: (a) => post(`/automations/${id(a.idOrRef)}/test`, a.record === undefined ? {} : { record: a.record }) },
  { name: "remold_mark_replied", description: "Mark a campaign send as replied, by its sendId from the campaign report. Replied people get no more follow-ups.", inputSchema: obj({ ...writeKey, sendId: str() }), route: (a) => post(`/sends/${id(a.sendId)}/replied`) },
];
for (const tool of tools) tool.inputSchema.$schema = "http://json-schema.org/draft-07/schema#";
export const toolList = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
const byName = new Map(tools.map((tool) => [tool.name, tool]));

// Checks arguments against the tool's schema before anything runs. Unknown keys are dropped, as zod did before.
// Returns the cleaned value, or what is wrong.
export function conform(schema: Schema, value: unknown, at = ""): { value: unknown } | string {
  const where = at || "arguments", list = schema.enum as unknown[] | undefined;
  if (list && !list.includes(value)) return `${where} must be one of ${list.join(", ")}`;
  if (schema.type === "string") return typeof value === "string" ? { value } : `${where} must be a string`;
  if (schema.type === "boolean") return typeof value === "boolean" ? { value } : `${where} must be true or false`;
  if (schema.type === "integer") return Number.isSafeInteger(value) ? { value } : `${where} must be a whole number`;
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${where} must be a list`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${where} takes at most ${schema.maxItems}`;
    const items = [];
    for (const [index, item] of value.entries()) { const checked = conform(schema.items as Schema, item, `${where}[${index}]`); if (typeof checked === "string") return checked; items.push(checked.value); }
    return { value: items };
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return `${where} must be an object`;
    const given = value as Args, properties = (schema.properties ?? {}) as Record<string, Schema>, extra = schema.additionalProperties as Schema | undefined, out: [string, unknown][] = [];
    for (const key of (schema.required ?? []) as string[]) if (given[key] === undefined || !Object.hasOwn(given, key)) return `${at ? `${at}.` : ""}${key} is required`;
    for (const [key, item] of Object.entries(given)) {
      const inner = Object.hasOwn(properties, key) ? properties[key] : extra;
      if (!inner || item === undefined) continue;
      const checked = conform(inner, item, at ? `${at}.${key}` : key);
      if (typeof checked === "string") return checked;
      out.push([key, checked.value]);
    }
    return { value: Object.fromEntries(out) };
  }
  return { value };
}

export type Send = (request: Rest) => Promise<{ status: number; json: any }>;
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };
const failed = (code: string, message: string): ToolResult => ({ isError: true, content: [{ type: "text", text: `${code}: ${message}` }] });

// Undefined means no such tool, which callers report as a JSON-RPC error. Everything else is a tool result.
export async function callTool(name: string, args: unknown, send: Send): Promise<ToolResult | undefined> {
  const tool = byName.get(name);
  if (!tool) return undefined;
  const checked = conform(tool.inputSchema, args ?? {});
  if (typeof checked === "string") return failed("VALIDATION", `Invalid arguments for ${name}: ${checked}`);
  const { idempotencyKey, ...rest } = checked.value as Args;
  try {
    const { status, json } = await send({ ...tool.route(rest), ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}) });
    if (status >= 400) return failed(json?.error?.code ?? "INTERNAL", json?.error?.message ?? "Remold request failed");
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  } catch { return failed("INTERNAL", "Something went wrong"); }
}
