import { describe, expect, it } from "vitest";
import { pageView, pinPages, type PageSpec } from "./pages";

const result = (page: string[], continueCursor: string, isDone = false) => ({ page, continueCursor, isDone });

describe("pinned pages", () => {
  it("pins each loaded page to the end it first returned and keeps the pin on later results", () => {
    const pages: PageSpec[] = [{ cursor: null, numItems: 2 }];
    const pinned = pinPages(pages, [result(["b", "a"], "t:2")]);
    expect(pinned).toEqual([{ cursor: null, numItems: 2, endCursor: "t:2" }]);
    // A refreshed result with a different end never moves the pin.
    expect(pinPages(pinned, [result(["c", "b"], "t:3")])).toBe(pinned);
  });

  it("leaves a page that is still loading, or empty from the start, unpinned", () => {
    const pages: PageSpec[] = [{ cursor: null, numItems: 2 }];
    expect(pinPages(pages, [undefined])).toBe(pages);
    expect(pinPages(pages, [result([], "t:start", true)])).toBe(pages);
  });

  it("joins loaded pages in order, stops at the first page still loading, and loads more from the pinned end", () => {
    const pages: PageSpec[] = [{ cursor: null, numItems: 2, endCursor: "t:2" }, { cursor: "t:2", numItems: 2, endCursor: "t:4" }];
    expect(pageView(pages, [result(["d", "c", "b"], "t:2"), result(["a"], "t:4")])).toEqual({ items: ["d", "c", "b", "a"], status: "CanLoadMore", next: "t:4" });
    expect(pageView(pages, [result(["d"], "t:2"), undefined])).toEqual({ items: ["d"], status: "LoadingMore", next: null });
    expect(pageView(pages, [undefined, undefined]).status).toBe("LoadingFirstPage");
    // The next page starts at the pin, even if the last page's latest result reports another end.
    expect(pageView(pages, [result(["d"], "t:2"), result(["a", "z"], "t:9")]).next).toBe("t:4");
    expect(pageView(pages, [result(["d"], "t:2"), result(["a"], "t:4", true)]).status).toBe("Exhausted");
  });
});
