import { convexTest } from "convex-test";
import schema from "./schema";
import rateLimiter from "@convex-dev/rate-limiter/test";

const modules = import.meta.glob("./**/*.ts");
export const makeTest = () => {
  const t = convexTest({ schema, modules });
  rateLimiter.register(t);
  return t;
};
