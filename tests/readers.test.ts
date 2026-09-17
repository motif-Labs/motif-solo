import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readClaudeSession } from "../src/vendor/motif/readers/claude-code.js";
import { readCodexSession } from "../src/vendor/motif/readers/codex.js";
import { codexTranscript, claudeTranscript } from "./helpers.js";

const fixture = (name: string) =>
  path.join(import.meta.dirname, "fixtures", name);
describe("Motif readers and extensions", () => {
  it("preserves upstream active-branch selection and source lines", () => {
    const s = readClaudeSession(fixture("claude-code/branched.jsonl"));
    expect(s.messages.map((m) => m.text)).toEqual([
      "first question",
      "first answer",
      "rewound follow-up",
      "active answer",
    ]);
    expect(s.meta.branchCount).toBe(1);
    const lines = fs.readFileSync(s.sourcePath, "utf8").split("\n");
    for (const m of s.messages)
      expect(lines[m.sourceLine! - 1]).toContain(m.id.split("#")[0]);
  });
  it("tolerates partial writes and unknown events", () => {
    const s = readClaudeSession(fixture("claude-code/corrupted.jsonl"));
    expect(s.messages).toHaveLength(2);
    expect(s.meta.parseErrors).toBe(2);
    const c = readCodexSession(fixture("codex/rollout-0.150.1.jsonl"));
    expect(c.source).toBe("codex");
    expect(c.messages.length).toBeGreaterThan(0);
  });
  it("keeps custom patch input/output and distinguishes Claude tool errors", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rex-readers-"));
    try {
      const c = path.join(dir, "rollout.jsonl");
      fs.writeFileSync(c, codexTranscript("/workspace/app"));
      const s = readCodexSession(c);
      expect(
        s.messages.find((m) => m.toolName === "apply_patch")?.toolInput,
      ).toContain("Update File: src/token.ts");
      expect(
        s.messages.find((m) => m.toolName === "apply_patch")?.sourceLine,
      ).toBe(3);
      const a = path.join(dir, "agent.jsonl");
      fs.writeFileSync(
        a,
        claudeTranscript("/workspace/app")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.stringify({ ...JSON.parse(l), isSidechain: true }))
          .join("\n"),
      );
      expect(readClaudeSession(a).messages).toHaveLength(0);
      expect(readClaudeSession(a, { subagent: true }).messages).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not misread handoff tool output as assistant experience", () => {
    const raw = [
      {
        type: "session_meta",
        payload: { id: "handoff", cwd: "/workspace/app" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { text: "[Handed off from Claude Code session abc-def via Motif]" },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              text: "[external_agent_tool_call: Write]\nfile: src/token.ts\n[/external_agent_tool_call]",
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              text: "[external_agent_tool_result]\nFile updated successfully at src/token.ts\n[/external_agent_tool_result]",
            },
          ],
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n");
    const s = readCodexSession("/unused/snapshot.jsonl", raw);
    expect(s.handoffFrom).toBe("claude-code:abc-def");
    expect(s.messages.map((m) => m.role)).toEqual([
      "user",
      "tool_call",
      "tool_result",
    ]);
  });
});
