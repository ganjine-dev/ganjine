# Page content contract

Authoritative. `HANDOFF.md §8` summarizes this. Decision recorded in `adr/0002-content-contract.md`. The machine-readable twin is `content-contract.schema.json` (JSON Schema 2020-12); the two must change together.

Agents produce page content; the face renders it. Agents never produce HTML for the face directly (except inside an `embed` block, which is sandboxed).

## Requirements

- Expressive enough for text, tables, charts, key/value summaries, simulations and interactive views.
- Stable: a page version written today must render unchanged in a year. Breaking changes to this contract need a new `contract_version` and a renderer that still handles the old one.
- Writable by an agent without a build step: plain JSON.

## Page version

```
{
  "contract_version": 1,
  "address":     "/items/<item>/overview",
  "as_of":       "2026-11-01",            // the data date this content reflects
  "produced_by": { "agent": "<name>", "run_id"?: "<id>" },
  "inputs_used": ["<record id>", ...],    // may be empty
  "summary":     "one line, shown in the version timeline",
  "blocks":      [ <block>, ... ]         // at least one
}
```

`run_id` is omitted only when a page version is written outside a run (for example `ganjine page put` from a terminal).

## Block kinds (v1)

Blocks are flat: `kind` and the fields below sit side by side on one object.

| kind | fields | notes |
|---|---|---|
| `markdown` | `{ "text": "..." }` | CommonMark + tables. No raw HTML. |
| `kv` | `{ "items": [ { "key": "...", "value": "...", "unit"?: "...", "delta"?: number } ] }` | Summary tiles. `value` is a display string, already formatted. |
| `table` | `{ "columns": [ { "name", "type": "string\|number\|date" } ], "rows": [[...], ...] }` or `{ "columns": [...], "record": "<id>" }` | Rendered with sort. Exactly one of `rows` or `record`; large tables are records referenced by id, not inlined. A referenced record holds `{ "rows": [[...], ...] }` in its payload. Cells are string, number or null. |
| `chart` | `{ "spec": <Vega-Lite spec>, "data"?: [ {...}, ... ] \| { "record": "<id>" } }` | Declarative only. A referenced record holds `{ "values": [ {...}, ... ] }` in its payload. A spec must not fetch remote data (`data.url`): history has to render from what Ganjine stores. |
| `embed` | `{ "blob": "<blob ref>", "height"?: number }` | Self-contained HTML/JS file rendered in a sandboxed iframe. Blob refs are `blob:sha256:<hex>` (`adr/0003-blob-storage.md`). Client-side only: no network, no calling back into the framework. Everything it needs is inside the file, so it still renders in a year. |
| `ref` | `{ "address": "/..." , "as_of"?: "<date>" }` | Link to another page, optionally pinned to a date. |

## Block kinds added in v2

A page with `"contract_version": 2` can use everything above, and:

| kind | fields | notes |
|---|---|---|
| `timeline` | `{ "data": { "record": "<id>" }, "forecast"?: { "record": "<id>" }, "reference"?: ["<series>"], "value_title"?: "...", "rebase"?: false, "markers"?: [{ "date", "label", "detail"? }], "past"?: { "options": [days], "value": days }, "next"?: { "options": [days], "value": days } }` | **The standard chart for anything over time.** `data` is a series record, `forecast` a forecast record for it. The face draws it. One option in `past` or `next` removes that picker. See `charts.md`. |

Every block may carry `"id"` (stable within the page, for anchors) and `"title"`.

Version 1 pages keep rendering as they are. `timeline` is refused in a version 1 page.

## Example

```json
{
  "contract_version": 1,
  "address": "/items/example/overview",
  "as_of": "2026-11-01",
  "produced_by": { "agent": "example-refresh", "run_id": "run-1" },
  "inputs_used": ["rec-1"],
  "summary": "Value up 1.2% on the day",
  "blocks": [
    { "kind": "kv", "items": [{ "key": "Value", "value": "1,204", "unit": "EUR", "delta": 1.2 }] },
    { "kind": "markdown", "text": "Up on the day." },
    {
      "kind": "table",
      "title": "Recent values",
      "columns": [{ "name": "date", "type": "date" }, { "name": "value", "type": "number" }],
      "rows": [["2026-10-31", 1190], ["2026-11-01", 1204]]
    },
    {
      "kind": "chart",
      "id": "value-history",
      "spec": { "mark": "line", "encoding": { "x": { "field": "date", "type": "temporal" }, "y": { "field": "value", "type": "quantitative" } } },
      "data": { "record": "rec-1" }
    },
    { "kind": "embed", "blob": "blob:sha256:9f2c", "height": 480, "title": "Simulation" },
    { "kind": "ref", "address": "/items/example/simulations/monte-carlo", "as_of": "2026-10-01" }
  ]
}
```

## Rules for agents

- Put the conclusion first: the first block of a page should be a `kv` or short `markdown` that says what changed.
- Reference large data by record id; do not inline more than a few hundred rows.
- `as_of` is the data date, not the run time. A run at 03:00 on the 2nd that processes the 1st's close writes `as_of: <the 1st>`.
- `inputs_used` must list every record the content depends on, so history can explain itself.

## What the schema cannot check

Row width against `columns`, Vega-Lite validity, `data.url` inside nested views, and the existence of referenced records, blobs and pages. `ganjine page put` checks row width and that records and blobs exist. The face blocks all chart network access by content security policy, so a chart that tries to fetch data draws empty. It also marks a `ref` to a missing page, and renders a block it cannot draw as an error in place of that block, leaving the rest of the page intact.
