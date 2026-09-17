#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { Store } from "./store.js";
import { indexCode } from "./code.js";
import { syncSessions, evidence, type SyncOptions } from "./sessions.js";
import { recall, neighborhood, graphDot } from "./retrieve.js";
import { runMcp, sessionPage } from "./mcp.js";
import { ignoreLocalFiles, integrate } from "./integrate.js";
import { recordExperience } from "./experience.js";
import { benchmarkReport, runBenchmark } from "./benchmark.js";

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
const program = new Command()
  .name("motif-solo")
  .version("0.1.0")
  .description("A local experience graph for coding agents.");
const repo = (cmd: Command) =>
  cmd.option("--repo <directory>", "repository root", process.cwd());
const sessionOpts = (cmd: Command) =>
  cmd
    .option(
      "--codex-dir <directory>",
      "override Codex home (empty directory disables discovery)",
    )
    .option("--claude-dir <directory>", "override Claude config directory")
    .option(
      "--alias <directory...>",
      "explicitly map former repository roots to this checkout",
    )
    .option("--force", "reparse unchanged transcripts");
const optsFor = (o: any): SyncOptions => ({
  codexDir: o.codexDir,
  claudeDir: o.claudeDir,
  aliases: o.alias,
  force: o.force,
});
const use = <T>(opts: any, action: (s: Store) => T, create = false): T => {
  const s = new Store(opts.repo, { create });
  try {
    return action(s);
  } finally {
    s.close();
  }
};
sessionOpts(
  repo(
    program
      .command("init")
      .description(
        "Index code and matching local Codex/Claude sessions. No network or model calls.",
      ),
  ),
)
  .option("--integrate", "also register project MCP configs for both agents")
  .action((opts) =>
    use(
      opts,
      (store) => {
        ignoreLocalFiles(store);
        console.error("Scanning repository…");
        const code = indexCode(store);
        console.error(
          `Discovered ${code.files} files and ${code.symbols} symbols. Importing matching sessions…`,
        );
        const sessions = syncSessions(store, optsFor(opts));
        out({
          code,
          sessions,
          graph: store.stats(),
          integration: opts.integrate
            ? integrate(store, process.argv[1])
            : "Run rex integrate to register both agents.",
        });
      },
      true,
    ),
  );
sessionOpts(
  repo(
    program
      .command("sync")
      .description("Refresh code and import changed session snapshots."),
  ),
).action((opts) =>
  use(opts, (store) =>
    out({
      code: indexCode(store),
      sessions: syncSessions(store, optsFor(opts)),
    }),
  ),
);
repo(
  program
    .command("context <query>")
    .description("Retrieve a selective context packet."),
)
  .option("--budget <tokens>", "approximate token ceiling", "1800")
  .action((q, opts) =>
    use(opts, (store) => out(recall(store, q, Number(opts.budget)))),
  );
repo(program.command("status")).action((opts) =>
  use(opts, (store) => out(store.stats())),
);
repo(
  program
    .command("inspect <id>")
    .description("Inspect a graph node and its relations."),
)
  .option("--depth <n>", "0–2 graph hops", "1")
  .option("--limit <n>", "maximum nodes", "60")
  .option("--dot", "emit Graphviz DOT instead of JSON")
  .action((id, opts) =>
    use(opts, (store) => {
      const g = neighborhood(store, id, Number(opts.depth), Number(opts.limit));
      if (opts.dot) console.log(graphDot(g));
      else out(g);
    }),
  );
repo(
  program
    .command("evidence <id>")
    .description("Read cited evidence; secrets and reasoning are filtered."),
)
  .option("--radius <lines>", "0–4 neighboring raw lines", "0")
  .action((id, opts) =>
    use(opts, (store) => out(evidence(store, id, Number(opts.radius)))),
  );
repo(program.command("sessions [id]"))
  .option("--offset <n>", "page offset", "0")
  .option("--limit <n>", "page size, at most 40", "10")
  .action((id, opts) =>
    use(opts, (store) =>
      out(
        sessionPage(
          store,
          id,
          Math.max(0, Number(opts.offset)),
          Math.min(40, Math.max(1, Number(opts.limit))),
        ),
      ),
    ),
  );
repo(
  program
    .command("record <file>")
    .description(
      "Import a structured experience with validated evidence quotes.",
    ),
).action((file, opts) =>
  use(opts, (store) =>
    out(recordExperience(store, JSON.parse(fs.readFileSync(file, "utf8")))),
  ),
);
repo(
  program
    .command("mcp")
    .description("Serve the experience graph over MCP stdio."),
).action(async (opts) => runMcp(new Store(opts.repo)));
repo(
  program
    .command("integrate")
    .description(
      "Register project-scoped MCP configs for Codex and Claude Code.",
    ),
)
  .option("--print", "show launch configs only")
  .action((opts) =>
    use(opts, (store) => out(integrate(store, process.argv[1], opts.print))),
  );
sessionOpts(
  repo(
    program
      .command("watch")
      .description(
        "Continuously refresh code and changed local session files.",
      ),
  ),
)
  .option("--interval <seconds>", "refresh interval (minimum 10)", "30")
  .action((opts) => {
    const store = new Store(opts.repo);
    const tick = () => {
      try {
        indexCode(store);
        out(syncSessions(store, optsFor(opts)));
      } catch (err) {
        console.error(String(err));
      }
    };
    const timer = setInterval(
      tick,
      Math.max(10, Number(opts.interval) || 30) * 1000,
    );
    tick();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        clearInterval(timer);
        store.close();
        process.exit(0);
      });
  });
repo(
  program
    .command("hook")
    .description("Claude UserPromptSubmit hook: bounded retrieval, fail open."),
).action(async (opts) => {
  try {
    let text = "";
    for await (const chunk of process.stdin) {
      text += chunk;
      if (text.length > 64000) throw new Error("Oversized hook input");
    }
    const input = JSON.parse(text);
    if (
      input.hook_event_name !== "UserPromptSubmit" ||
      typeof input.prompt !== "string"
    )
      return;
    use(opts, (store) =>
      out({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: JSON.stringify(
            recall(store, input.prompt.slice(0, 2000), 1200),
          ),
        },
      }),
    );
  } catch (err) {
    console.error(`rex hook: ${String(err)}`);
  }
});
program
  .command("bench-report <normal> <graph>")
  .description(
    "Compare measured result manifests; never infer success from agent prose.",
  )
  .action((normal, graph) =>
    out(
      benchmarkReport(
        JSON.parse(fs.readFileSync(normal, "utf8")),
        JSON.parse(fs.readFileSync(graph, "utf8")),
      ),
    ),
  );
program
  .command("bench-run <spec>")
  .description("Execute one explicit benchmark arm in a fresh git worktree.")
  .option("--arm <arm>", "normal or graph", "normal")
  .option("--output <directory>", "new result directory (required)")
  .action(async (file, opts) => {
    if (!opts.output) throw new Error("--output is required");
    out(
      await runBenchmark(
        JSON.parse(fs.readFileSync(path.resolve(file), "utf8")),
        opts.arm,
        path.resolve(opts.output),
      ),
    );
  });
program.parseAsync().catch((err) => {
  console.error(`rex: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
