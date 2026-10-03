/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentApi from "../agentApi.js";
import type * as agents from "../agents.js";
import type * as alerts from "../alerts.js";
import type * as authority_agentGuards from "../authority/agentGuards.js";
import type * as authority_grants from "../authority/grants.js";
import type * as authority_inbox from "../authority/inbox.js";
import type * as authority_migration from "../authority/migration.js";
import type * as authority_pending from "../authority/pending.js";
import type * as authority_policies from "../authority/policies.js";
import type * as authority_readonly from "../authority/readonly.js";
import type * as authority_reads from "../authority/reads.js";
import type * as automations from "../automations.js";
import type * as campaignSend from "../campaignSend.js";
import type * as campaigns from "../campaigns.js";
import type * as capture from "../capture.js";
import type * as crons from "../crons.js";
import type * as csv from "../csv.js";
import type * as errors from "../errors.js";
import type * as events from "../events.js";
import type * as fields from "../fields.js";
import type * as http from "../http.js";
import type * as identity from "../identity.js";
import type * as imports from "../imports.js";
import type * as inbox from "../inbox.js";
import type * as integrations_bindings from "../integrations/bindings.js";
import type * as integrations_budgets from "../integrations/budgets.js";
import type * as integrations_callbacks from "../integrations/callbacks.js";
import type * as integrations_commands from "../integrations/commands.js";
import type * as integrations_connections from "../integrations/connections.js";
import type * as integrations_core from "../integrations/core.js";
import type * as integrations_dispatch from "../integrations/dispatch.js";
import type * as integrations_http from "../integrations/http.js";
import type * as integrations_lifecycle from "../integrations/lifecycle.js";
import type * as integrations_lookups from "../integrations/lookups.js";
import type * as integrations_outcomes from "../integrations/outcomes.js";
import type * as integrations_receipts from "../integrations/receipts.js";
import type * as integrations_safety from "../integrations/safety.js";
import type * as integrations_safetyAdapters from "../integrations/safetyAdapters.js";
import type * as integrations_safetyFinality from "../integrations/safetyFinality.js";
import type * as integrations_tables from "../integrations/tables.js";
import type * as invites from "../invites.js";
import type * as invoices from "../invoices.js";
import type * as lib_applyChange from "../lib/applyChange.js";
import type * as lib_automation from "../lib/automation.js";
import type * as lib_assignee from "../lib/assignee.js";
import type * as lib_campaign from "../lib/campaign.js";
import type * as lib_campaignText from "../lib/campaignText.js";
import type * as lib_daily from "../lib/daily.js";
import type * as lib_days from "../lib/days.js";
import type * as lib_email from "../lib/email.js";
import type * as lib_emailRules from "../lib/emailRules.js";
import type * as lib_find from "../lib/find.js";
import type * as lib_idempotency from "../lib/idempotency.js";
import type * as lib_importCheck from "../lib/importCheck.js";
import type * as lib_intake from "../lib/intake.js";
import type * as lib_list from "../lib/list.js";
import type * as lib_metadata from "../lib/metadata.js";
import type * as lib_queue from "../lib/queue.js";
import type * as lib_ref from "../lib/ref.js";
import type * as lib_search from "../lib/search.js";
import type * as lib_shape from "../lib/shape.js";
import type * as lib_slots from "../lib/slots.js";
import type * as lib_standard from "../lib/standard.js";
import type * as lib_values from "../lib/values.js";
import type * as lib_viewSpec from "../lib/viewSpec.js";
import type * as lib_views from "../lib/views.js";
import type * as lib_zone from "../lib/zone.js";
import type * as objects from "../objects.js";
import type * as ops from "../ops.js";
import type * as orgs from "../orgs.js";
import type * as queue from "../queue.js";
import type * as rateLimit from "../rateLimit.js";
import type * as records from "../records.js";
import type * as reminders from "../reminders.js";
import type * as release from "../release.js";
import type * as seed from "../seed.js";
import type * as shapeSuggestions from "../shapeSuggestions.js";
import type * as suggestions from "../suggestions.js";
import type * as telemetry from "../telemetry.js";
import type * as telemetryHttp from "../telemetryHttp.js";
import type * as today from "../today.js";
import type * as users from "../users.js";
import type * as views from "../views.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentApi: typeof agentApi;
  agents: typeof agents;
  alerts: typeof alerts;
  "authority/agentGuards": typeof authority_agentGuards;
  "authority/grants": typeof authority_grants;
  "authority/inbox": typeof authority_inbox;
  "authority/migration": typeof authority_migration;
  "authority/pending": typeof authority_pending;
  "authority/policies": typeof authority_policies;
  "authority/readonly": typeof authority_readonly;
  "authority/reads": typeof authority_reads;
  automations: typeof automations;
  campaignSend: typeof campaignSend;
  campaigns: typeof campaigns;
  capture: typeof capture;
  crons: typeof crons;
  csv: typeof csv;
  errors: typeof errors;
  events: typeof events;
  fields: typeof fields;
  http: typeof http;
  identity: typeof identity;
  imports: typeof imports;
  inbox: typeof inbox;
  "integrations/bindings": typeof integrations_bindings;
  "integrations/budgets": typeof integrations_budgets;
  "integrations/callbacks": typeof integrations_callbacks;
  "integrations/commands": typeof integrations_commands;
  "integrations/connections": typeof integrations_connections;
  "integrations/core": typeof integrations_core;
  "integrations/dispatch": typeof integrations_dispatch;
  "integrations/http": typeof integrations_http;
  "integrations/lifecycle": typeof integrations_lifecycle;
  "integrations/lookups": typeof integrations_lookups;
  "integrations/outcomes": typeof integrations_outcomes;
  "integrations/receipts": typeof integrations_receipts;
  "integrations/safety": typeof integrations_safety;
  "integrations/safetyAdapters": typeof integrations_safetyAdapters;
  "integrations/safetyFinality": typeof integrations_safetyFinality;
  "integrations/tables": typeof integrations_tables;
  invites: typeof invites;
  invoices: typeof invoices;
  "lib/applyChange": typeof lib_applyChange;
  "lib/automation": typeof lib_automation;
  "lib/assignee": typeof lib_assignee;
  "lib/campaign": typeof lib_campaign;
  "lib/campaignText": typeof lib_campaignText;
  "lib/daily": typeof lib_daily;
  "lib/days": typeof lib_days;
  "lib/email": typeof lib_email;
  "lib/emailRules": typeof lib_emailRules;
  "lib/find": typeof lib_find;
  "lib/idempotency": typeof lib_idempotency;
  "lib/importCheck": typeof lib_importCheck;
  "lib/intake": typeof lib_intake;
  "lib/list": typeof lib_list;
  "lib/metadata": typeof lib_metadata;
  "lib/queue": typeof lib_queue;
  "lib/ref": typeof lib_ref;
  "lib/search": typeof lib_search;
  "lib/shape": typeof lib_shape;
  "lib/slots": typeof lib_slots;
  "lib/standard": typeof lib_standard;
  "lib/values": typeof lib_values;
  "lib/viewSpec": typeof lib_viewSpec;
  "lib/views": typeof lib_views;
  "lib/zone": typeof lib_zone;
  objects: typeof objects;
  ops: typeof ops;
  orgs: typeof orgs;
  queue: typeof queue;
  rateLimit: typeof rateLimit;
  records: typeof records;
  reminders: typeof reminders;
  release: typeof release;
  seed: typeof seed;
  shapeSuggestions: typeof shapeSuggestions;
  suggestions: typeof suggestions;
  telemetry: typeof telemetry;
  telemetryHttp: typeof telemetryHttp;
  today: typeof today;
  users: typeof users;
  views: typeof views;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
