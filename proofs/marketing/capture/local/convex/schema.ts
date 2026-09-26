import {defineSchema,defineTable} from 'convex/server';
import {v} from 'convex/values';
export const tenant=v.union(v.literal('a'),v.literal('b'));
export const item=v.object({tenant,formId:v.number(),submissionId:v.number(),contactId:v.union(v.number(),v.null()),dateSubmitted:v.string(),results:v.record(v.string(),v.union(v.string(),v.null())),sha256:v.string()});
export const observation=v.object({contactId:v.number(),status:v.union(v.literal('present'),v.literal('missing')),suppressed:v.boolean()});
const receipt=v.object({after:v.number(),fingerprint:v.string()});
const traversal=v.object({scan:v.string(),from:v.number(),upper:v.number(),next:v.number(),finished:v.boolean(),receipts:v.array(receipt),items:v.array(item)});
export default defineSchema({
 instances:defineTable({tenant,keyHash:v.string(),formId:v.number(),cursor:v.number(),pending:v.union(v.null(),traversal),last:v.union(v.null(),v.object({scan:v.string(),receipts:v.array(receipt),result:v.object({added:v.number(),suppressionChanges:v.number(),cursor:v.number()})}))}).index('by_tenant',['tenant']),
 captures:defineTable({instance:v.id('instances'),data:item}).index('by_instance_submission',['instance','data.submissionId']),
 suppression:defineTable({instance:v.id('instances'),data:observation}).index('by_instance_contact',['instance','data.contactId']),
 events:defineTable({instance:v.id('instances'),actor:v.string(),kind:v.union(v.literal('capture'),v.literal('suppression')),subject:v.number(),fingerprint:v.string()}).index('by_instance',['instance']),
});
