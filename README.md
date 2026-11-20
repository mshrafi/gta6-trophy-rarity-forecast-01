[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/mshrafi/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/mshrafi/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

# GTA VI Trophy Rarity Forecast

Forecasts how many GTA VI players earn each trophy in week one, for the
[make.fun bounty](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

## Model

Exophase's trophy page only changes when Exophase refreshes its counts, so
a case's history is a staircase: long flat stretches, then a jump at each
refresh. The program detects which regime it is in:

- **Flat history** (one segment, as in the practice cases): no refresh has
  been seen yet, so one is due. The one refresh the house published dropped
  every non-100% rate to about a fifth of its pre-refresh value (launch
  night 638 players / 943 trophies earned → 04:30Z refresh 3,868 players /
  4,276 trophies; the non-100% rates summed 47.78 → 10.55). The forecast
  shifts the median down by that factor with a 0.6-logit spread.
- **Stepped history** (the final case): per trophy, a straight line is fit
  to the logit rate against ln(1 + hours since the first read), over the
  distinct refreshed levels (segments, preferring the last 24h), anchored
  on the last level and extrapolated to the target. Slopes are shrunk
  toward the cross-trophy median slope (empirical Bayes — every trophy
  shares the same dilution/progression forces). The spread combines the
  random-walk widening with horizon, the fit's residual (how jumpy the
  refreshes were) and the slope's extrapolation error. A trophy at ~100%
  (Gone Fishing) is forecast to stay there with a tiny spread.

Deterministic, stdlib only, no network, no clock. `node /bot/main.ts`
reads every `*.in` file in `$MAKEFUN_INPUT_DIR` (else `/input`) and writes
`/output/<id>.out` with exactly one key `trophies`, one row per trophy:
`{"id": n, "q": [q05, q25, q50, q75, q95]}`.

## Validation

The kit grades on the server only, so the practice loss was measured with
a local re-implementation of the exact pinball scorer from RULES.txt,
against a reconstruction of the practice answers from the published
refresh totals (3,868 players, 4,276 trophies earned). The reconstruction
is consistent with the house's own figures: it gives the house baseline
~1.51 loss, ~0.68-point typical miss and ~0 coverage, as stated in RULES.

| case | house baseline | this entry |
|---|---|---|
| practice p00/p01 (reconstructed answer) | ~1.51 | **0.13–0.17** across the plausible reconstruction range |
| synthetic 24h-ahead case, real Nov 20 live rates as the answer | 0.90 | **0.33** |
| synthetic 6.5h-ahead case, real Nov 20 live rates as the answer | 0.10 | **0.09** |

Practice answers are not published in the kit, so the practice figures are
estimates against the reconstruction, not official grades; the synthetic
figures use real live Exophase rates as the answer.
