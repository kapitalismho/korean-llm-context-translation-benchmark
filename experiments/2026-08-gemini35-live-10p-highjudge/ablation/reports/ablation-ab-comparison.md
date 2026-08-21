# Context Ablation — A vs B (high reasoning judge)

- Run: ablation-ab-highjudge-20260820 (A/B only)
- Judge: google/gemini-3.7-flash:batch (high reasoning effort)
- Model: gemma-4-E4B-it-qat-UD-Q4_K_XL (llama.cpp, local)
- Dataset: gemba-mqm-context-v1 (216 cases x 3 languages)
- Condition A: sentence only (no context)
- Condition B: policy + full history (production prompt)

## Headline

| Condition | Mean penalty (lower is better) |
|---|---|
| A — sentence only | 2.118 |
| B — policy + history | 1.452 |
| Improvement | 31.5% |

Paired comparison (same case + language): 642 pairs.
- A better: 134 | B better: 236 | equal: 272

## By context expectation

| Expectation | A mean | B mean | n |
|---|---|---|---|
| use | 2.310 | 1.509 | 432 |
| ignore | 1.724 | 1.333 | 210 |

## By language

| Language | A mean | B mean | n |
|---|---|---|---|
| en | 1.850 | 0.874 | 214 |
| ja | 2.168 | 1.794 | 214 |
| zh-Hans | 2.336 | 1.687 | 214 |

## By turn count

| Turns | A mean | B mean | n |
|---|---|---|---|
| 1 | 1.722 | 0.995 | 216 |
| 2 | 2.000 | 1.139 | 216 |
| 3 | 2.648 | 2.243 | 210 |
