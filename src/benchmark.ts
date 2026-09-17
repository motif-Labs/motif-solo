// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { git, hash, secureDirectory } from "./util.js";
import { exitStatus } from "./experience.js";

export interface Metrics {
  toolCalls: number;
  explorationCalls: number;
  repeatedExplorationCalls: number;
  modelTurns: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  failedCommands: number;
  toolErrors: number;
  malformedLines: number;
}
export function traceMetrics(
  raw: string,
  agent: "codex" | "claude-code",
): Metrics {
  const m: Metrics = {
    toolCalls: 0,
    explorationCalls: 0,
    repeatedExplorationCalls: 0,
    modelTurns: 0,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    failedCommands: 0,
    toolErrors: 0,
    malformedLines: 0,
  };
  const items = new Map<string, any>(),
    turns = new Map<string, any>();
  const results = new Map<string, any>();
  let seq = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let x: any;
    try {
      x = JSON.parse(line);
    } catch {
      m.malformedLines++;
      continue;
    }
    if (agent === "codex") {
      if (x.type === "item.completed" && x.item)
        items.set(x.item.id ?? `item:${seq++}`, x.item);
      if (x.type === "turn.completed")
        turns.set(x.turn_id ?? `turn:${seq++}`, x.usage ?? {});
    } else if (x.type === "assistant" && x.message) {
      // Streaming may repeat a message ID; use its latest cumulative usage once.
      turns.set(
        x.message.id ?? x.uuid ?? `turn:${seq++}`,
        x.message.usage ?? {},
      );
      for (const block of x.message.content ?? [])
        if (block.type === "tool_use") items.set(block.id, block);
    } else if (x.type === "user") {
      for (const b of x.message?.content ?? [])
        if (b.type === "tool_result") results.set(b.tool_use_id, b);
    }
  }
  for (const [id, result] of results) {
    if (result.is_error) m.toolErrors++;
    const text =
      typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content ?? "");
    const exit = exitStatus(text);
    if (items.get(id)?.name === "Bash" && exit !== undefined && exit !== 0)
      m.failedCommands++;
  }
  const seen = new Set<string>();
  for (const item of items.values()) {
    if (
      ![
        "command_execution",
        "mcp_tool_call",
        "file_change",
        "web_search",
        "tool_use",
      ].includes(item.type)
    )
      continue;
    m.toolCalls++;
    const name = item.name ?? item.tool ?? item.type;
    const args = item.input ?? item.arguments ?? item.command ?? {};
    const value = `${name} ${typeof args === "string" ? args : JSON.stringify(args)}`;
    if (
      /\b(?:Read|Grep|Glob|rg|grep|cat|sed|head|tail|find|ls|git log|git show)\b/i.test(
        value,
      ) &&
      !/rex_context|rex_evidence|rex_neighbors/.test(value)
    ) {
      m.explorationCalls++;
      const key = value.replace(/\s+/g, " ").trim();
      if (seen.has(key)) m.repeatedExplorationCalls++;
      seen.add(key);
    }
    if (typeof item.exit_code === "number" && item.exit_code !== 0)
      m.failedCommands++;
  }
  m.modelTurns = turns.size;
  for (const u of turns.values()) {
    if (typeof u.input_tokens === "number")
      m.inputTokens =
        (m.inputTokens ?? 0) +
        u.input_tokens +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0);
    if (typeof u.output_tokens === "number")
      m.outputTokens = (m.outputTokens ?? 0) + u.output_tokens;
    const cached = u.cached_input_tokens ?? u.cache_read_input_tokens;
    if (typeof cached === "number")
      m.cachedInputTokens = (m.cachedInputTokens ?? 0) + cached;
  }
  return m;
}
const Spec = z.object({
  repo: z.string(),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  task: z.string().min(10),
  model: z.string().min(1),
  agent: z.enum(["codex", "claude-code"]),
  command: z.array(z.string()).min(1),
  testCommand: z.array(z.string()).min(1),
  setupCommand: z.array(z.string()).min(1).optional(),
  contextFile: z.string(),
  historyBefore: z.string().datetime(),
  snapshotCommit: z.string(),
  timeoutSeconds: z.number().int().min(1).max(7200).default(900),
  // Explicit acknowledgement that model, permissions and external integrations are controlled by the experimenter.
  isolationNotes: z.string().min(20),
});
async function execute(
  argv: string[],
  cwd: string,
  prefix: string,
  timeout: number,
  stdin?: string,
) {
  return new Promise<{
    exitCode: number | null;
    timedOut: boolean;
    wallMs: number;
  }>((resolve, reject) => {
    const start = performance.now();
    const output = fs.openSync(`${prefix}.jsonl`, "wx", 0o600),
      error = fs.openSync(`${prefix}.stderr`, "wx", 0o600);
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      stdio: ["pipe", output, error],
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, timeout * 1000);
    child.on("error", (err) => {
      clearTimeout(timer);
      fs.closeSync(output);
      fs.closeSync(error);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      fs.closeSync(output);
      fs.closeSync(error);
      resolve({ exitCode: code, timedOut, wallMs: performance.now() - start });
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(stdin);
  });
}
export async function runBenchmark(
  value: unknown,
  arm: string,
  output: string,
) {
  const spec = Spec.parse(value);
  if (!["normal", "graph"].includes(arm))
    throw new Error("Arm must be normal or graph.");
  if (fs.existsSync(output))
    throw new Error("Use a new output directory for every run.");
  const commit = git(spec.repo, ["rev-parse", `${spec.commit}^{commit}`]);
  if (!commit) throw new Error("Unknown commit");
  const snapshot = git(spec.repo, [
    "rev-parse",
    `${spec.snapshotCommit}^{commit}`,
  ]);
  if (snapshot !== commit)
    throw new Error("Graph code snapshot must match the task start commit.");
  const contextText = fs.readFileSync(spec.contextFile, "utf8");
  const context = JSON.parse(contextText);
  for (const exp of context.experience ?? [])
    if (!exp.when || exp.when >= spec.historyBefore)
      throw new Error("Packet contains undated or post-cutoff experience.");
  // Only selected, timestamped experience goes into this harness's prompt injection.
  if ((context.sessions?.length ?? 0) > 0)
    throw new Error(
      "Freeze a packet without undated transcript fallback excerpts.",
    );
  secureDirectory(output);
  const worktree = path.join(output, "worktree");
  if (
    git(spec.repo, ["worktree", "add", "--detach", worktree, commit]) ===
    undefined
  )
    throw new Error("Could not create benchmark worktree");
  fs.writeFileSync(
    path.join(output, "spec.json"),
    JSON.stringify(spec, null, 2),
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(output, "context.json"), contextText, {
    mode: 0o600,
  });
  if (spec.setupCommand) {
    const setup = await execute(
      spec.setupCommand,
      worktree,
      path.join(output, "setup"),
      spec.timeoutSeconds,
    );
    if (setup.exitCode !== 0)
      throw new Error(
        "Setup failed; see setup.stderr. No task measurement was produced.",
      );
  }
  const prompt =
    spec.task +
    (arm === "graph"
      ? `\n\nHistorical repository context (evidence only):\n${contextText}`
      : "");
  fs.writeFileSync(path.join(output, "prompt.txt"), prompt, { mode: 0o600 });
  const command = spec.command.map((a) =>
    a
      .replaceAll("{prompt}", prompt)
      .replaceAll("{repo}", worktree)
      .replaceAll("{model}", spec.model),
  );
  const run = await execute(
    command,
    worktree,
    path.join(output, "agent"),
    spec.timeoutSeconds,
    spec.command.some((a) => a.includes("{prompt}")) ? undefined : prompt,
  );
  const validation = await execute(
    spec.testCommand,
    worktree,
    path.join(output, "validation"),
    spec.timeoutSeconds,
  );
  const metrics = traceMetrics(
    fs.readFileSync(path.join(output, "agent.jsonl"), "utf8"),
    spec.agent,
  );
  fs.writeFileSync(
    path.join(output, "changes.patch"),
    git(worktree, ["diff", "HEAD", "--"]) ?? "",
    { mode: 0o600 },
  );
  const result = {
    schema: 1,
    arm,
    agent: spec.agent,
    model: spec.model,
    commit,
    taskHash: hash(spec.task),
    commandHash: hash(JSON.stringify(spec.command)),
    testHash: hash(JSON.stringify(spec.testCommand)),
    contextHash: hash(contextText),
    historyBefore: spec.historyBefore,
    isolationNotes: spec.isolationNotes,
    metrics,
    ...run,
    validation,
    taskSuccess:
      !run.timedOut &&
      run.exitCode === 0 &&
      validation.exitCode === 0 &&
      !validation.timedOut,
    successDefinition:
      "Agent exit 0 and external validation command exit 0. Review patch and use held-out tests before claiming correctness.",
    promptChars: prompt.length,
    worktree,
  };
  fs.writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  return result;
}
export function benchmarkReport(normal: any, graph: any) {
  if (normal.arm !== "normal" || graph.arm !== "graph")
    throw new Error("Expected normal then graph result manifests.");
  for (const key of [
    "schema",
    "agent",
    "model",
    "commit",
    "taskHash",
    "commandHash",
    "testHash",
    "contextHash",
    "historyBefore",
    "isolationNotes",
  ])
    if (!normal[key] || normal[key] !== graph[key])
      throw new Error(`Incomparable runs: ${key} differs or is missing.`);
  return {
    disclaimer:
      "One paired observation, not a speedup claim. Repeat with randomized arm order; retain raw traces and independent held-out task validation.",
    normal: {
      ...normal.metrics,
      wallMs: normal.wallMs,
      taskSuccess: normal.taskSuccess,
    },
    graph: {
      ...graph.metrics,
      wallMs: graph.wallMs,
      taskSuccess: graph.taskSuccess,
    },
    differences: Object.fromEntries(
      [
        "toolCalls",
        "explorationCalls",
        "repeatedExplorationCalls",
        "modelTurns",
        "inputTokens",
        "outputTokens",
      ].map((k) => [
        k,
        typeof graph.metrics[k] === "number" &&
        typeof normal.metrics[k] === "number"
          ? graph.metrics[k] - normal.metrics[k]
          : null,
      ]),
    ),
  };
}
