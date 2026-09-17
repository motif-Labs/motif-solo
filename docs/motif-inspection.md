# Motif inspection and reuse

Inspected upstream commit `8a3d3e672bf1306c808da2a36c79bdd76fa87242` before implementation. Upstream is Apache-2.0. This project is an extraction and a smaller engine, not a replacement dashboard or a fork of the entire application.

## What already works

`packages/core/src/schema.ts` gives the agents a common session/message contract. The Claude reader handles its parent-linked DAG, rewinds, attachment nodes, content blocks, malformed trailing lines and tool-call/result joins. The Codex reader handles rollout metadata, ordinal and fallback IDs, function calls and JSON-string arguments. These are substantial parsing details worth retaining. The readers and synthetic upstream fixtures are vendored with attribution in `NOTICE`.

`packages/cli/src/daemon/syncer.ts` discovers files, watches changes and reconciles periodically. Its remote sync protocol checks a message-prefix hash and falls back to replacement on rewinds. It also implements project allowlists, personal/team visibility and source-side redaction. This project retains the discovery routines and adapts the redaction patterns; it replaces the network protocol with atomic local snapshots and content-versioned normalized messages.

`packages/server/src/db/database.ts` uses SQLite, WAL, FTS5 and numbered migrations. `store.ts` separates normalized sessions/messages from full-text indexing. This is a good storage choice. Its member/token/visibility/handoff/job tables serve a different product scope, so this project uses a smaller per-repository schema rather than carrying those dependencies into every query.

`packages/server/src/retrieval.ts` combines BM25, handoff lineage, shared files/entities, curated notes and bounded excerpts. It has no embeddings. We adapt its query normalization and excerpt-window helpers, and retain its approach of auditable retrieval under a small budget. We replace session-level expansion with explicit code/experience adjacency. Repository partitioning happens before search because each checkout has its own database; unrelated global FTS hits cannot crowd out local candidates.

`packages/server/src/memory/pipeline.ts` provides optional model extraction with entity/aspect notes, source-session attribution, supersession, contradictions and an admission gate. It supports API providers and a local Claude subprocess through `providers.ts`. It is off by default. Its digest excludes reasoning and truncates tool output, but does not require exact message quotes for derived notes. Its scheduler advances the extraction watermark after repeated model failure. We do not copy that pipeline: the first run must work offline, evidence needs message-level precision, and a failed extraction must remain retryable.

`memory/confidence.ts` and `memory/review.ts` distinguish claimed knowledge from verified, contested, superseded and stale records. Staleness is based on repeated later sessions touching the source files; verified notes are exempt. We retain the distinction between evidence and claims, but compare content hashes during retrieval. A human or model saying “verified” must not exempt a changed file from a freshness warning.

`packages/cli/src/mcp/server.ts` exposes recall, session search/read, file history and ask-session through a handwritten stdio protocol. It supports both target agents; `commands/mcp.ts` registers their configurations. We retain the tool-oriented integration pattern but use the official MCP SDK for validation and protocol negotiation. No HTTP daemon is needed.

The `/api/graph` implementation in `packages/server/src/index.ts` builds an entity/session view from memory, co-occurrence and handoff records. It does not parse the repository or resolve calls/imports. It can fold matching entities across projects for visualization; that is unsuitable as an identity rule for code. Motif Solo keeps exact checkout-local identities.

`bench/run.ts` measures whether expected terms appear in a small retrieval bundle. It explicitly does not measure agent acceleration. That distinction is retained: retrieval fixtures and fresh-agent A/B runs are separate evaluations.

## Pieces deliberately omitted

Team enrollment, authentication, hosted synchronization, remote session resumption, native handoff writers, Cursor ingestion, the Preact dashboard, comments, approval queues and autonomous pull-request jobs. These are useful Motif features, but none is required to prove a local code/session/experience loop.

No embeddings or network model extraction in the initial engine. Both may improve recall later, but should be justified by missed-query measurements and added behind explicit local/provider configuration.

## Gaps found while using the real corpus

- Codex custom tools use `custom_tool_call` and `custom_tool_call_output`; ignoring them loses patch activity. The reader now handles them.
- Claude subagent files live below each session. They need separate identities and a parent relationship; the upstream reader only counts them. They are now ingested with sidechain-aware parsing.
- Some handoff histories serialize tool calls/results inside assistant text using `external_agent_tool_*` envelopes. Treating “file updated successfully” as a solution is wrong. Those envelopes now normalize back into inert tool events. Native history and copied history remain distinguishable through `CONTINUES` edges.
- Message IDs alone are not immutable provenance: a rewritten transcript can reuse them. Normalized IDs include a content version. Prior evidence nodes and compressed source snapshots remain available after replacement.
- Same-file proximity is not a demonstrated causal relationship. Inferred links are labeled explicitly, and a command failure is not promoted to an explanation of why an approach failed.

The initial real import and subsequent query inspection drove these corrections; they were not inferred from a graph screenshot.
