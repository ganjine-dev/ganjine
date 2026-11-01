# HANDOFF — Ganjine

> This is the spinal document of this repository. Every agent working here reads it first and keeps it true. If reality and this document disagree, fix one of them in the same change.
>
> Status: living document. Ownership: `GOVERNANCE.md`.
> Name: **Ganjine**. CLI: `ganjine`. Repo: `ganjine`.

---

## 1. What this is

Ganjine is a framework for **capital management**: a hosted system in which an *operator* (a human) describes assets and feeds data, *agents* analyse those assets and write the results as pages of one shared dashboard, and *temporal agents* (scheduled, pre-instructed Claude Agent SDK sessions) keep those pages current over time.

The framework itself does not know what an asset is. It knows how to **host, store, schedule, observe and present** whatever the operator and the agents produce. Everything domain-specific (what a given asset's panel shows, what a simulation looks like, what "prediction" means for a given item) is written by agents on top of the framework, not into it.

Two things are built here, in this order:

1. **The framework** — the hosting shell, the record store, the agent runtime, the observability surface.
2. **Programs on top of it** — the actual asset analyses, simulations, predictions and visualizations. These live in the same repo for now, clearly separated, and may be split out later.

The repo is public under AGPL-3.0-or-later (`docs/adr/0008-open-source.md`). Operator data never enters it.

---

## 2. The idea on one page

- The operator describes an **item** (an asset, a holding, a position, a plan, anything worth tracking) and provides its **inputs** (data, documents, parameters, sources).
- Every item is placed in a **category system** — not a fixed taxonomy of asset types, but a flexible structure of labels, tags and relations (tree where a tree is natural, graph where it is not). The framework pivots around *nothing* in particular; the category system is the only organizing principle and it is operator-defined.
- For each item, an **asset agent** writes a **panel**: the item's own page(s) in the dashboard — analysis, charts, simulations, interactive views.
- The dashboard has **one solid face and flexible content**. The face (navigation, item index, category browser, history browser, agent/run browser, system health) is owned by the framework and is stable. The content (pages, subpages, panels) is owned by agents and changes freely.
- **Temporal agents** are wake-up sessions: pre-instructed, scheduled, run by the framework. They re-fetch, recompute and rewrite pages. The operator sees the **latest** interactive output and can walk **back through history**.
- **Everything is a record.** Inputs, outputs, page versions, agent runs, logs, errors — all stored in the database, timestamped and tagged. Nothing is overwritten in place; "latest" is a pointer.
- The **developer agent** (a Claude Code session working in this repo) builds the framework, writes asset agents, and can spawn and schedule temporal agents.
- The framework provides **observability** over all of this: is the system live, are integrations connected, which agent ran when, what did it produce, where did it fail.

---

## 3. Vocabulary

The authoritative copy is `docs/vocabulary.md`. Use these words exactly; agents must not invent synonyms.

| Term | Meaning |
|---|---|
| **Operator** | The human. Describes items, provides inputs, reads the dashboard, directs agents. |
| **Item** | Anything the operator decides to track. The atomic unit of the system. An item is not typed by the framework; its meaning is given by its categories and its agent. |
| **Input** | Data attached to an item by the operator or fetched by an agent: files, numbers, URLs, API pulls, parameters. Every input is a record. |
| **Category** | A node in the category system. An item can belong to many categories. Categories can be nested (tree) and related to each other (graph edges). Tags are flat categories. |
| **Panel** | The content an asset agent produces for one item. A panel is one or more pages. |
| **Page / Subpage** | A unit of dashboard content. Pages have a stable address, a current version, and a version history. |
| **Face** | The framework-owned shell of the dashboard: layout, navigation, item index, category browser, history, agent browser, health. |
| **Developer agent** | A Claude Code session working in this repo. Builds the framework, writes asset agents, spawns and schedules temporal agents. |
| **Asset agent** | An agent (prompt + tools + code) responsible for one item or one class of items. Writes that item's panel. |
| **Temporal agent** | A scheduled, pre-instructed Claude Agent SDK session that wakes up, does a bounded job, writes records and pages, and exits. |
| **Run** | One execution of a temporal (or asset) agent. Has a start, an end, a status, a log, and a set of records it produced. |
| **Record** | Any stored fact: input, output, page version, run, log line, error, event. Timestamped, tagged, immutable. |
| **Snapshot** | The state of a page (or the whole dashboard) at a point in time. Derived from records; what "history" shows. |
| **Phase** | A unit of the roadmap. Each phase ends with something the operator can open and use. Run with `/roadmap`. |

---

## 4. Principles (non-negotiable until the operator says otherwise)

1. **Pivot around nothing.** The framework has no notion of asset class, asset family or market. The category system is the only structure, and it is data, not code.
2. **One face, flexible content.** The shell is stable and framework-owned. Page content is agent-owned and may be anything the content contract allows.
3. **Everything is a record.** No in-place mutation of meaningful state. Latest = pointer to newest version. History is a first-class feature, not a backup.
4. **Agents write, framework hosts.** Domain logic lives in agents. The framework provides storage, scheduling, rendering, observability, and nothing domain-specific.
5. **Observable by default.** Every run is logged, every error is captured, every integration has a health status, every page shows which run produced it and when.
6. **Date-addressable.** Any page, item or run can be asked "as of <date>". Agents and the operator refer to things by date and the system resolves it.
7. **Temporal agents are bounded and boring.** Wake, do one job, write records, exit. No long-lived agent processes. Anything stateful is in the database.
8. **The developer agent is a user of the framework, not a special case.** If spawning/scheduling an agent is awkward for the developer agent, it is awkward for everyone — fix the framework.

---

## 5. Actors and responsibilities

### Operator
- Defines the category system.
- Creates items and attaches inputs.
- Reviews pages, directs analyses, approves changes to this document and to the roadmap.
- Final say on stack and scope.

### Developer agent
- Builds and maintains the framework code.
- Writes asset agents (prompt, tools, page templates) when the operator describes a new item or class of items.
- Spawns temporal agents: defines their instruction, schedule, inputs, and output contract; registers them with the scheduler.
- Keeps `HANDOFF.md`, `ROADMAP.md` and `docs/adr/` current.

### Asset agents
- Own a panel. Produce pages that conform to the content contract (§8).
- May be run once (by the developer agent) or repeatedly (as a temporal agent).

### Temporal agents
- Pre-instructed. Instruction lives in the repo (`agents/temporal/<name>/`), versioned.
- Run by the framework's scheduler using the Claude Agent SDK.
- Output: records and page versions. Never anything else.

### Framework
- Record store, page registry, category system, scheduler/runner, observability, the face.

---

## 6. Architecture

Six parts. Build them in this order; each is usable on its own.

```
┌─────────────────────────────────────────────────────────────┐
│  FACE  (web shell: nav, item index, categories, history,     │
│         agent/run browser, health)                            │
├─────────────────────────────────────────────────────────────┤
│  PAGE REGISTRY   (page addresses, versions, latest pointers,  │
│                   content contract, renderer)                 │
├──────────────────┬──────────────────────────────────────────┤
│  CATEGORY SYSTEM │  RECORD STORE  (inputs, outputs, runs,    │
│  (tree+graph,    │   logs, events — append-only, tagged,     │
│   operator-owned)│   date-addressable)                       │
├──────────────────┴──────────────────────────────────────────┤
│  AGENT RUNTIME  (scheduler, runner, Claude Agent SDK host,   │
│                  run lifecycle, instruction registry)         │
├─────────────────────────────────────────────────────────────┤
│  OBSERVABILITY  (liveness, integration health, run status,   │
│                  error capture, run logs → records)           │
└─────────────────────────────────────────────────────────────┘
```

### 6.1 Record store
The heart. Append-only table(s) of records. Each record: `id`, `kind`, `item_id?`, `run_id?`, `created_at`, `tags[]`, `payload` (JSON), `blob_ref?` (for files). Postgres. Queries the whole system needs: "records of kind K for item I as of date D", "all records produced by run R", "all records tagged T between D1 and D2".

### 6.2 Category system
Nodes and edges, operator-owned. A node has a name, optional parent (tree), and arbitrary typed edges to other nodes (graph). Items attach to nodes. The face renders this as a browser; agents can read it to decide what to do.

### 6.3 Page registry
A page has an **address** (stable path, e.g. `/items/<item>/overview`, `/items/<item>/simulations/monte-carlo`), a **latest version**, and a **history** of versions. A version is a record. Work in progress is a draft outside the chain, and a page changes only on top of the version the writer saw (`adr/0009`). The registry resolves `address @ date` → the newest version whose data date (`as_of`) is on or before that date; for equal data dates, the last written wins. **Latest** is the newest data date too, so a backfill never displaces current content.

### 6.4 Agent runtime
- **Instruction registry**: every agent's instruction (system prompt, tools, input spec, output contract) lives in the repo under `agents/`, versioned by git. The runtime references instructions by name + git sha.
- **Scheduler**: cron-like, stored in the database (`schedules` table). The developer agent creates schedules via the CLI/API, not by editing crontabs.
- **Runner**: picks due schedules, starts a Claude Agent SDK session with the instruction, gives it scoped tools (read records, write records, write page versions, read categories), captures everything it does as records, marks the run done/failed.
- **Run lifecycle**: `scheduled → running → succeeded | failed | timed_out`. Every state transition is a record.
- **Pinning**: `ganjine agent register` refuses uncommitted changes and pins the agent to the current commit. A run reads its instruction from that commit, so changing an agent means commit, then register again.
- **Runner**: `ganjine runner` checks every 30 seconds; cron is UTC. Missed firings collapse into one run, a schedule never overlaps itself, and a run abandoned by a dead process is marked `timed_out`.
- **Sessions**: all built-in tools are off, as are user settings and other MCP servers. A session's only tools are the framework tools its `tools.json` grants, each bound to that run.

### 6.5 Observability
- Liveness of the framework itself.
- Health of each integration (data sources, APIs, the Claude API) — last checked, last ok, last error.
- Run browser: every run, its status, duration, log, and the records/pages it produced.
- Error capture: any exception anywhere becomes a record tagged `error`.
- Exposed in the face and as a plain JSON endpoint so agents can read it too.

### 6.6 Face
The stable web shell. Framework-owned. Renders:
- Item index and category browser.
- Any page by address, with a "latest / as of date" switch and a version timeline.
- Agent and run browser.
- Health dashboard.
Page *content* is rendered from the content contract; the face never contains domain logic. The face is read-only, listens on loopback until auth arrives in Phase 5, and sends a content security policy that denies all network access to page content. Chart libraries are served from `node_modules`, never a CDN. `embed` blocks run in a sandboxed iframe with an opaque origin and no network. It answers only on loopback Host names, charts cannot load or link, and links leaving Ganjine show their host. Stored content is data at every layer: `adr/0005-triggers-and-trust-boundary.md`. Records are chained and signed, and verified on read: `adr/0006-signed-ledger.md`.

---

## 7. Data model

```
items        (id, name, created_at, meta jsonb)
categories   (id, name, parent_id?, meta jsonb)
category_edges (from_id, to_id, kind)
item_categories (item_id, category_id)
records      (id, kind, item_id?, run_id?, created_at, tags text[], payload jsonb, blob_ref?)
pages        (address PK, item_id?, latest_version_id)
page_versions (id, address, as_of, created_at, run_id?, content jsonb)   -- id is also a record id
agents       (name PK, kind: asset|temporal|developer, instruction_ref, meta)
schedules    (id, agent_name, cron, enabled, input jsonb, created_by, next_run_at, created_at)
runs         (id, agent_name, schedule_id?, created_at, started_at?, ended_at?, status, meta)
run_logs     (run_id, ts, level, message)                          -- also records
health       (component, status, checked_at, last_ok_at, last_error)
```

Rule: anything that matters is *also* a record, so the record store alone can reconstruct history. `records`, `page_versions` and `run_logs` are append-only, enforced by database triggers. Authoritative schema: `framework/migrations/`. Dates are UTC.

---

## 8. Page content contract

The authoritative copy is `docs/content-contract.md`. Summary:

Agents produce page content; the face renders it. The contract must be:
- Expressive enough for charts, tables, text, simulations and interactive views.
- Stable enough that old versions still render a year later.
- Simple enough that an agent can write it without a build step.

Anything over time is a `timeline` block, drawn by the face (`docs/charts.md`). Forecasts are records beside the data (`docs/forecasting.md`).

**Default (change via ADR if a better option appears):** a page version's `content` is a JSON document of typed **blocks** (`markdown`, `table`, `chart` with a declarative spec, `kv`, `embed` for a self-contained HTML/JS artifact stored as a blob, `ref` for a link to another page). Interactive views are `embed` blocks: sandboxed iframes rendering a stored HTML file. The face knows how to render each block kind; agents only emit blocks.

Each page version carries: `produced_by` (agent name + run id), `as_of` (the data date it reflects), `inputs_used` (record ids), `summary` (one line, for the timeline).

---

## 9. Temporal agents

A temporal agent is a folder:

```
agents/temporal/<name>/
  INSTRUCTION.md     # the system prompt, in full
  tools.json         # framework tools, page address prefixes, model, effort, timeout, turn and budget limits
  input.schema.json  # what the scheduler passes it
  output.md          # what it must produce (pages, record kinds)
  README.md          # why it exists, who created it, when
```

Lifecycle:
1. Developer agent writes the folder and commits it.
2. Developer agent registers it: `ganjine agent register temporal/<name>` and `ganjine schedule create --agent <name> --cron "..." --input '{...}'`.
3. `ganjine runner` wakes it on schedule. It reads what it needs via framework tools, writes records and page versions, exits.
4. Its run, log and outputs are visible in the face immediately.

Temporal agents never get shell, file or web access. They get only the framework tools `tools.json` grants: `read_records`, `write_record`, `write_page`, `read_categories`. Agents cannot write outside their page prefixes or forge framework record kinds.

---

## 10. Stack

Marked **Decided** / **Default** (reasonable choice, change with an ADR) / **Open** (needs the operator).

| Concern | Choice | Status |
|---|---|---|
| Name | Ganjine; CLI `ganjine` | Decided |
| Database | PostgreSQL (CNPG in k8s later; plain Postgres in Docker locally) | Decided |
| Agent sessions | Claude Agent SDK | Decided |
| Deployment target | Kubernetes, eventually; Docker Compose for local | Decided |
| Instruction storage | In-repo, git-versioned | Decided |
| Backend language | TypeScript throughout `framework/`, run directly by Node 23.6+ with no build step; `programs/` may use any language as separate processes. See `docs/adr/0001-stack-choice.md`. | Decided |
| Blob storage | Local disk behind an S3-shaped interface, content-addressed. See `docs/adr/0003-blob-storage.md`. | Decided |
| Face (web) | Server-rendered + small islands for interactive blocks; no heavy SPA until needed | Default |
| Chart spec for `chart` blocks | Vega-Lite | Default |
| Auth | None (single operator, loopback only) until Phase 5 | Default |

---

## 11. Repository layout

```
/
  HANDOFF.md            # this file — the spine
  ROADMAP.md            # phases, current phase, what "done" means
  CLAUDE.md             # points here; working conventions for Claude Code sessions
  AGENTS.md             # how a user's agent reports issues
  GOVERNANCE.md         # who decides, who can grant and revoke
  ganjine               # the CLI entry point
  .claude/commands/     # slash commands for Claude Code (/roadmap)
  docs/
    adr/                # architecture decision records, numbered
    vocabulary.md       # §3, authoritative
    content-contract.md # §8, authoritative
    content-contract.schema.json # the same contract as JSON Schema
    charts.md           # the standard chart and the data pipeline
    forecasting.md      # the forecaster protocol
  framework/            # the framework code (record store, registry, runtime, face)
  agents/
    developer/          # extra instructions for the developer agent itself
    asset/<name>/       # one folder per asset agent
    temporal/<name>/    # one folder per temporal agent
    forecasters/<name>/ # one folder per forecaster
  programs/             # analyses/simulations built on top; may be split out later
  deploy/               # docker-compose, k8s manifests
```

---

## 12. Roadmap

Each phase ends with something the operator can open and use. Status and checklists live in `ROADMAP.md`; this is the shape. Phases are executed with the `/roadmap` command (see `CLAUDE.md`).

**Phase 0 — Skeleton.**
Repo initialized. This document, `ROADMAP.md`, `CLAUDE.md`, `docs/`, first ADRs (stack choice, content contract). Empty `framework/`, `agents/`, `programs/` with READMEs. Docker Compose with Postgres. Nothing else.

**Phase 1 — Record store + categories + CLI.**
Migrations for §7. `ganjine item create`, `ganjine category ...`, `ganjine record put/get`, `ganjine page put/get --as-of`. Everything testable from the terminal. No web.

**Phase 2 — The face, read-only.**
Web shell showing items, categories, pages (latest + history + as-of), run browser (empty for now), health. Renders all block kinds of the content contract.

**Phase 3 — Agent runtime.**
Instruction registry, scheduler, runner using the Claude Agent SDK, scoped tools, run lifecycle, logs as records. First temporal agent: a trivial "heartbeat" that writes a page every hour. Run browser now live.

**Phase 4 — First real item.**
Operator describes one real asset. Developer agent writes its asset agent and a temporal agent that keeps its panel current. First real simulation/prediction page. This is the proof the framework works.

**Phase 5 — Hardening.**
Observability depth, error handling, k8s deploy, auth, backups, agent sandboxing review.

Later: multi-operator, external data connectors as first-class, agents that spawn agents, exporting programs out of the repo.

---

## 13. Working conventions for agents in this repo

- Read `HANDOFF.md` and `ROADMAP.md` before doing anything. Read `CLAUDE.md` for mechanics.
- Use the vocabulary in `docs/vocabulary.md`. Do not introduce new terms without adding them there.
- Any decision that would be hard to reverse gets an ADR in `docs/adr/` **before** implementation. Short is fine; existence is mandatory.
- Keep phases honest: do not start Phase N+1 work while Phase N is not usable by the operator. `/roadmap` enforces this.
- Every session ends by updating `ROADMAP.md` (what changed, what is next) and, if anything in this document became false, fixing it here.
- Do not reach for a framework-wide abstraction because one item needs it. Build it in the item's agent first; promote to the framework after the second item needs it.
- Prefer small, runnable increments over complete designs. The operator wants to open something after every phase.
- Never put domain knowledge (what a bond is, how a portfolio should be weighted) into `framework/`. It belongs in `agents/` or `programs/`.

---

## 14. Open questions (for the operator)

None open. Answers are recorded under **Decisions** in `ROADMAP.md`.

---

## 15. Appendix — instruction for the first agent

The skeleton files already exist. Open Claude Code in this folder and run:

```
/roadmap 0
```

That is the whole instruction. The command reads this document and `ROADMAP.md`, finishes Phase 0 (git init, expand the content contract into a JSON schema, fill in ADR 0001 with a proposal, commit), and stops with the open questions. Once you have answered them, `/roadmap 1` or `/roadmap 1 to 3`.
