# Agent formats and integration sources

Verified against local Codex CLI 0.153.3, Claude Code 2.1.266, upstream Motif fixtures and both agents' local historical files. Session formats are implementation details and need regression fixtures as they evolve. Real session text is never used as a committed test fixture.

Codex rollouts normally live beneath `$CODEX_HOME/sessions/YYYY/MM/DD` (default `~/.codex`); archived rollouts are also discovered. The authoritative project/id/initial git revision come from `session_meta`, not the filename. `response_item` carries model-visible messages, function/custom tool calls and outputs. `turn_context`, runtime event messages and token telemetry are not additional conversation turns. Reasoning is not used for experience extraction. Both ordinal and ordinal-less records are supported.

Claude transcripts live below `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude`). They are parent-linked records, not a flat chat log. The active path follows the last leaf hint, traverses attachment/system records and emits message blocks. Top-level UUIDs and block offsets locate evidence. Subagents live in `<session>/subagents/agent-*.jsonl` and require sidechain parsing. Session-index files are not authoritative.

The original Motif readers establish the starting implementation; this project's tests pin the extended behavior rather than relying on undocumented assumptions about future formats.

Both clients support local stdio MCP servers. `rex integrate` writes `.mcp.json` for Claude and `.codex/config.toml` for Codex, using absolute executable/entry/repository paths so the server has an unambiguous scope. Project trust is still handled by the client. MCP tools are on-demand; their presence alone cannot guarantee the agent will choose to call them. The server instructions and `rex_context` description ask for retrieval before exploration.

Claude's `UserPromptSubmit` hook accepts `prompt`, `cwd`, `session_id` and `transcript_path`. `rex hook --repo <path>` reads that envelope and returns bounded `additionalContext`. It fails open on a missing graph or invalid payload. Hook installation is optional and manual; `rex watch` or `rex sync` refreshes history independently. Codex also has lifecycle hooks in current documentation, but this release relies on MCP rather than assuming hook compatibility across Codex versions.

Primary documentation checked during implementation:

- [Codex MCP configuration](https://developers.openai.com/codex/mcp/)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference/)
- [Codex non-interactive JSON events](https://developers.openai.com/codex/noninteractive/)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code programmatic execution](https://code.claude.com/docs/en/headless)
- [MCP server development](https://modelcontextprotocol.io/docs/develop/build-server)
