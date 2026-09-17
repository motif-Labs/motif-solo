# Contributing to Motif Solo

Small, evidence-driven improvements are welcome. Open an issue for major architecture changes; bug fixes and focused tests can go straight to a pull request.

## Local development

Use Node.js 22+ and npm. Run `npm ci`, then `npm run check`. Before opening a pull request, also run `npm run format:check`, `npm run privacy:check`, `npm run package:check`, and `npm audit`. `npm run format` applies the repository's formatting. `npm run demo` exercises the complete loop with synthetic history.

Tests must be independent of personal agent directories, credentials, network model access, and private repositories. If adding a session parser case, construct the smallest synthetic transcript that reproduces the behavior. Do not sanitize a real transcript by only changing names: hidden metadata and tool output can still contain private material.

## Changes worth making

- Improve code/session linking without weakening repository boundaries.
- Preserve message-level evidence and immutable historical snapshots.
- Test stale and contradictory claims, not just happy-path retrieval.
- Add language or session-format support with fixtures and documented limits.
- Publish reproducible benchmark methods before performance claims.

Keep the engine small. Explain the user-visible problem, the changed behavior, and how you checked it. Avoid unrelated rewrites, generated stores, benchmark logs, lockfiles from other package managers, and unreviewed dependencies.

## License and conduct

Contributions are submitted under Apache-2.0, the project's license. Preserve third-party attribution and update NOTICE when introducing adapted source. Only contribute code and test data you have the right to share. Commercial use is allowed by Apache-2.0; contributions do not imply a transfer of anyone's trademarks.

Be respectful, focus criticism on the work, and do not publish personal information. Report security issues using [SECURITY.md](SECURITY.md), not a public reproduction containing secrets.
