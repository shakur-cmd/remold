import { convexTest } from "convex-test";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
export const makeTest = () => convexTest({ schema, modules });
