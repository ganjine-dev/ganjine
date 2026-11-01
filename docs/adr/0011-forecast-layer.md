# ADR 0011 — The forecast layer: any forecaster, stored as data

- Status: **accepted** by the operator on 2026-11-02
- Date: 2026-11-02

## Context

The operator wants a prediction next to the fetched data in every chart, for every window, without a new call each time a chart opens. The model will change. It may produce nothing today, stop short of the horizon tomorrow, and be replaced by something custom later. Charts and pages must not depend on any of that.

The first engine is TimesFM. It needs Python and a heavy model, and `adr/0001` keeps the framework in TypeScript.

## Decision

**A forecaster is a fixed command behind a small JSON protocol, and its output is a record.**

- **Protocol.** Ganjine writes a request to the command's stdin and reads a response from its stdout (`docs/forecasting.md`). The request gives past values on a regular step and the future dates wanted. The response gives values for as many of those dates as the model can reach, with an optional low and high. Nothing else about the model crosses the line.
- **Forecast record.** Ganjine stores each answer as a `forecast` record that names its input record, so history can explain itself. A chart reads the record. Opening a chart never runs a model.
- **Longest horizon once.** One forecast covers the longest next window. Shorter windows show part of it.
- **Three outcomes, all normal.** `ok`, `partial` (stops early, or missing some series), and `none`. A missing forecaster, a crash, a timeout and bad output all become `none` with a reason. A forecast failure never stops data being stored.
- **Choosing a forecaster.** `agents/local/forecaster.json` names one, as `{ "name", "run": [...] }`. With no file, every forecast is `none`. The command is fixed, and nothing from a record reaches its arguments (`adr/0005`). Values reach it on stdin as data.
- **Upgrade.** A new model is a new command. `ganjine forecast run <record>` writes a newer forecast for the same data. Pages pin the forecast they used, so old versions stay as they were.
- **First engine.** `agents/forecasters/timesfm/` wraps TimesFM 2.5 in a Python script run by `uv`. It holds no domain knowledge.

## Alternatives considered

- **TimesFM 3.0.** Its weights are non-commercial. 2.5 is Apache-2.0, and 3.0 stays one command away if the operator accepts those terms.
- **A long-running model server.** It would start faster, but it's another process to keep alive. A forecaster can still be a thin client to one, so nothing here rules it out.
- **Running the model when a chart opens.** Slow, not repeatable, and it would give the face a way to start work from a read.
- **Calling a forecast a finding.** A forecast is a model's output on data, and a finding is a conclusion. They age differently.

## Consequences

- Python and `uv` are needed only by that one forecaster. The framework gains no dependency.
- A forecast is a model's guess, and it is shown as one: dotted, with its model named. It says nothing about wars, closures or sanctions unless they are in the data.
- A forecast is not advice. Ganjine shows it, and the operator decides.
- The model's weights download on first use, then run locally. No record leaves the machine.
