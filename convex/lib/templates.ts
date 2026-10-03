import type { Blueprint } from "./metadata";
import service from "./blueprints/service.json";
import agency from "./blueprints/agency.json";
import creator from "./blueprints/creator.json";
import retail from "./blueprints/retail.json";

// The starter blueprints a person can pick in Settings and an agent can adapt before proposing.
export const templates: { id: string; blueprint: Blueprint }[] = [{ id: "service", blueprint: service }, { id: "agency", blueprint: agency }, { id: "creator", blueprint: creator }, { id: "retail", blueprint: retail }];
