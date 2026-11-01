# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["timesfm[torch]>=3.0.2,<4"]
# ///
"""TimesFM 2.5 behind Ganjine's forecaster protocol. See docs/forecasting.md."""
import json
import sys

import numpy as np
import timesfm

CHECKPOINT = "google/timesfm-2.5-200m-pytorch"
MAX_CONTEXT = 1024
MAX_HORIZON = 512  # Past this the protocol's partial answer applies.
LOW, HIGH = 1, 9  # Quantile columns: mean, then 10% to 90%.


def main():
    request = json.load(sys.stdin)
    series = request["series"]
    horizon = min(len(request["future"]), MAX_HORIZON)
    # Each series keeps its own length. Positive values are forecast in logs, so a band can't go below zero.
    logs = [bool(s["values"]) and min(s["values"]) > 0 for s in series]
    inputs = [np.log(s["values"]) if log else np.array(s["values"], dtype=float) for s, log in zip(series, logs)]

    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(CHECKPOINT)
    model.compile(timesfm.ForecastConfig(
        max_context=MAX_CONTEXT,
        max_horizon=MAX_HORIZON,
        normalize_inputs=True,
        use_continuous_quantile_head=True,
        force_flip_invariance=True,
        infer_is_positive=False,
        fix_quantile_crossing=True,
    ))
    points, quantiles = model.forecast(horizon=horizon, inputs=inputs)

    def back(values, log):
        return [round(float(v), 6) for v in (np.exp(values) if log else values)]

    json.dump({
        "model": {"name": "timesfm", "version": "2.5"},
        **({"reason": f"stops at {MAX_HORIZON} steps"} if len(request["future"]) > MAX_HORIZON else {}),
        "series": [{
            "name": s["name"],
            "values": back(points[i], logs[i]),
            "low": back(quantiles[i, :, LOW], logs[i]),
            "high": back(quantiles[i, :, HIGH], logs[i]),
        } for i, s in enumerate(series)],
    }, sys.stdout)


if __name__ == "__main__":
    main()
