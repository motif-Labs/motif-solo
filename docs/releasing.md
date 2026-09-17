# Releasing Motif Solo

The package name is `motif-solo`, with `motif-solo` and `rex` executable aliases. The registry name was available when publication was prepared; availability is not a reservation. The GitHub source release and npm registry publication are separate steps. Never announce an npm release until the registry confirms it.

## Before every release

1. Start from a clean `main` checkout with passing CI. Run `npm ci`, `npm run check`, `npm run format:check`, `npm run privacy:check`, `npm run package:check`, and `npm audit`.
2. Review the actual `npm pack --dry-run` file list. Only built JS, package metadata, public documentation, LICENSE, and NOTICE belong in it. Review dependency license changes and preserve attribution for adapted source.
3. Update `package.json`, `package-lock.json`, the CLI version in `src/cli.ts`, and the MCP version in `src/mcp.ts` together. Update CHANGELOG and remove the README's initial-release-pending notice only when the package is actually published.
4. Create a matching `vX.Y.Z` tag from a tested main-branch commit. Do not include local source paths, personal email addresses, agent co-author trailers, history, or `.rex/` in release artifacts or commit metadata.

## One-time npm bootstrap

Publishing requires a maintainer's npm account with package ownership and two-factor authentication. Authenticate interactively with `npm login`; never paste a token into an issue, chat, source file, or workflow. Verify the account with `npm whoami`.

For a package that does not yet exist, publish the reviewed first version from the maintainer's clean checkout with `npm publish --access public`. Complete npm's interactive authentication. If the desired name is no longer available, choose an owned scope and update package metadata and docs before publishing. Do not imply provenance for a local bootstrap upload.

After the first publication, configure the package's **Trusted Publisher** on npm:

- Provider: GitHub Actions
- Organization/user: `motif-Labs`
- Repository: `motif-solo`
- Workflow filename: `publish.yml`
- Environment: `npm`

Create the matching GitHub environment. The workflow uses a GitHub-hosted runner, Node 24, npm 11.6.2, OIDC (`id-token: write`), and provenance. It stores no long-lived npm token. Follow [npm's current trusted-publisher instructions](https://docs.npmjs.com/trusted-publishers/) and review registry publishing permissions after bootstrap.

## Subsequent releases

Run **publish npm** from the Actions tab on `main`, entering the existing release tag. The workflow checks the tag syntax, version, main ancestry, tests, formatting, source privacy, actual package contents, installation behavior, and dependencies before publishing. The environment can be configured with maintainer reviewers if desired.

After publication, verify `npm view motif-solo version dist.integrity`, inspect the provenance on npm, and test `npx --yes motif-solo@X.Y.Z --help` in a fresh directory. Create GitHub release notes from CHANGELOG with the same version. Do not attach local graph databases, real-session exports, benchmark runs, or machine-specific logs.

## License and commercial use

The project is Apache-2.0, including its modifications to Motif's Apache-2.0 code. Commercial use and commercial products are allowed under the license; maintain required notices and comply with third-party terms. NOTICE records upstream sources. The license does not grant rights to others' trademarks or remove obligations for redistributed dependencies. See the [Apache-2.0 text](../LICENSE) and [Apache's application guidance](https://www.apache.org/legal/apply-license).
