# Charts

**Core rule: anything over time is a `timeline` block.** Agents give data, and the face draws it. Every chart in Ganjine is a timeline, a simplified timeline, or a `chart` block that follows the rules below. Decision: `adr/0010-timeline-chart-standard.md`.

## The pipeline

Every chart over time comes from the same three steps:

1. **Fetch** the history of everything you want to compare. Write it as a series: `{ "source": "...", "values": [{ "date": "2026-11-01", "series": "name", "value": 123.4 }] }`. Fix splits and capital changes first, and check the result against a second source.
2. **Store** it. This keeps the data and asks the forecaster in one step, and prints both ids:

   ```
   ./ganjine series put --item <item> --tag <tag> --file series.json --steps 52 --exclude Benchmark
   ```

   `--exclude` leaves reference lines out of the forecast. A forecast failure never stops the data being stored.
3. **Show** it in a page with `"contract_version": 2`, and list both ids in `inputs_used`:

   ```json
   { "kind": "timeline", "title": "Say what the chart shows",
     "data": { "record": "<series id>" },
     "forecast": { "record": "<forecast id>" },
     "reference": ["Benchmark"] }
   ```

## What a timeline shows

| Part | Meaning |
|---|---|
| Past window | Solid lines, starting at 100 so different prices compare. Pick 1 month to 2 years. |
| Vertical line | The page's `as_of`. |
| Next window | Always there, and shaded. Pick 1 month to 1 year. |
| Dotted line and band | The forecast, starting where the solid line ends. The band is its 10% to 90% range. |
| Dashed grey line | A `reference`, such as a benchmark. |
| Thin dotted vertical line | A `marker`: a dated moment, such as an event or a decision. Its label sits at the top, and `detail` shows on hover. |
| Label in the next window | `Forecast: <model>`, `Forecast: <model>, to <date>`, or `No forecast`. |

## Changing it

- **Simpler:** one option in `past` or `next` removes that picker: `"past": { "options": [365] }`.
- **Real values:** `"rebase": false` shows values as they are, and `value_title` names the axis.
- **Dated moments:** `"markers": [{ "date": "2026-11-15", "label": "Short text", "detail": "Longer text" }]`. Keep labels short, and use a few.
- **Something new:** add an optional field to the block, here and in the schema. Don't write a one-off spec.

Keep to eight series or fewer. More than that needs another chart, not more colors.

## A `chart` block

Use one only for what is not time: a distribution, a ranking, a scenario comparison. It takes the face's theme. Keep to one axis, thin marks, a legend for two or more series, and colors that follow the entity, never its rank. Put the conclusion in the title.
