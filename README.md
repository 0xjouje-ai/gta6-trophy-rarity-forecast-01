[![make.fun](https://make.fun/badge.svg)](https://make.fun)
[![make.fun bounty](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/badge.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
[![Built with AI agents](https://make.fun/badge-ai.svg)](https://make.fun)

# GTA VI trophy rarity forecast

Forecast, for every trophy of Grand Theft Auto VI on PlayStation 5, its
earn rate on Exophase at 2026-11-26T00:00:00Z.

Bounty: https://make.fun/bounty/gta6-trophy-rarity-forecast-01

## Run

```sh
node main.ts
```

The program reads every `*.in` case file from `$MAKEFUN_INPUT_DIR`
(default `/input`) and writes one `*.out` forecast per case to
`$MAKEFUN_OUTPUT_DIR` (default `/output`). Node 22, standard library
only, no network, deterministic: two runs produce byte-identical output.

## How it forecasts

A trophy's earn rate is earners divided by players tracked. Both counts
grow roughly like power laws in the time since release, so each is close
to a straight line in log-log space against `ln(1 + hours since release)`.

Per trophy, the program:

1. Fits log earners and log players tracked as lines in that log-time,
   with 24-hour half-life recency weights.
2. Takes the net slope (earners slope minus players slope) — the slope
   of the log earn rate itself.
3. Averages a whole-history fit with a last-day fit, then shrinks the
   result toward the trophy tier's median slope.
4. Anchors on the last observed rate and extrapolates with the shrunk
   slope, damped by `1 / (1 + log-time gap to target)`, because earn
   rates saturate instead of compounding forever.
5. Spreads the five quantiles on the logit scale: a `0.45 * sqrt(days)`
   random walk plus the propagated slope standard error, floored at 0.8
   logit units, so a flat launch-night history still admits that
   Exophase can refresh its counts before the target.

A trophy already at 100% is forecast at 99.99. A trophy that cannot be
fitted still yields a valid persistence forecast instead of crashing.

## Files

- `main.ts` — the forecaster
- `package.json` — marks the package as an ES module
- `LICENSE` — MIT
