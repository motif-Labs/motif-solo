import { it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fixtureRepo, codexTranscript } from "./helpers.js";
import { importSession } from "../src/sessions.js";

it("a fresh MCP client can retrieve code, experience, raw evidence and graph neighbors", async () => {
  const f = fixtureRepo();
  importSession(f.store, {
    path: f.write("history/c.jsonl", codexTranscript(f.root)),
    agent: "codex",
  });
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      path.resolve("src/cli.ts"),
      "mcp",
      "--repo",
      f.root,
    ],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      "rex_context",
    );
    const result = await client.callTool({
      name: "rex_context",
      arguments: { query: "refresh token race", budget: 2000 },
    });
    expect(result.isError).not.toBe(true);
    const packet = JSON.parse((result.content as any)[0].text);
    expect(packet.experience.length).toBeGreaterThan(0);
    const proof = await client.callTool({
      name: "rex_evidence",
      arguments: { id: packet.experience[0].id },
    });
    expect(proof.isError).not.toBe(true);
    expect(
      JSON.parse((proof.content as any)[0].text)[0].raw.length,
    ).toBeGreaterThan(0);
    const graph = await client.callTool({
      name: "rex_neighbors",
      arguments: { id: "file:src/token.ts" },
    });
    expect(
      JSON.parse((graph.content as any)[0].text).edges.length,
    ).toBeGreaterThan(0);
    const bad = await client.callTool({
      name: "rex_evidence",
      arguments: { id: "../private" },
    });
    expect(bad.isError).toBe(true);
  } finally {
    await client.close();
    f.close();
  }
}, 20000);
