import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentSetup } from "./agentSetup";

const url = "https://x-y-123.convex.site", key = "rm_abc123secret";
// A hosted MCP form can be added as one more member of the object agentSetup returns.
const setup = agentSetup(url, key);

describe("agent setup snippets", () => {
  it("fill the URL and key into every client's config", () => {
    for (const text of [setup.claudeCommand, setup.claudeJson, setup.codex, setup.generic]) {
      expect(text).toContain(url);
      expect(text).toContain(key);
    }
  });
  it("carry no other secret and name the MCP server entry file", () => {
    for (const text of Object.values(setup)) { expect(text).not.toMatch(/sk_|whsec_|Bearer|password/i); expect(text.match(/rm_\w+/g)?.every((k) => k === key) ?? true).toBe(true); }
    expect(setup.claudeCommand).toMatch(/^claude mcp add remold /);
    expect(JSON.parse(setup.claudeJson).mcpServers.remold.env).toEqual({ REMOLD_URL: url, REMOLD_KEY: key });
    expect(JSON.parse(setup.generic).mcpServers.remold.command).toBe("node");
  });
  it("names the same environment variables the MCP server reads, in every client's config", () => {
    const names = ["REMOLD_URL", "REMOLD_KEY"], server = readFileSync("packages/mcp/src/index.ts", "utf8"), readme = readFileSync("packages/mcp/README.md", "utf8");
    for (const name of names) for (const text of [server, readme, setup.claudeCommand, setup.claudeJson, setup.codex, setup.generic]) expect(text).toContain(name);
    const envNames = (text: string) => [...text.matchAll(/\b(REMOLD_\w+)\b/g)].map((m) => m[1]);
    expect(new Set(envNames(setup.codex))).toEqual(new Set(names));
    expect(new Set(envNames(setup.generic))).toEqual(new Set(names));
    expect(new Set(envNames(setup.claudeCommand))).toEqual(new Set(names));
  });
  it("tells the person how to test it", () => expect(setup.test).toBe("Ask your agent: what is in my Remold workspace?"));
  it("uses the same invocation as the MCP README", () => {
    const readme = readFileSync("packages/mcp/README.md", "utf8");
    const entry = "/absolute/path/to/remold/packages/mcp/dist/index.js";
    expect(readme).toContain(`claude mcp add remold -e REMOLD_URL=https://your-deployment.convex.site -e REMOLD_KEY=rm_your_key -- node ${entry}`);
    expect(setup.claudeCommand).toBe(`claude mcp add remold -e REMOLD_URL=${url} -e REMOLD_KEY=${key} -- node ${entry}`);
    expect(readme).toContain(`args = ["${entry}"]`);
    expect(setup.codex).toContain(`args = ["${entry}"]`);
    expect(readme).toContain("remold_map");
  });
});
