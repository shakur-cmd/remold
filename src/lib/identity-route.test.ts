import { expect, it } from "vitest";
import { authReturnTarget } from "./identity-route";

const origin = "http://localhost:5173";
it("returns to an invite or workspace route after hosted sign-in", () => {
  for (const path of ["/invite/fixture-token", "/o/example/company/record?view=all#notes", "/#/invite/fixture-token"]) {
    expect(authReturnTarget(path, origin)).toBe(path);
  }
  expect(authReturnTarget(`${origin}/invite/fixture-token`, origin)).toBe("/invite/fixture-token");
});
it("cannot redirect the callback to another origin, script or browser-normalized host", () => {
  for (const value of ["https://attacker.invalid/", "//attacker.invalid/", "/\\attacker.invalid/", "javascript:alert(1)", "data:text/html,test", " /invite/test", "/\n/attacker.invalid/", "http://localhost:5174/invite/test", "http://localhost:5173@attacker.invalid/", "%2f%2fattacker.invalid"]) {
    expect(authReturnTarget(value, origin), value).toBe("/");
    expect(new URL(authReturnTarget(value, origin), origin).origin).toBe(origin);
  }
});
it("drops missing or malformed state and callback/login loops", () => {
  for (const value of [null, undefined, {}, ["/invite/test"], 42, "", "/callback?code=sensitive&state=stale", "/login", `${origin}/callback`]) {
    expect(authReturnTarget(value, origin)).toBe("/");
  }
});
