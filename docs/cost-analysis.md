# Cost Analysis

The cost table in `reports/cost-efficiency.csv` uses an app-usage assumption of `1,200` input tokens and `14.4` output tokens per translation. This reflects a context-heavy translation product where input context dominates cost.

## Quality-Weighted Cost

The public table reports:

```text
quality_weighted_cost = cost_per_1k_app_translations_usd × mean_penalty²
```

Lower quality-weighted cost is better. `value_index` normalizes the best row to `100`.

## Observations

- Gemini 3.1 Flash-lite had the best raw score among fully valid rows, but higher app-usage cost than several alternatives.
- Gemma 4 26B via OpenRouter had a strong score with an app-usage cost close to DeepSeek V4 Flash under the stated assumptions.
- Qwen 3.5 Flash was cheapest under the stated assumptions but had a much higher mean penalty.
- Input tokens dominate app-usage cost, so reducing prompt and context length matters more than optimizing the short target output.

Prices and model APIs can change. Treat this analysis as a dated reproducibility note, not a current pricing guarantee.
