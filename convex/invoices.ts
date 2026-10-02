import { query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireMember } from "./identity";
import { fail } from "./errors";
import { listedRelated } from "./lib/list";
import { canQueryField, canReadField, canReadObject, canReadRecord, projectRecord } from "./authority/reads";

const CAP = 500;

// A company's invoices with total billed, paid (paid on set) and open. Totals are
// null when the caller cannot read the amount or paid on of every invoice shown,
// so a hidden value never makes a balance look smaller than it is.
export const forCompany = query({ args: { orgId: v.id("orgs"), recordId: v.id("records") }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId), target = await ctx.db.get(args.recordId);
  const targetObject = target && target.orgId === args.orgId ? await ctx.db.get(target.objectId) : null;
  if (!target || !targetObject || !canReadRecord(principal, targetObject, target)) fail("NOT_FOUND", "Record not found");
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", args.orgId).eq("key", "invoice")).unique();
  if (!object || !canReadObject(principal, object)) return null;
  const byKey = new Map((await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", object._id)).collect()).filter((f) => !f.retired).map((f) => [f.key, f]));
  const company = byKey.get("company"), amount = byKey.get("amount"), paidOn = byKey.get("paidOn");
  if (!company?.slot || company.targetObjectId !== target.objectId || !canQueryField(principal, object, company)) return null;
  const name = `${company.slot.kind}${company.slot.index}`;
  const rows = await listedRelated(ctx, principal, object, company, target._id) ?? await (ctx.db.query("records") as any).withIndex(`by_${name}`, (q: any) => q.eq("orgId", args.orgId).eq("objectId", object._id).eq(name, target._id)).take(CAP + 1) as Doc<"records">[];
  const invoices = (await Promise.all(rows.slice(0, CAP).map((r) => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null);
  const known = !!amount && !!paidOn && invoices.every((r) => canReadField(principal, object, amount, r._id) && canReadField(principal, object, paidOn, r._id));
  const sum = (rows: Doc<"records">[]) => rows.reduce((total, r) => total + (typeof r.values[amount!._id] === "number" ? r.values[amount!._id] as number : 0), 0);
  const billed = known ? sum(invoices) : null, paid = known ? sum(invoices.filter((r) => r.values[paidOn!._id] != null)) : null;
  return { objectKey: object.key, fields: { amount: amount?._id ?? null, due: byKey.get("due")?._id ?? null, paidOn: paidOn?._id ?? null, monthly: byKey.get("monthly")?._id ?? null }, invoices, capped: rows.length > CAP, billed, paid, open: billed === null || paid === null ? null : billed - paid };
} });
