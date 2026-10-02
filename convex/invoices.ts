import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { v } from "convex/values";
import { requireMember, type Principal } from "./identity";
import { fail } from "./errors";
import { listedRelated } from "./lib/list";
import { canQueryField, canReadField, canReadObject, canReadRecord, listedRecords, pageList, paginateIndex, projectRecord } from "./authority/reads";

const SHOWN = 500;
type PageOpts = { cursor: string | null; numItems: number; endCursor?: string | null };
const done = { page: [], isDone: true, continueCursor: "" };
const slotName = (field: Doc<"fields">) => `${field.slot!.kind}${field.slot!.index}`;

async function invoices(ctx: QueryCtx, principal: Principal) {
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", principal.org._id).eq("key", "invoice")).unique();
  if (!object || !canReadObject(principal, object)) return null;
  const byKey = new Map((await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", principal.org._id).eq("objectId", object._id)).collect()).filter((f) => !f.retired).map((f) => [f.key, f]));
  return { object, byKey };
}

// One page of a company's invoices as the caller may see them, newest first.
async function companyPage(ctx: QueryCtx, orgId: Id<"orgs">, recordId: Id<"records">, opts: PageOpts) {
  const principal = await requireMember(ctx, orgId), target = await ctx.db.get(recordId);
  const targetObject = target && target.orgId === orgId ? await ctx.db.get(target.objectId) : null;
  if (!target || !targetObject || !canReadRecord(principal, targetObject, target)) fail("NOT_FOUND", "Record not found");
  const invoice = await invoices(ctx, principal), company = invoice?.byKey.get("company");
  if (!invoice || !company?.slot || company.targetObjectId !== target.objectId || !canQueryField(principal, invoice.object, company)) return null;
  const listed = await listedRelated(ctx, principal, invoice.object, company, target._id), name = slotName(company);
  const page = listed ? pageList(listed.reverse(), opts) : await paginateIndex((ctx.db.query("records") as any).withIndex(`by_${name}`, (q: any) => q.eq("orgId", orgId).eq("objectId", invoice.object._id).eq(name, target._id)).order("desc"), opts);
  const rows = (await Promise.all((page.page as Doc<"records">[]).map((r) => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null);
  // splitCursor and pageStatus tell usePaginatedQuery to split a page that grew; dropping them would let a short sum pass as whole.
  const { splitCursor, pageStatus } = page as Partial<PaginationResult<unknown>>;
  return { principal, ...invoice, rows, paging: { isDone: page.isDone, continueCursor: page.continueCursor, ...(splitCursor !== undefined ? { splitCursor } : {}), ...(pageStatus !== undefined ? { pageStatus } : {}) } };
}

// The newest SHOWN invoices a company page lists; totals come from `totals`.
export const forCompany = query({ args: { orgId: v.id("orgs"), recordId: v.id("records") }, handler: async (ctx, args) => {
  const page = await companyPage(ctx, args.orgId, args.recordId, { cursor: null, numItems: SHOWN });
  if (!page) return null;
  const id = (key: string) => page.byKey.get(key)?._id ?? null, paidOn = page.byKey.get("paidOn");
  // A hidden paid date is projected away like an empty one, so say which rows hide it.
  const paymentHidden = paidOn ? page.rows.filter((r) => !canReadField(page.principal, page.object, paidOn, r._id)).map((r) => r._id) : [];
  return { objectKey: page.object.key, fields: { amount: id("amount"), due: id("due"), paidOn: id("paidOn"), monthly: id("monthly") }, invoices: page.rows, paymentHidden, capped: !page.paging.isDone };
} });

// Billed and paid (paid on set) per page of a company's invoices; the caller adds
// pages up until isDone, so no display limit truncates a balance. `known` is false
// when the caller cannot read the amount or paid on of an invoice in the page, so
// a hidden value never makes a balance look smaller than it is.
export const totals = query({ args: { orgId: v.id("orgs"), recordId: v.id("records"), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => {
  const page = await companyPage(ctx, args.orgId, args.recordId, args.paginationOpts);
  if (!page) return done;
  const amount = page.byKey.get("amount"), paidOn = page.byKey.get("paidOn");
  const known = !!amount && !!paidOn && page.rows.every((r) => canReadField(page.principal, page.object, amount, r._id) && canReadField(page.principal, page.object, paidOn, r._id));
  const sum = (rows: Doc<"records">[]) => rows.reduce((total, r) => total + (typeof r.values[amount!._id] === "number" ? r.values[amount!._id] as number : 0), 0);
  const summary = known ? { count: page.rows.length, known, billed: sum(page.rows), paid: sum(page.rows.filter((r) => r.values[paidOn!._id] != null)) } : { count: page.rows.length, known, billed: 0, paid: 0 };
  return { ...page.paging, page: [summary] };
} });

// Unpaid invoices due before `today`, earliest due first, one index page at a
// time. A page can hold only paid history and come back empty; the caller keeps
// going until isDone, so old paid invoices never hide one still owed.
export const pastDue = query({ args: { orgId: v.id("orgs"), today: v.number(), paginationOpts: paginationOptsValidator }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId), invoice = await invoices(ctx, principal);
  const due = invoice?.byKey.get("due"), paidOn = invoice?.byKey.get("paidOn");
  if (!invoice || !due?.slot || !paidOn || !canReadField(principal, invoice.object, due) || !canReadField(principal, invoice.object, paidOn)) return done;
  const object = invoice.object, at = (row: Doc<"records">) => (row as Record<string, unknown>)[slotName(due)];
  const owed = (row: Doc<"records">) => row.values[paidOn._id] == null && canReadRecord(principal, object, row);
  const listed = await listedRecords(ctx, principal, object);
  if (listed) {
    const rows = listed.filter((row) => canReadField(principal, object, due, row._id) && canReadField(principal, object, paidOn, row._id) && typeof at(row) === "number" && (at(row) as number) > 0 && (at(row) as number) < args.today && owed(row)).sort((a, b) => (at(a) as number) - (at(b) as number) || a._creationTime - b._creationTime);
    const page = pageList(rows, args.paginationOpts);
    return { ...page, page: (await Promise.all(page.page.map((r) => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null) };
  }
  if (!canQueryField(principal, object, due) || !canQueryField(principal, object, paidOn)) return done;
  const page = await paginateIndex((ctx.db.query("records") as any).withIndex(`by_${slotName(due)}`, (q: any) => q.eq("orgId", args.orgId).eq("objectId", object._id).gt(slotName(due), 0).lt(slotName(due), args.today)), args.paginationOpts);
  return { ...page, page: (await Promise.all((page.page as Doc<"records">[]).filter(owed).map((r) => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null) };
} });
