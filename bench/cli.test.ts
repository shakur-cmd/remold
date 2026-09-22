import { beforeEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { run } from "./cli";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawn: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

test("a successful function with no CLI output returns null", () => {
  vi.mocked(execFileSync).mockReturnValue("");
  expect(run("bench:removeRecovery", {})).toBeNull();
});
test("a function result preserves returned JSON", () => {
  vi.mocked(execFileSync).mockReturnValue('{"page":[],"isDone":true}\n');
  expect(run("bench:page", {})).toEqual({ page: [], isDone: true });
});
test("malformed output and failed commands still fail the caller", () => {
  vi.mocked(execFileSync).mockReturnValue('{"page":');
  expect(() => run("bench:page", {})).toThrow(SyntaxError);
  vi.mocked(execFileSync).mockImplementation(() => { throw new Error("Command failed"); });
  expect(() => run("bench:page", {})).toThrow("Command failed");
});
