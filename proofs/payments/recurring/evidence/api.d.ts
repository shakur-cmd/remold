/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as cadence from "../cadence.js";
import type * as contract from "../contract.js";
import type * as h0_schema from "../h0_schema.js";
import type * as harness from "../harness.js";
import type * as paymentFixture from "../paymentFixture.js";
import type * as payment_schema from "../payment_schema.js";
import type * as payments from "../payments.js";
import type * as recurring from "../recurring.js";
import type * as recurringFixture from "../recurringFixture.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  cadence: typeof cadence;
  contract: typeof contract;
  h0_schema: typeof h0_schema;
  harness: typeof harness;
  paymentFixture: typeof paymentFixture;
  payment_schema: typeof payment_schema;
  payments: typeof payments;
  recurring: typeof recurring;
  recurringFixture: typeof recurringFixture;
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
