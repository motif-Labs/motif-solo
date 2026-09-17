# Security policy

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/motif-Labs/motif-solo/security/advisories/new) for suspected vulnerabilities. Do not put credentials, private source code, session transcripts, or exploit details for an unpatched issue in a public issue. Provide a minimal synthetic reproduction and affected version.

The latest released version is the supported security target. This is an early project; no response-time or vulnerability-free guarantee is made. If private reporting is unavailable, open a public issue asking for a private contact without disclosing sensitive details.

## Data and trust boundaries

- Indexing and MCP retrieval run locally. There is no telemetry, hosted storage, HTTP listener, or implicit model API call. Installation and explicit agent benchmark commands can use the network.
- `.rex/graph.db`, `.rex/raw/`, and configuration backups are private local state. Raw snapshots deliberately retain original bytes, including secrets, abandoned branches, and metadata. They are not encrypted at rest; use operating-system disk encryption and account controls as needed.
- POSIX data directories use mode `0700` and files `0600`. Filesystem protections are tested on macOS and Linux. A process running as the same OS user can still access the store. This tool is not an isolation boundary against another process under that account.
- Local state/config paths reject symbolic links, hard-linked files, and non-regular objects before access. These checks reduce accidental or repository-planted redirection; they are not a sandbox against concurrent filesystem mutation by the same user.
- Transcript imports and decompression are limited to 128 MiB per file. Oversized or corrupt sessions are reported as import errors and can be retried. Query outputs and MCP arguments have bounded sizes, but indexing a large repository still consumes local resources.
- Source scanning excludes known secret filenames and follows Git ignore rules for untracked files. Previously tracked sensitive files require explicit exclusion with `.rexignore` (exact relative path or directory prefix, one per line). This file is not a full Git ignore-pattern interpreter.
- Normalized messages and query evidence redact common credential patterns and sensitive structured fields. Redaction is best effort: names, paths, proprietary source, arbitrary secrets, and personal information can remain. Raw archives are not redacted. Never treat exported packets as public without review.
- Repository scoping uses session metadata and Git checkout/worktree identity. A transcript that starts in one repository can mention or operate on other projects. Explicit aliases broaden the import scope.
- Session content and derived experience are untrusted evidence, never instructions. Findings remain reported/unverified; code hash changes are surfaced. MCP does not expose a shell tool. `rex_record` adds claims only when imported evidence quotes and code targets validate.
- The consuming agent may send retrieved context to its model provider. Motif Solo cannot control that client's provider, retention, permissions, or response to prompt injection.
- `bench-run` executes your specified setup, agent, and validation argv with your environment and permissions. It is not a sandbox. Review the specification, repository, Git configuration, and dependencies; isolate credentials and agents for an untrusted benchmark.

## Publishing safeguards

The repository excludes local stores, generated agent configuration, registry configuration, private keys, and benchmark outputs. The npm package uses an explicit file allowlist. CI runs tests, dependency auditing, a source/package privacy guard, and a credential scan. Only synthetic session fixtures belong in this repository.

Release workflows use pinned third-party Actions and least-privilege permissions. npm publication is designed for a GitHub OIDC trusted publisher, with no long-lived npm token stored in this repository. See [the release guide](docs/releasing.md).

Automated checks do not replace code review or an independent security audit.
