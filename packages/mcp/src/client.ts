export class RemoldError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "RemoldError"; }
}

type Fetch = typeof fetch;
export class RemoldClient {
  constructor(private readonly options: { url: string; key: string; fetch?: Fetch }) {}
  private async request(method: "GET" | "POST", path: string, body?: unknown) {
    const { idempotencyKey, ...payload } = (body ?? {}) as Record<string, unknown>;
    const response = await (this.options.fetch ?? fetch)(`${this.options.url.replace(/\/$/, "")}/api/v1${path}`, { method, headers: { authorization: `Bearer ${this.options.key}`, ...(typeof idempotencyKey === "string" ? { "Idempotency-Key": idempotencyKey } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(payload) }) });
    const json = await response.json();
    if (!response.ok) throw new RemoldError(json.error?.message ?? "Remold request failed", json.error?.code ?? "INTERNAL");
    return json;
  }
  me() { return this.request("GET", "/me"); }
  map() { return this.request("GET", "/map"); }
  objects(args: { includeArchived?: boolean } = {}) { return this.request("GET", args.includeArchived ? "/objects?include=archived" : "/objects"); }
  listRecords(args: Record<string, unknown>) { return this.request("GET", `/records?${params(args)}`); }
  getRecord(idOrRef: string) { return this.request("GET", `/records/${encodeURIComponent(idOrRef)}`); }
  recordEvents(args: { idOrRef: string; cursor?: string; limit?: number }) { const { idOrRef, ...query } = args; return this.request("GET", `/records/${encodeURIComponent(idOrRef)}/events?${params(query)}`); }
  search(args: Record<string, unknown>) { return this.request("GET", `/search?${params(args)}`); }
  related(args: { idOrRef: string; field: string }) { return this.request("GET", `/records/${encodeURIComponent(args.idOrRef)}/related?${params({ field: args.field })}`); }
  today() { return this.request("GET", "/today"); }
  propose(args: Record<string, unknown>) { return this.request("POST", "/suggestions", args); }
  change(args: Record<string, unknown>) { return this.request("POST", "/changes", args); }
  listSuggestions(args: Record<string, unknown> = {}) { return this.request("GET", `/suggestions?${params(args)}`); }
  inbox(args: Record<string, unknown> = {}) { return this.request("GET", `/inbox?${params(args)}`); }
  inboxAdd(args: Record<string, unknown>) { return this.request("POST", "/inbox", args); }
  proposeShape(args: Record<string, unknown>) { return this.request("POST", "/shape/proposals", args); }
  shapeProposals(args: Record<string, unknown> = {}) { return this.request("GET", `/shape/proposals?${params(args)}`); }
  views(args: { object?: string } = {}) { const query = params(args); return this.request("GET", `/views${query ? `?${query}` : ""}`); }
  viewRecords(args: { id: string; tz?: string; cursor?: string; limit?: number }) { const { id, ...rest } = args; const query = params(rest); return this.request("GET", `/views/${encodeURIComponent(id)}/records${query ? `?${query}` : ""}`); }
  inboxResolve(args: { id: string; note?: string; suggestionId?: string; recordId?: string; idempotencyKey?: string }) { const { id, ...body } = args; return this.request("POST", `/inbox/${encodeURIComponent(id)}/resolve`, body); }
  campaignReport(idOrRef: string) { return this.request("GET", `/campaigns/${encodeURIComponent(idOrRef)}/report`); }
  emailPreview(args: { idOrRef: string; person?: string }) { const query = params({ person: args.person }); return this.request("GET", `/emails/${encodeURIComponent(args.idOrRef)}/preview${query ? `?${query}` : ""}`); }
  automationRuns(idOrRef: string) { return this.request("GET", `/automations/${encodeURIComponent(idOrRef)}/runs`); }
  automationTest(args: { idOrRef: string; record?: string }) { return this.request("POST", `/automations/${encodeURIComponent(args.idOrRef)}/test`, args.record === undefined ? {} : { record: args.record }); }
  markReplied(sendId: string, idempotencyKey?: string) { return this.request("POST", `/sends/${encodeURIComponent(sendId)}/replied`, { idempotencyKey }); }
}

// filter (the original single form), filters and range become REST's filter[field]=value and range[field]=from..to.
function params(args: Record<string, unknown>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (key === "sort" && typeof value === "object" && value) { const sort = value as Record<string, string>; query.set("sort", sort.field); query.set("direction", sort.direction); }
    else if (key === "filter" && typeof value === "object" && value) { const filter = value as { field: string; value: string }; query.append(`filter[${filter.field}]`, String(filter.value)); }
    else if (key === "filters" && Array.isArray(value)) for (const filter of value as { field: string; value: string }[]) query.append(`filter[${filter.field}]`, String(filter.value));
    else if (key === "range" && typeof value === "object" && value) { const range = value as { field: string; from?: string; to?: string }; query.set(`range[${range.field}]`, `${range.from ?? ""}..${range.to ?? ""}`); }
    else query.set(key, String(value));
  }
  return query.toString();
}
