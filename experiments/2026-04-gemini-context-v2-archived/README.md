# Experiment: Gemini Context v2 (2026-04) — archived

- **Run ID:** `gemba-mqm-context-v1-gemini-context-v2-expanded-nodeepl-api-20260429-011514` (plus two DeepL reuse runs)
- **Run date:** 2026-04-29
- **Benchmark config:** `data/benchmarks/gemba-mqm-context-v1-gemini-context-v2.json`
- **Dataset:** `gemba-mqm-context-v1` (fingerprint `9ab9e987…5110`)
- **Translation prompt:** `data/prompts/gemini-context-v2.md` ("VRChat Social Interpreter")
- **Judge:** GEMBA-MQM-context prompt set (JSON-output version, preserved in `judge-prompts/`), `gemini-3.1-pro-preview` on Vertex AI

This was the repo's original public benchmark run. The 2026-08 experiment uses the same dataset but a different prompt, judge model, and judge prompt format — scores are **not directly comparable** across the two experiments.

## Leaderboard

Primary score: raw mean penalty. Lower is better.

| Rank | System | Mean penalty | Samples | Caveat |
| ---: | --- | ---: | ---: | --- |
| 1 | Gemini 3.1 Flash-lite | 0.573 | 648 | Fully valid |
| 2 | Gemini 3 Flash | 0.596 | 648 | Fully valid |
| 3 | Gemma 4 26B A4B | 0.813 | 648 | Fully valid |
| 4 | Qwen 3.5 Plus | 0.958 | 648 | Fully valid |
| 5 | DeepSeek V4 Flash | 1.025 | 648 | Fully valid |
| 6 | Gemma 4 26B A4B, no-context baseline | 1.265 | 648 | Fully valid |
| 7 | DeepSeek V4 Flash, no-context baseline | 1.647 | 648 | Fully valid |
| 8 | Qwen 3.5 Flash | 2.198 | 648 | Fully valid |
| 9 | DeepL, context | 4.963 | 644 | Reuse-only partial row |
| 10 | DeepL, no context | 5.717 | 644 | Reuse-only partial row |
| 11 | Google Cloud Translation Basic | 5.998 | 648 | Fully valid |

## Key Findings

- LLM systems with conversational context beat conventional commercial translation services in Korean multi-turn settings.
- Within LLMs, using conversational context improved quality over no-context baselines (paired penalty reduction 0.45–0.62).
- Caveat: the judge was Gemini 3.1 Pro, which may have favored Gemini/Gemma-family systems; DeepL rows were reuse-only partial rows.

## Files

- `reports/` — public result tables (leaderboards, context behavior, run summary with provenance)
- `docs/results.md` — detailed result analysis as originally published
- `judge-prompts/` — the JSON-output judge prompt version this run used (the live `data/judge-prompts/gemba-mqm-context-v1/` has since moved to the upstream text-annotation format)
- `leaderboard.png` — ranking chart as originally published

Reproduction command is preserved in the git history of `docs/reproducibility.md` (see commit history before 2026-08), or derive it from `reports/run-summary.json`.
