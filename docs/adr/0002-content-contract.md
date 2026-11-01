# ADR 0002 — Page content contract: typed JSON blocks

- Status: **accepted**
- Date: 2026-11-01

## Context

Agents must produce dashboard content that the framework can render today and still render unchanged in a year, without a build step, and with room for charts, tables, simulations and interactive views.

## Decision

A page version's content is a JSON envelope (`contract_version`, `address`, `as_of`, `produced_by`, `inputs_used`, `summary`) containing an ordered list of typed **blocks**: `markdown`, `kv`, `table`, `chart` (Vega-Lite), `embed` (sandboxed HTML blob), `ref`. The face owns one renderer per block kind. Agents emit JSON only. Details in `docs/content-contract.md`.

## Alternatives considered

- **Agents emit HTML directly.** Fast to start, impossible to keep stable or safe; every page would be a one-off.
- **A component DSL (MDX/React).** Expressive, but needs a build step and a JS toolchain in every agent.
- **Markdown only.** Not enough for charts and interactive views.

## Consequences

- New visual capability = new block kind + renderer + bump of `contract_version`, never a change to existing kinds.
- Interactive views are isolated in `embed` blocks; they are client-side only (operator, 2026-11-01).
- Old page versions remain renderable as long as the face keeps renderers for old contract versions.
