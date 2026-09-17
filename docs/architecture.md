# Engine architecture

One TypeScript CLI, one SQLite database per checkout, five MCP tools. There is no account, server daemon, model invocation or network request in indexing/retrieval.

```text
tracked + unignored code ── TypeScript AST/resolver ── code nodes/edges
Codex + Claude JSONL ── Motif readers ── versioned messages/actions/tasks
                                          │
                               local claims + command observations
                                          │
                          experience ── CONCERNS ── code
                              │
                         EVIDENCED_BY
                              │
                         source message ── raw snapshot + line

query ── FTS5/BM25 ── bounded graph expansion ── freshness ── budgeted packet
```

## Representation

`nodes` and indexed directed `edges` contain navigable relationships. `sessions`, `messages` and `experience` contain typed records and stable provenance. FTS5 is a separate projection, not the graph itself. Raw JSONL snapshots are compressed outside SQLite in `.rex/raw`, named by session identity and source hash. Unknown events, abandoned branches and original bytes survive parsing changes. No code tries to interpret arbitrary SQL supplied by an agent.

Code nodes use repository-relative paths and qualified symbol names. JS/TS declarations, methods, functions, interfaces and types are indexed using the TypeScript compiler. Imports and resolvable calls become edges. Test-file imports become `TESTS` relationships, explicitly **not proof of test coverage**. Unresolved dynamic calls are omitted rather than guessed. Other listed source languages currently get file nodes and session links only. Generated/vendor/dependency directories, large files, obvious secret files, symlinks and `.rexignore` paths are omitted.

Sessions contain task/message/action nodes. Actions link to explicit files with `READ`, `EDITED`, `SEARCHED`, `RAN_TEST` and related edges. Tool calls join results by source tool-call IDs. Claude subagents have parent-scoped identities; Codex thread-spawn metadata links parents. Imported handoffs use `CONTINUES`. The original source identity is retained.

An experience has a kind, text, evidence edges, code edges, extraction method and extraction confidence. The default extractor recognizes explicit retrospective statements and explicit command exits. It does not infer a successful implementation from a tool write. User requests, private reasoning, code fences and imported tool wrappers are excluded from claim extraction. It is English-oriented and deliberately incomplete. An agent can add a higher-quality structured finding through `rex_record`, with exact evidence quotes, code targets, reasons, outcomes and optional `RESOLVES`, `CONTRADICTS` or `SUPERSEDES` relationships. These remain reported claims; quote validation verifies provenance, not logical entailment. Contradictions remain visible rather than being silently decided by the importer.

## Scope and updates

Scope comes from transcript cwd metadata and git checkout identity, not mangled directory names or repository basenames. Linked worktrees sharing a git common directory are accepted. Independent nested repositories and unrelated clones are excluded. `--alias` explicitly maps a former checkout root. Sessions spanning several repositories are only partially supported: links are admitted for paths under the scoped checkout, but the source snapshot may include other activity from that same session.

Changed transcripts are reparsed as a consistent snapshot and committed in a transaction. Size/mtime plus a pipeline revision skips unchanged imports. `--force` bypasses that cache. Rewinds withdraw derived claims from recall; prior snapshots and evidence versions remain inspectable. `sync` refreshes code and sessions; `watch` repeats this locally. Code rescanning is a full structural pass in v0.1, not a incremental language server.

Missing code nodes are tombstoned, so historical links do not disappear. Removed import/call edges are rebuilt from current code. Experience baselines are preserved when a session is reimported; reindexing cannot make an old claim look fresh.

## Freshness and confidence

There is intentionally no automatic “current truth” label. Retrieval compares the live file bytes with the hash captured when the experience was first indexed. If a Codex session provides a start commit, a git blob comparison can additionally say that the file differs from that revision; this may include the session's own fix. Absent historical snapshots are labeled unverified, not retroactively given today's contents as proof. Deletions, changed files and outdated structural indexes are visible in packets.

Extraction confidence is a heuristic about the evidence/link, not a calibrated probability that the advice is correct. Exact exit metadata is an observed command outcome. Even unchanged historical code can have obsolete dependency or environment assumptions, so the agent should inspect evidence and tests before acting.

## Retrieval

Lexical ranking seeds code and experience. Code adjacency retrieves experience about the same file/symbol even when the prose uses different words; matching experience pulls in its exact code targets. Structural neighbors and tests are bounded. Exact repeated text and excessive results from one session are suppressed. The response carries why each item was selected, IDs, source lines, timestamps, link basis and freshness reasons. Unrelated queries return no invented experience.

The entire compact serialized packet is bounded by `budget × 4` characters; “tokens” are an explicit approximation. This is not a model-tokenizer guarantee. `rex_evidence`, `rex_sessions` and `rex_neighbors` expand the record on demand. MCP stdout contains protocol messages only.

## Privacy and trust

`.rex` is mode 0700, files are local, and initialization adds a local git exclude. Do not publish or commit the database, raw snapshots, agent configs or benchmark traces. Raw snapshots intentionally contain original source data, including content the normal query interface omits. Common credential shapes are redacted at query boundaries; this is not a complete secret detector. There is no telemetry or implicit upload. Retrieved history is marked as evidence rather than instructions to reduce accidental propagation of prompt injection.

MCP config changes are project-scoped, validated before writing, and backed up under `.rex/config-backups`. Existing settings and other servers are retained. Ordinary client project-trust/MCP approval still applies; this tool does not bypass it.

## Next decisions should follow measurements

Measure recall misses before adding semantic embeddings. Measure extraction precision before adding automatic LLM enrichment. Add syntax providers for other languages as needed. Add durable path/rename identity and symbol-level historical snapshots before making stronger freshness claims. A graph UI can render the existing bounded neighborhood API without becoming part of the engine.
