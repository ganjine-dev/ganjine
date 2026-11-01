# ROADMAP — Ganjine

Current phase: **4 — First real item** (public example agent next)

Phases are run with `/roadmap <from> [to <to>]`. A phase is done when every box is ticked and the operator can open or run the thing named under "Usable". Status notes are appended at the bottom of each phase by the agent that worked on it.

Answers to open questions (`HANDOFF.md §14`) are recorded under **Decisions** at the end of this file.

---

## Phase 0 — Skeleton

**Usable:** the repo exists, is committed, and `docker compose up` gives a Postgres.

- [x] `HANDOFF.md`, `CLAUDE.md`, `ROADMAP.md`, `.claude/commands/roadmap.md`
- [x] `docs/vocabulary.md`, `docs/content-contract.md` (prose)
- [x] `docs/adr/0002-content-contract.md` (accepted default)
- [x] Folder layout with a README in every top-level folder
- [x] `deploy/docker-compose.yml` with Postgres only
- [x] `git init`, first commit `Phase 0: skeleton`
- [x] `docs/content-contract.md` expanded with a concrete JSON Schema for a page version and each block kind
- [x] `docs/adr/0001-stack-choice.md` filled with options + a recommendation, Status: proposed
- [x] Final message lists the open questions from `HANDOFF.md §14`

**Blocked by:** nothing.

**Status (2026-11-01):** done. The schema lives in `docs/content-contract.schema.json`, with `content-contract.md` as its prose twin. Compose Postgres now listens on host port 5434 (`GANJINE_PG_PORT` overrides), because 5432 and 5433 are in use on the operator's machine.

---

## Phase 1 — Record store + categories + CLI

**Usable:** from a terminal, create items and categories, put/get records and page versions, ask for a page as of a date.

- [x] ADR 0001 accepted (backend language chosen by the operator)
- [x] ADR for blob storage (open question 2)
- [x] Migrations for the data model in `HANDOFF.md §7`
- [x] `ganjine item create|list|show`
- [x] `ganjine category create|link|list|tree`
- [x] `ganjine record put|get|query` (by kind, item, tag, date range)
- [x] `ganjine page put|get [--as-of <date>]|history`
- [x] Tests for "as of" resolution and append-only guarantees
- [x] `ganjine db migrate` works against the compose Postgres

**Blocked by:** nothing.

**Status (2026-11-01):** done. `./ganjine` runs on Node 23.6+ with `pg`, `ajv` and `ajv-formats` as the only runtime dependencies. Beyond the checklist: `ganjine category attach` (items had no other way into a category) and `ganjine blob put|get` (`embed` blocks need a blob ref).

---

## Phase 2 — The face, read-only

**Usable:** open a browser, see items, categories, pages (latest, history, as-of), an empty run browser, and health.

- [x] Web shell with stable navigation (item index, category browser, pages, runs, health)
- [x] Renderer for every block kind in `docs/content-contract.md`
- [x] Page view with latest / as-of switch and version timeline
- [x] Health page reading the `health` table
- [x] Run browser (empty, but wired)
- [x] `ganjine serve`

**Blocked by:** Phase 1 complete.

**Status (2026-11-01):** done. `./ganjine serve` serves the face on `http://127.0.0.1:4400`; `./framework/demo/seed.sh` gives a demo page with every block kind. Added dependencies: `markdown-it`, `vega`, `vega-lite`, `vega-embed`. The contract now defines what a referenced record holds: `rows` for tables, `values` for charts. The only health row so far is the face's own heartbeat.

---

## Phase 3 — Agent runtime

**Usable:** register a temporal agent, schedule it, watch it run and write a page, see the run and its log in the face.

- [x] Instruction registry reading `agents/` (name + git sha)
- [x] `schedules` and `runs` tables wired; `ganjine agent register`, `ganjine schedule create|list|disable`
- [x] Runner: picks due schedules, starts a Claude Agent SDK session, gives scoped tools, records everything, sets run status
- [x] Scoped framework tools for agents: read records, write records, write page versions, read categories
- [x] Run logs stored as records; errors captured as records tagged `error`
- [x] `agents/temporal/heartbeat/` — writes a trivial page every hour
- [x] Run browser in the face shows runs, status, duration, log, produced pages
- [x] `ganjine run <agent>` to trigger a run manually

