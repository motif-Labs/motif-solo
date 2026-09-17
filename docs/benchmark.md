# Honest A/B evaluation

The harness is a starting point for experiments, not a benchmark result. The test suite runs a synthetic process only; it establishes that orchestration, counting and validation work.

## Freeze the experiment

Pick a repository commit before the target task was solved, a task prompt, an exact model configuration, and independent tests or an evaluator. Build the graph on that checkout with **only history that existed before the task**. Save a context packet and review it for answer leakage. Code snapshots from after the fix can leak the answer just as transcripts can. The harness requires the declared graph snapshot commit to equal the task commit and rejects undated/post-cutoff experience; it cannot prove the provided packet's contents are honest. Keep the corpus/source hashes with your research record.

`rex context` packets may contain fallback transcript excerpts without complete timestamps. Remove those from a benchmark packet (`sessions: []`) or create a packet restricted to timestamped experience. Do not merely edit their dates to get past validation.

Run identical agent commands in separate fresh worktrees, changing only the presence of the frozen context packet. This initial harness evaluates **context injection**; it does not yet automate MCP-on versus MCP-off experiments. The context is included in the measured agent prompt, so reported token usage includes its overhead. Indexing/extraction is outside the task timer; report that one-time and refresh cost separately.

Example spec (placeholders must be replaced):

```json
{
  "repo": "/workspace/project",
  "commit": "0000000000000000000000000000000000000000",
  "snapshotCommit": "0000000000000000000000000000000000000000",
  "task": "Fix the refresh-token race and add a regression test.",
  "model": "YOUR_EXACT_MODEL",
  "agent": "codex",
  "command": ["codex", "exec", "--json", "--model", "{model}", "{prompt}"],
  "testCommand": ["npm", "test", "--", "--run"],
  "setupCommand": ["npm", "ci"],
  "contextFile": "/workspace/experiment/context.json",
  "historyBefore": "2026-01-01T00:00:00.000Z",
  "timeoutSeconds": 900,
  "isolationNotes": "Describe identical permissions, instruction files, model/reasoning settings and disabled external memory/MCP integrations here."
}
```

The command is an argv array, launched without a shell. `{prompt}`, `{repo}` and `{model}` are substituted inside arguments. If no argument uses `{prompt}`, the prompt is written to stdin. For Claude, set `agent` to `claude-code` and use its native `-p --output-format stream-json --verbose` flags with your chosen model and permissions. Do not disable approval safeguards merely to complete an experiment.

```bash
rex bench-run spec.json --arm normal --output /workspace/runs/normal-01
rex bench-run spec.json --arm graph  --output /workspace/runs/graph-01
rex bench-report /workspace/runs/normal-01/result.json /workspace/runs/graph-01/result.json
```

Output includes the exact spec/prompt/packet, raw stdout JSONL, stderr, validation output, diff, wall-clock measurements and a result manifest. Worktrees remain for review; remove them with `git worktree remove` when finished. No agent process is invoked unless `bench-run` is explicitly called.

## What is measured

Native Codex `item.completed` events and Claude `tool_use` blocks count tool calls. Repeated message/item IDs are deduplicated. Exploration calls use an explicit read/search/command heuristic; repeated exploration means an identical normalized tool invocation. Multi-command shell calls count once, so inspect traces before comparing different tool styles.

Codex completed turns and Claude assistant message IDs count model turns. Native usage fields count input/output/cache tokens; absent usage is `null`, never a made-up zero. Counts from interrupted traces may be partial. Explicit nonzero command exits count failed commands, not failed design approaches. Claude tool-error flags are counted separately as toolErrors: a denied tool may never have executed.

Wall time covers the agent process. Task success requires agent exit zero and an external validation command exiting zero without timeout. Agent prose such as “all tests pass” is not a success criterion. This is only as strong as the evaluator: agents can modify repository tests. Prefer held-out tests outside the editable worktree and inspect the patch/untracked files before claiming correctness.

## Controls the harness does not enforce

It inherits the caller's environment and available agent configuration. The experimenter must disable unrelated memory/MCP services, cached sessions and asymmetric instructions, set identical permissions, and record model/reasoning versions. Running the same executable does not prove that a hosted model remained unchanged. Global hooks and agent auto-memory can contaminate the control arm; document their isolation explicitly.

Randomize arm order, repeat paired runs, report the distribution and every failure, and keep raw traces. A one-pair delta is not evidence of a general speedup. A successful synthetic fixture is not a model result. Do not equate a smaller context packet with lower task time or token usage.
