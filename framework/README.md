# framework/

The hosting layer: record store, category system, page registry, agent runtime (scheduler + runner), observability, and the face. The `ganjine` CLI lives here.

Run it with `./ganjine` from the repo root, on Node 23.6+ with no build step. `ganjine` with no arguments lists every command.

- Setup: `npm install` here, `docker compose -f deploy/docker-compose.yml up -d`, `./ganjine db migrate`.
- Face: `./ganjine serve [--port 4400]`, loopback only. `./framework/demo/seed.sh` builds a separate `ganjine_demo` database with every block kind and prints how to open it.
- Agents need `@anthropic-ai/claude-agent-sdk`, an optional dependency under its own terms (`NOTICE`).
- Agents: `./ganjine agent register temporal/<name>`, `./ganjine run <name>`, `./ganjine runner`. Sessions use `ANTHROPIC_API_KEY`, or the local Claude Code login if it is unset.
- Checks: `npm run typecheck`, `npm test`. Tests need the compose Postgres and use throwaway databases.
- Env: `GANJINE_DATABASE_URL`, `GANJINE_BLOB_DIR` (default `.ganjine/blobs`), `GANJINE_LEDGER_DIR` (default `.ganjine/ledger`), `GANJINE_DEBUG` (stack traces).
- Start: `deploy/macos/install.sh` once, then `Ganjine.app` or `./ganjine up`. `./ganjine down` stops it, `./ganjine status` explains it.
- Ledger: `adr/0006`. Off until `.ganjine/ledger/ledger.pub` exists (`GANJINE_LEDGER_DIR` moves it). Once on, writes need the signer, and `./ganjine ledger verify` walks the chain.
- Live: `/events` for the face, `./ganjine watch` for agents (`adr/0007`).
- Migrations are plain SQL in `migrations/`, applied once each in name order.

**No domain knowledge.** Nothing in this folder knows what a bond, a portfolio or a market is.
