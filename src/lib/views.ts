import type { Doc } from "../../convex/_generated/dataModel";

// The list URL for a saved view: its id, plus the layout and calendar date the Board and Calendar read from the URL.
export const viewSearch = (view: Pick<Doc<"views">, "_id" | "layout" | "dateFieldId">) =>
  new URLSearchParams({ v: view._id, ...(view.layout !== "table" ? { view: view.layout } : {}), ...(view.layout === "calendar" && view.dateFieldId ? { date: view.dateFieldId } : {}) }).toString();
