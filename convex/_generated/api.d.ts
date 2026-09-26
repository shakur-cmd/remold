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
import type * as capture from "../capture.js";
import type * as crons from "../crons.js";
import type * as csv from "../csv.js";
import type * as errors from "../errors.js";
import type * as events from "../events.js";
import type * as fields from "../fields.js";
import type * as http from "../http.js";
import type * as identity from "../identity.js";
import type * as inbox from "../inbox.js";
import type * as invites from "../invites.js";
import type * as lib_applyChange from "../lib/applyChange.js";
import type * as lib_find from "../lib/find.js";
import type * as lib_list from "../lib/list.js";
import type * as lib_ref from "../lib/ref.js";
import type * as lib_slots from "../lib/slots.js";
import type * as lib_standard from "../lib/standard.js";
import type * as lib_values from "../lib/values.js";
import type * as objects from "../objects.js";
import type * as ops from "../ops.js";
import type * as orgs from "../orgs.js";
import type * as rateLimit from "../rateLimit.js";
import type * as records from "../records.js";
import type * as release from "../release.js";
import type * as seed from "../seed.js";
import type * as suggestions from "../suggestions.js";
import type * as telemetry from "../telemetry.js";
import type * as telemetryHttp from "../telemetryHttp.js";
import type * as today from "../today.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentApi: typeof agentApi;
  agents: typeof agents;
  alerts: typeof alerts;
  capture: typeof capture;
  crons: typeof crons;
  csv: typeof csv;
  errors: typeof errors;
  events: typeof events;
  fields: typeof fields;
  http: typeof http;
  identity: typeof identity;
  inbox: typeof inbox;
  invites: typeof invites;
  "lib/applyChange": typeof lib_applyChange;
  "lib/find": typeof lib_find;
  "lib/list": typeof lib_list;
  "lib/ref": typeof lib_ref;
  "lib/slots": typeof lib_slots;
  "lib/standard": typeof lib_standard;
  "lib/values": typeof lib_values;
  objects: typeof objects;
  ops: typeof ops;
  orgs: typeof orgs;
  rateLimit: typeof rateLimit;
  records: typeof records;
  release: typeof release;
  seed: typeof seed;
  suggestions: typeof suggestions;
  telemetry: typeof telemetry;
  telemetryHttp: typeof telemetryHttp;
  today: typeof today;
  users: typeof users;
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
