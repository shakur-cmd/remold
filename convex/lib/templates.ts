import type { Blueprint } from "./metadata";
import service from "./blueprints/service.json";
import agency from "./blueprints/agency.json";
import creator from "./blueprints/creator.json";
import retail from "./blueprints/retail.json";

// The starter blueprints a person can pick in Settings and an agent can adapt before proposing.
// JSON imports widen literals like "asc", hence the cast; convex/blueprints.test.ts applies each one.
export const templates = ([["service", service], ["agency", agency], ["creator", creator], ["retail", retail]] as const).map(([id, blueprint]) => ({ id, blueprint: blueprint as Blueprint }));
