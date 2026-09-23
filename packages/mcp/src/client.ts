export class RemoldError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "RemoldError"; }
}

type Fetch = typeof fetch;
export class RemoldClient {
  constructor(private readonly options: { url: string; key: string; fetch?: Fetch }) {}
  private async request(method: "GET" | "POST", path: string, body?: unknown) {
    const response = await (this.options.fetch ?? fetch)(`${this.options.url.replace(/\/$/, "")}/api/v1${path}`, { method, headers: { authorization: `Bearer ${this.options.key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json();
    if (!response.ok) throw new RemoldError(json.error?.message ?? "Remold request failed", json.error?.code ?? "INTERNAL");
    return json;
  }
  me() { return this.request("GET", "/me"); }
  objects() { return this.request("GET", "/objects"); }
  listRecords(args: Record<string, unknown>) { return this.request("GET", `/records?${params(args)}`); }
  getRecord(idOrRef: string) { return this.request("GET", `/records/${encodeURIComponent(idOrRef)}`); }
  search(args: Record<string, unknown>) { return this.request("GET", `/search?${params(args)}`); }
  related(args: { idOrRef: string; field: string }) { return this.request("GET", `/records/${encodeURIComponent(args.idOrRef)}/related?${params({ field: args.field })}`); }
  today() { return this.request("GET", "/today"); }
  propose(args: Record<string, unknown>) { return this.request("POST", "/suggestions", args); }
  change(args: Record<string, unknown>) { return this.request("POST", "/changes", args); }
  listSuggestions(args: Record<string, unknown> = {}) { return this.request("GET", `/suggestions?${params(args)}`); }
  inbox(args: Record<string, unknown> = {}) { return this.request("GET", `/inbox?${params(args)}`); }
  inboxAdd(args: Record<string, unknown>) { return this.request("POST", "/inbox", args); }
  inboxResolve(args: { id: string; note?: string; suggestionId?: string; recordId?: string }) { const { id, ...body } = args; return this.request("POST", `/inbox/${encodeURIComponent(id)}/resolve`, body); }
}

function params(args: Record<string, unknown>) { const query = new URLSearchParams(); for (const [key, value] of Object.entries(args)) if (value !== undefined) { if (key === "sort" && typeof value === "object" && value) { const sort = value as Record<string, string>; query.set("sort", sort.field); query.set("direction", sort.direction); } else if (key === "filter" && typeof value === "object" && value) { const filter = value as Record<string, string>; query.set("filter", filter.field); query.set("value", filter.value); } else query.set(key, String(value)); } return query.toString(); }
