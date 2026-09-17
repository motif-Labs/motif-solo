import { it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureRepo } from "./helpers.js";
import { git } from "../src/util.js";
import {
  traceMetrics,
  runBenchmark,
  benchmarkReport,
} from "../src/benchmark.js";

it("counts real trace fields and leaves absent usage unknown", () => {
  const events = [
    {
      type: "item.completed",
      item: {
        id: "a",
        type: "command_execution",
        command: "cat src/token.ts",
        exit_code: 0,
      },
    },
    {
      type: "item.completed",
      item: {
        id: "a",
        type: "command_execution",
        command: "cat src/token.ts",
        exit_code: 0,
      },
    },
    {
      type: "item.completed",
      item: {
        id: "b",
        type: "command_execution",
        command: "cat src/token.ts",
        exit_code: 1,
      },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 30 },
    },
  ]
    .map((x) => JSON.stringify(x))
    .join("\n");
  expect(traceMetrics(events, "codex")).toMatchObject({
    toolCalls: 2,
    explorationCalls: 2,
    repeatedExplorationCalls: 1,
    modelTurns: 1,
    inputTokens: 100,
    cachedInputTokens: 50,
    failedCommands: 1,
  });
  expect(traceMetrics("", "claude-code").inputTokens).toBeNull();
  const denied = JSON.stringify({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "denied",
          is_error: true,
          content: "Permission denied; command did not execute.",
        },
      ],
    },
  });
  expect(traceMetrics(denied, "claude-code")).toMatchObject({
    toolErrors: 1,
    failedCommands: 0,
  });
  const claude = JSON.stringify({
    type: "assistant",
    message: {
      id: "m1",
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "Read",
          input: { file_path: "src/token.ts" },
        },
      ],
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 20,
        output_tokens: 3,
      },
    },
  });
  expect(traceMetrics(`${claude}\n${claude}`, "claude-code")).toMatchObject({
    modelTurns: 1,
    toolCalls: 1,
    inputTokens: 34,
    cachedInputTokens: 10,
  });
});
it("runs both arms in isolated worktrees and measures external test success (synthetic runner, no model)", async () => {
  const f = fixtureRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rex-bench-test-"));
  try {
    const commit = git(f.root, ["rev-parse", "HEAD"])!;
    const context = path.join(dir, "context.json");
    fs.writeFileSync(context, JSON.stringify({ experience: [], sessions: [] }));
    const runner = `console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));`;
    const spec = {
      repo: f.root,
      commit,
      task: "Synthetic harness smoke test; no model work.",
      model: "synthetic-test-runner",
      agent: "codex",
      command: [process.execPath, "-e", runner],
      testCommand: [process.execPath, "-e", "process.exit(0)"],
      contextFile: context,
      historyBefore: "2026-01-01T00:00:00.000Z",
      snapshotCommit: commit,
      isolationNotes:
        "Synthetic offline runner; no model, network, MCP or external state.",
    };
    const normal = await runBenchmark(spec, "normal", path.join(dir, "normal"));
    const graph = await runBenchmark(spec, "graph", path.join(dir, "graph"));
    expect(normal.worktree).not.toBe(graph.worktree);
    expect(normal.taskSuccess).toBe(true);
    expect(graph.taskSuccess).toBe(true);
    expect(benchmarkReport(normal, graph).differences.inputTokens).toBe(0);
    expect(() =>
      benchmarkReport(normal, { ...graph, model: "another-model" }),
    ).toThrow("model");
    expect(fs.existsSync(path.join(dir, "normal/agent.jsonl"))).toBe(true);
  } finally {
    f.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