**Blocked by:** Phase 1 and 2 complete.

**Status (2026-11-01):** done. Heartbeat is registered with an hourly schedule, but nothing fires until the operator starts `./ganjine runner`. Runs ended with real Claude sessions: manual and scheduled. Each heartbeat costs about $0.02. Added dependencies: `@anthropic-ai/claude-agent-sdk`, `zod`. Beyond the checklist: `ganjine runner`, `ganjine agent list`, a run detail page, and reaping runs left behind by a dead process. Cron matching is about 50 lines of our own, UTC only.

---

## Phase 4 — First real item

**Usable:** one real asset has a panel that a temporal agent keeps current; the operator can see its latest analysis and walk its history.

- [ ] Example item on public data, with its inputs
- [ ] `agents/asset/<name>/` written for it
- [ ] `agents/temporal/<name>-refresh/` written and scheduled
- [ ] First simulation or prediction page using real data
- [ ] History of that page visible and date-addressable
- [ ] Retrospective note in this file: what the framework was missing, promoted to `framework/` only if a second item would need it too

**Blocked by:** Phase 3 complete.

**Status (2026-11-01):** the framework was proven on a real account in a private install, kept out of this repo. No asset agent ships yet, so the unticked boxes describe a public example.

---

## Phase 5 — Hardening

**Usable:** Ganjine runs on Kubernetes with auth, backups, and real observability.

- [ ] Integration health checks with last-ok / last-error
- [ ] Error handling and retry policy for runs and timeouts
- [ ] Agent sandboxing review (what temporal agents can reach)
- [ ] k8s manifests in `deploy/`, CNPG Postgres
- [ ] Auth for the face
- [ ] Database roles: face read-only, no superuser at runtime (`adr/0005`)
- [x] Tamper evidence for records (`adr/0006`): chain and signature built, on at the first `ganjine up`
- [ ] Per-agent keys under an offline root (`adr/0006` step 3)
- [ ] Agents read records as fenced, untrusted data
- [ ] Backups and restore drill
- [ ] Metrics/health JSON endpoint for agents

**Blocked by:** Phase 4 complete.

---

## Release path

**Now, while PRs merge quickly:** `main` is the product. Installs run from a clone with `git pull` and `deploy/macos/install.sh`. Tag a `0.x` version when a batch is worth naming. Source only, no packaged build.

**DMG, when someone who is not a developer wants to install it:**

- [ ] The app carries the framework and Node, instead of pointing at a clone
- [ ] Postgres ships without Docker, or the app guides the install
- [ ] Developer ID signing and notarization, so Gatekeeper opens it. This also gives the unlock helper a stable identity, so updates keep Keychain access
- [ ] **Required:** a clone install moves into the release with its records, blobs, ledger files and key, and `ganjine ledger verify` passes on the same head
- [ ] `ganjine export` and `ganjine import` do that move, tested from every released version
- [ ] The release's unlock helper takes the key over from the old one, behind one Touch ID
- [ ] CI builds the DMG from a tag, with a drag-to-Applications window
- [ ] Auto-update

---

## Later (not scheduled)

Linux and other non-macOS unlock helpers. GNU evaluation, once the Claude dependency is replaceable. Multi-operator. External data connectors as first-class. Agents that spawn agents. Exporting `programs/` into their own repos.

---

## Decisions

Answers to `HANDOFF.md §14`. Written by the operator or by an agent quoting the operator.

| # | Question | Answer | Where recorded |
|---|---|---|---|
| 1 | Backend language | TypeScript throughout | `docs/adr/0001-stack-choice.md` |
| 2 | Blob storage | Local disk, adaptable to S3-compatible storage | `docs/adr/0003-blob-storage.md` |
| 3 | First real asset | Kept in the operator's private install | Phase 4 above |
| 4 | Embed interactivity | Client-side only | `docs/content-contract.md` |
| 5 | May Ganjine place trades | No, read-only for now: Ganjine proposes, the operator places | `docs/vocabulary.md` (Movement) |
| 6 | Session types | Six: developer, sync, explore, capital, refresh, hunt | `docs/vocabulary.md` (Session) |

---

## Log

- 2026-11-01 — Public repository started from the private project without its history or operator data (`adr/0008`). Next step: an example asset agent on public data, and Linux unlock for the signer.
