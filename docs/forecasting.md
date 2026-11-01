# Forecasting

A forecaster is any command that reads one JSON request on stdin and writes one JSON response on stdout. Ganjine knows nothing else about it. Decision: `adr/0011-forecast-layer.md`.

## Choosing one

`agents/local/forecaster.json` names it. `GANJINE_FORECASTER` moves that file. With no file, every forecast is `none`.

```json
{ "name": "timesfm-2.5", "run": ["uv", "run", "--quiet", "agents/forecasters/timesfm/forecast.py"], "timeout_ms": 900000 }
```

`./ganjine forecast run <series record>` writes a new forecast for stored data, for instance after an upgrade. Pages keep the forecast they pinned.

## Request

```json
{
  "protocol": 1,
  "step": "week",
  "series": [
    { "name": "a", "dates": ["2026-10-02", "2026-10-09"], "values": [101.5, 103.2] },
    { "name": "b", "dates": ["2026-10-09"], "values": [12.1] }
  ],
  "future": ["2026-10-16", "2026-10-23"],
  "quantiles": [0.1, 0.9]
}
```

Any number of series, each with its own length. `values` sit on a regular step and end on the same date. `future` lists the dates wanted, as many as the caller asks for.

## Response

```json
{
  "model": { "name": "timesfm", "version": "2.5" },
  "series": [
    { "name": "a", "values": [104.1, 105.0], "low": [99.0, 98.2], "high": [110.3, 112.8] },
    { "name": "b", "values": [12.3] }
  ],
  "reason": "b: history too short"
}
```

Each `values[i]` answers `future[i]`. A forecaster can give less than was asked for:

| It gives | Ganjine stores |
|---|---|
| Every series, every date | `ok` |
| A shorter list, a `null`, or some series missing | `partial`, up to the first gap |
| No series or no values | `none` |
| A crash, a timeout, or anything off the protocol | `none`, with the reason |

`low` and `high` are optional. A band that doesn't hold the value is dropped. `reason` is optional free text, kept short, and shown as data only.

## Stored forecast

A `forecast` record names its input and the forecaster, so history can explain itself:

```json
{ "protocol": 1, "input": "<series record>", "step": "week", "from": "2026-10-16", "to": "2026-10-23",
  "forecaster": { "name": "timesfm-2.5", "model": { "name": "timesfm", "version": "2.5" } },
  "status": "partial",
  "series": [{ "name": "a", "status": "ok", "points": [{ "date": "2026-10-16", "value": 104.1, "low": 99.0, "high": 110.3 }] }] }
```

## Writing a forecaster

Keep it in `agents/forecasters/<name>/`, with no domain knowledge. A private one goes in `agents/local/`. Ganjine starts it from the repo root with fixed arguments. Requests hold operator data, so a forecaster that sends them off the machine has to say so in its README.
