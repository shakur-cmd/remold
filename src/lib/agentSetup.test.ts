import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentSetup } from "./agentSetup";

const url = "https://x-y-123.convex.site", key = "rm_abc123secret";
const setup = agentSetup(url, key);
const hosted = [setup.hostedClaudeCommand, setup.hostedCodex, setup.hostedJson], stdio = [setup.claudeCommand, setup.claudeJson, setup.codex, setup.generic];

describe("agent setup snippets", () => {
  it("fill the URL and key into every client's config", () => {
    for (const text of [...hosted, ...stdio]) {
      expect(text).toContain(url);
      expect(text).toContain(key);
    }
  });
  it("carry no other secret and name the MCP server entry file", () => {
    for (const text of Object.values(setup)) { expect(text).not.toMatch(/sk_|whsec_|password/i); expect(text.match(/rm_\w+/g)?.every((k) => k === key) ?? true).toBe(true); expect(text.match(/Bearer \S+?(?=["\s]|$)/g)?.every((b) => b === `Bearer ${key}`) ?? true).toBe(true); }
    expect(setup.claudeCommand).toMatch(/^claude mcp add remold /);
    expect(JSON.parse(setup.claudeJson).mcpServers.remold.env).toEqual({ REMOLD_URL: url, REMOLD_KEY: key });
    expect(JSON.parse(setup.generic).mcpServers.remold.command).toBe("node");
  });
  it("lists the hosted forms first, pointing at the deployment's /mcp with the key as a bearer header", () => {
    expect(Object.keys(setup).slice(0, 3)).toEqual(["hostedClaudeCommand", "hostedCodex", "hostedJson"]);
    expect(setup.hostedClaudeCommand).toBe(`claude mcp add --transport http remold ${url}/mcp --header "Authorization: Bearer ${key}"`);
    expect(setup.hostedCodex).toBe(`[mcp_servers.remold]\nurl = "${url}/mcp"\nhttp_headers = { "Authorization" = "Bearer ${key}" }`);
    expect(JSON.parse(setup.hostedJson).mcpServers.remold).toEqual({ type: "http", url: `${url}/mcp`, headers: { Authorization: `Bearer ${key}` } });
    for (const text of hosted) expect(text).not.toMatch(/REMOLD_|node /);
  });
  it("names the same environment variables the MCP server reads, in every stdio config", () => {
    const names = ["REMOLD_URL", "REMOLD_KEY"], server = readFileSync("packages/mcp/src/index.ts", "utf8"), readme = readFileSync("packages/mcp/README.md", "utf8");
    for (const name of names) for (const text of [server, readme, ...stdio]) expect(text).toContain(name);
    const envNames = (text: string) => [...text.matchAll(/\b(REMOLD_\w+)\b/g)].map((m) => m[1]);
    expect(new Set(envNames(setup.codex))).toEqual(new Set(names));
    expect(new Set(envNames(setup.generic))).toEqual(new Set(names));
    expect(new Set(envNames(setup.claudeCommand))).toEqual(new Set(names));
  });
  it("tells the person how to test it", () => expect(setup.test).toBe("Ask your agent: what is in my Remold workspace?"));
  it("uses the same invocations as the MCP README, hosted before stdio", () => {
    const readme = readFileSync("packages/mcp/README.md", "utf8"), site = "https://your-deployment.convex.site", sample = agentSetup(site, "rm_your_key");
    const entry = "/absolute/path/to/remold/packages/mcp/dist/index.js";
    for (const text of [sample.hostedClaudeCommand, sample.hostedCodex, sample.claudeCommand]) expect(readme).toContain(text);
    expect(readme).toContain(JSON.stringify(JSON.parse(sample.hostedJson)));
    expect(readme.indexOf(sample.hostedClaudeCommand)).toBeLessThan(readme.indexOf(sample.claudeCommand));
    expect(setup.claudeCommand).toBe(`claude mcp add remold -e REMOLD_URL=${url} -e REMOLD_KEY=${key} -- node ${entry}`);
    expect(readme).toContain(`args = ["${entry}"]`);
    expect(setup.codex).toContain(`args = ["${entry}"]`);
    expect(readme).toContain("remold_map");
  });
});
