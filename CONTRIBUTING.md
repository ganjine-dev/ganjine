# Contributing

Issues and pull requests are welcome. For anything large, open an issue first.

## Pull requests

1. Branch from `main` and keep the change small.
2. Run `npm run typecheck` and `npm test` in `framework/`. Tests need the compose Postgres.
3. Follow `CLAUDE.md`: use the words in `docs/vocabulary.md`, put no domain logic in `framework/`, and write an ADR before a hard-to-reverse choice.
4. Add a line to `CHANGELOG.md` under Unreleased.
5. Sign off every commit with `git commit -s`.

The sign-off certifies the [Developer Certificate of Origin](https://developercertificate.org): you have the right to submit the work under this project's license. Agent-written code is welcome, and the person who signs off is responsible for it. Add a `Co-Authored-By` line for the agent if you like.

Never include operator data, in code, tests, fixtures or logs.

## Versions

Ganjine uses [Semantic Versioning](https://semver.org). The public surface is the CLI, the content contract, the database migrations and the ledger format.

- **Patch:** fixes.
- **Minor:** new features that keep existing installs working. A migration is fine if it applies by itself.
- **Major:** an install or an agent has to change. Before `1.0.0`, this is a minor bump, called out in the changelog.

The content contract has its own `contract_version`. Old versions keep their renderers, so old pages keep rendering.

## Releases

A maintainer moves Unreleased to a dated version in `CHANGELOG.md`, bumps `framework/package.json`, tags `vX.Y.Z` with a signed tag, and publishes a GitHub release with the changelog entry.
