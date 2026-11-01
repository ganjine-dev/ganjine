# TimesFM forecaster

Wraps [TimesFM](https://github.com/google-research/timesfm) 2.5 behind `docs/forecasting.md`. It has no domain knowledge.

It takes any number of series, each with its own length, and forecasts each one alone, up to 512 steps. Series don't inform each other. A longer request gets a partial answer.

## Setup

Needs [uv](https://docs.astral.sh/uv/). Put this in `agents/local/forecaster.json`:

```json
{ "name": "timesfm-2.5", "run": ["uv", "run", "--quiet", "agents/forecasters/timesfm/forecast.py"], "timeout_ms": 1800000 }
```

The first run downloads PyTorch and the model, about 1 GB, so allow time on a slow line (`UV_HTTP_TIMEOUT=1800`). After that it works offline. Requests stay on this machine.

## Licenses

The code and the 2.5 weights are Apache-2.0, and they aren't in this repo. TimesFM 3.0 has a non-commercial license on its weights, so it isn't used here. Moving to it is a new forecaster, after reading those terms.
