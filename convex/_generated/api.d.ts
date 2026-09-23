/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as capture from "../capture.js";
import type * as csv from "../csv.js";
import type * as errors from "../errors.js";
import type * as events from "../events.js";
import type * as fields from "../fields.js";
import type * as identity from "../identity.js";
import type * as invites from "../invites.js";
import type * as lib_applyChange from "../lib/applyChange.js";
import type * as lib_find from "../lib/find.js";
import type * as lib_ref from "../lib/ref.js";
import type * as lib_slots from "../lib/slots.js";
import type * as lib_standard from "../lib/standard.js";
import type * as objects from "../objects.js";
import type * as orgs from "../orgs.js";
import type * as records from "../records.js";
import type * as seed from "../seed.js";
import type * as today from "../today.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  capture: typeof capture;
  csv: typeof csv;
  errors: typeof errors;
  events: typeof events;
  fields: typeof fields;
  identity: typeof identity;
  invites: typeof invites;
  "lib/applyChange": typeof lib_applyChange;
  "lib/find": typeof lib_find;
  "lib/ref": typeof lib_ref;
  "lib/slots": typeof lib_slots;
  "lib/standard": typeof lib_standard;
  objects: typeof objects;
  orgs: typeof orgs;
  records: typeof records;
  seed: typeof seed;
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

export declare const components: {};
