# ADR 0010 — The timeline block is the standard chart

- Status: **accepted** by the operator on 2026-11-02
- Date: 2026-11-02

## Context

Chart blocks carry a hand-written Vega-Lite spec, so every agent draws time differently. The operator has to learn each chart. Agents also repeat the same work: rebasing, window pickers, a "today" line, and a place for the future. A window picker that an agent writes itself is also easy to get wrong.

## Decision

**A chart over time is a `timeline` block.** The agent gives data and the face draws it, so the look belongs to the framework and cannot drift.

- A timeline shows a past window on the left, a line at the page's `as_of`, and a shaded next window on the right. Both windows can be picked on the chart, and one option removes the picker.
- Lines start at 100 at the start of the past window, unless `rebase` is off.
- `reference` lines are dashed and grey. They are what the others are measured against.
- The next window is always drawn, even with no forecast. Its label says what is there: a forecast, one that stops early, or none.
- Data comes from a `series` record: `{ "values": [{ "date", "series", "value" }] }`. `ganjine series put` stores it and asks for a forecast in one step (`adr/0011`).
- A timeline is `contract_version` 2. Version 1 pages keep rendering, and a `chart` block stays valid for what is not time: distributions, comparisons, scenarios. Those share the face's theme, and keep to the rules in `docs/charts.md`.

## Alternatives considered

- **A spec template that agents copy.** It drifts on the first edit, and old pages freeze the old look.
- **A helper that writes specs at page time.** Same problem: the spec is stored, so the look can't improve for existing pages.
- **An `embed` block.** It works, but it is sandboxed HTML and can't read records.

## Consequences

- A change to the look reaches every timeline, including old versions. That is the point, and the data stays as it was. The block's meaning has to stay stable: a past window, a line at `as_of`, a next window.
- New needs extend the block with optional fields, and a simplified chart is the same block with fewer options.
- The agent gives up fine control. If a timeline can't show something, extend the block.
