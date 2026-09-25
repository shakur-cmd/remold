#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RemoldClient, RemoldError } from "./client.js";

declare const process: { env: Record<string, string | undefined>; exit(code: number): never; };
const url = process.env.REMOLD_URL, key = process.env.REMOLD_KEY;
if (!url || !key) { console.error("REMOLD_URL and REMOLD_KEY are required"); process.exit(1); }
const client = new RemoldClient({ url, key });
const server = new McpServer({ name: "remold", version: "0.0.0" }, { instructions: "Remold is the team's CRM. Records are named by a three-word code like brisk-ember-oyster; use codes or ids when you refer to one. Start with remold_inbox: pending items are work left for you. Prefer remold_propose_change; a person applies it. remold_apply_change only works for actions the team granted you." });
const result = async (run: () => Promise<unknown>) => { try { return { content: [{ type: "text" as const, text: JSON.stringify(await run(), null, 2) }] }; } catch (error) { const item = error instanceof RemoldError ? error : new RemoldError("Something went wrong", "INTERNAL"); return { isError: true, content: [{ type: "text" as const, text: `${item.code}: ${item.message}` }] }; } };
server.registerTool("remold_me", { description: "Show the CRM organisation, this agent's grants, and pending work counts.", inputSchema: {} }, () => result(() => client.me()));
server.registerTool("remold_objects", { description: "List CRM objects and the writable fields on each object.", inputSchema: {} }, () => result(() => client.objects()));
server.registerTool("remold_list_records", { description: "List records for one object, optionally with indexed sort or filter.", inputSchema: { object: z.string(), cursor: z.string().optional(), limit: z.number().int().optional(), sort: z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) }).optional(), filter: z.object({ field: z.string(), value: z.string() }).optional() } }, (args) => result(() => client.listRecords(args)));
server.registerTool("remold_get_record", { description: "Get one record and its recent audit events by record id or three-word code.", inputSchema: { idOrRef: z.string() } }, (args) => result(() => client.getRecord(args.idOrRef)));
server.registerTool("remold_search", { description: "Search record titles, optionally within one object.", inputSchema: { q: z.string(), object: z.string().optional(), limit: z.number().int().optional() } }, (args) => result(() => client.search(args)));
server.registerTool("remold_related", { description: "Find records related to a record through objectKey.fieldKey.", inputSchema: { idOrRef: z.string(), field: z.string() } }, (args) => result(() => client.related(args)));
server.registerTool("remold_today", { description: "Show due tasks and quiet opportunities for today.", inputSchema: {} }, () => result(() => client.today()));
const changeShape = { action: z.enum(["create", "update", "delete"]), object: z.string().optional(), record: z.string().optional(), values: z.record(z.string(), z.unknown()).optional(), reason: z.string() };
server.registerTool("remold_propose_change", { description: "Propose a CRM change for a person to review and apply.", inputSchema: { ...changeShape, inboxId: z.string().optional() } }, (args) => result(() => client.propose(args)));
server.registerTool("remold_apply_change", { description: "Apply a granted CRM change immediately. Use a proposal when no grant exists.", inputSchema: changeShape }, (args) => result(() => client.change(args)));
server.registerTool("remold_list_suggestions", { description: "List agent suggestions in this organisation.", inputSchema: { status: z.enum(["pending", "applied", "dismissed", "conflicted"]).optional() } }, (args) => result(() => client.listSuggestions(args)));
server.registerTool("remold_inbox", { description: "List shared inbox work. Start here before other CRM work.", inputSchema: { status: z.enum(["pending", "resolved"]).optional() } }, (args) => result(() => client.inbox(args)));
server.registerTool("remold_inbox_add", { description: "Add a workspace note visible to its author and unrestricted workspace members.", inputSchema: { text: z.string(), source: z.string().optional() } }, (args) => result(() => client.inboxAdd(args)));
server.registerTool("remold_inbox_resolve", { description: "Resolve a shared inbox item, optionally linking its suggestion or record.", inputSchema: { id: z.string(), note: z.string().optional(), suggestionId: z.string().optional(), recordId: z.string().optional() } }, (args) => result(() => client.inboxResolve(args)));
await server.connect(new StdioServerTransport());
