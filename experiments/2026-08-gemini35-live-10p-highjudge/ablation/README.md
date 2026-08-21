# Appendix: Context Ablation — A (sentence only) vs B (policy + full history) on Gemma 4 E4B QAT Q4 (2026-08)

An appendix to the 2026-08 high-judge experiment: a single-model A/B ablation measuring the effect of context availability on translation quality. The model is fixed (`gemma-4-E4B-it-qat-UD-Q4_K_XL`, local llama.cpp); only the prompt condition changes. Both conditions are judged with the same high-effort judge as the main experiment, so the pair comparison is like-for-like.

- **Run ID:** `ablation-ab-highjudge-20260820`
- **Run date:** 2026-08-20
- **Benchmark config:** `data/benchmarks/gemba-mqm-context-v1-ablation.json`
- **Dataset:** `gemba-mqm-context-v1` (216 items × 3 target languages; the run was made against a development revision of `runtime.json` without the `relativeTimeLabel` field — source texts are byte-identical to the published runtime)
- **Conditions:**
  - **A — sentence only:** `data/prompts/neutral-context.md` — no context is sent to the model
  - **B — policy + full history:** `data/prompts/puripuly-translation-latest.md` (same revision `4a358267…` as the main experiment) — the full PuriPuly context policy with all prior turns
- **Judge:** GEMBA-MQM-context prompt set, `google/gemini-3.7-flash:batch` via the OpenRouter Batch API with `reasoning effort = high` (2 batch jobs)

## Headline

Primary score: raw mean penalty (GEMBA-MQM severity weights minor 1 / major 5 / critical 25). Lower is better. Same Gemma 4 E4B QAT Q4, same high-effort judge — paired comparison is like-for-like.

![Context ablation — sentence-only vs. policy + full history (Gemma 4 E4B QAT Q4)](assets/context-ablation-e4b-q4.png)

| Condition | Mean penalty | Scored | Paired win (n=642) |
| --- | ---: | ---: | --- |
| A — sentence only | 2.118 | 642 | 134 |
| B — policy + full history | 1.452 | 642 | 236 |
| **Δ (B − A)** | **−0.666 (−31.5%)** | — | **+102 (tie 272)** |

## Slices

By context expectation (`use` = context required, `ignore` = context is a false lead):

| Expectation | A mean | B mean | Δ | Δ% | n |
| --- | ---: | ---: | ---: | ---: | ---: |
| use | 2.310 | 1.509 | −0.801 | −34.7% | 432 |
| ignore | 1.724 | 1.333 | −0.391 | −22.7% | 210 |

By target language:

| Language | A mean | B mean | Δ | Δ% | n |
| --- | ---: | ---: | ---: | ---: | ---: |
| English | 1.850 | 0.874 | −0.976 | −52.8% | 214 |
| Japanese | 2.168 | 1.794 | −0.374 | −17.3% | 214 |
| Chinese Simplified | 2.336 | 1.687 | −0.649 | −27.8% | 214 |

By context turn count:

| Turns | A mean | B mean | Δ | Δ% | n |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1.722 | 0.995 | −0.727 | −42.2% | 216 |
| 2 | 2.000 | 1.139 | −0.861 | −43.1% | 216 |
| 3 | 2.648 | 2.243 | −0.405 | −15.3% | 210 |

## Caveats — read before citing this appendix

1. **A/B is only valid within this run.** Condition B is a fresh translation under the current prompt revision (`4a358267…`); the main experiment's Gemma 4 E4B QAT Q4 row (1.577) was generated under the previous revision (`792ed1aa…`) in its source run. Same model and same high-effort judge, but different prompt revision and sampling — do not compare B (1.452) directly against the main leaderboard row.
2. **12 missing cells.** `ctx3-dyadic-ignore-metadata_nonliteral_resistance-002/003` failed translation in both conditions (6 items × 2 languages × 2 conditions; same 2 items that timed out in the main experiment's Live sessions). Both conditions miss the same cells, so the paired comparison (642 pairs) is unaffected.
3. **Single model.** The ablation isolates the context effect on one local 4B model only; it is not a claim about larger models or commercial services (those rows in the main experiment are context-blind or reuse their own prompts).

## Files

- `translations.jsonl` — 1,284 cells (642 per condition)
- `translation-failures.jsonl` — 12 unresolved translation failures (2 items × 3 languages × 2 conditions)
- `judge-normalized.jsonl` / `judge-raw.jsonl` — normalized and raw judge outputs for all 1,284 cells
- `judge-events.jsonl` / `judge-failures.jsonl` — judge run events (no judge failures in this run)
- `reports/ablation-ab-comparison.md` — the A/B comparison summary
- `manifest.json` — run configuration (prompt paths rewritten to repo-relative locations; fingerprints unchanged)
