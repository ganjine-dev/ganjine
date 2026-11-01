# ADR 0001 — Backend language and runtime

- Status: **accepted** (operator, 2026-11-01)
- Date: 2026-11-01

## Context

Ganjine needs one backend that hosts the record store, page registry, category system, scheduler, runner and the face. The runner must start Claude Agent SDK sessions. The operator works daily across JVM (Spring Boot), TypeScript/Vue and Laravel/PHP. The Agent SDK ships for TypeScript (`@anthropic-ai/claude-agent-sdk`) and Python (`claude-agent-sdk`) only. It is the Claude Code harness as a library: built-in tools, MCP for custom tools, self-hosted. Deployment target is Kubernetes with CNPG Postgres.

What the framework actually does is modest: SQL over Postgres, a CLI, a server-rendered web shell, a cron loop, and one call site for the SDK. Domain code, including heavy analysis, lives in `agents/` and `programs/`, not here.

## Options

### 1. TypeScript throughout

- One language and one process for CLI, server, runner and the interactive islands in the face. Islands must be JS in every option; Vega-Lite is a JS library, so chart rendering and spec validation are native here.
- SDK native: scoped tools are functions in the same process, reading the same database layer.
- The content contract's JSON Schema maps directly to runtime validation and types.
- Against: weak numerics. Simulations in `programs/` will want Python regardless (see Consequences).
- Against: Node dependency churn, for a system that should still run unchanged in a year.

### 2. Python throughout

- One backend language, SDK native, and `programs/` can import framework code directly.
- Against: the face's islands are still JS, so this is really two languages with a build seam.
- Against: importing framework code from `programs/` is exactly the coupling `HANDOFF.md §4.4` forbids, so the main advantage is one we should not use.

### 3. JVM core + thin TS/Python runner sidecar

- Strongest typing and long-term stability for the core; Postgres tooling (Flyway, jOOQ) is excellent.
- Against: two languages and two deployables from day one, plus an internal protocol between them. Scoped tools live in the sidecar but need the core's data access, so they either go over that protocol or duplicate it.
- Against: the most code and slowest path to something the operator can open, for a framework whose job is hosting.
- Against: a single `ganjine` CLI on the JVM needs a native-image build or tolerates slow startup. The developer agent calls it constantly.

## Recommendation

**Option 1, TypeScript throughout**, on Node LTS, for everything in `framework/`. Keep dependencies few: a Postgres driver, plain SQL migrations, a server-side renderer, the Agent SDK. No ORM and no SPA framework.

Option 3 buys comfort at a real ongoing cost, and the framework is not hard enough to need it. Option 2's one real advantage conflicts with a principle. Option 1 is the only one that is actually a single language.

`programs/` is deliberately excluded from this choice: it may be Python or anything else, called as a process and exchanging data through records.

## Decision

Option 1, TypeScript throughout, as recommended.

## Consequences

- Phase 1 starts with a TypeScript `framework/`, with `ganjine` as its one entry point.
- Python analysis needs a process boundary. A temporal agent gets no unscoped shell (`HANDOFF.md §9`), so running a program must become a scoped tool granted through `tools.json`. That design belongs to Phase 3/4 and is not settled here.
- The SDK's built-in tools include Bash and file access. The runner turns them all off (verified with a hostile session in Phase 3: its only tool was the one granted). Review again in Phase 5.
- Reversal cost grows with each phase, but the database, the content contract and `agents/` are language-neutral. Only `framework/` would be rewritten.
