# Results

Primary score is raw mean penalty from the GEMBA-MQM-based evaluation. Lower is better.

## Overall Leaderboard

See `reports/leaderboard.overall.csv` for the machine-readable table.

The best fully valid context-aware rows are Gemini 3.1 Flash-lite (`0.573`), Gemini 3 Flash (`0.596`), Gemma 4 26B A4B (`0.813`), Qwen 3.5 Plus (`0.958`), and DeepSeek V4 Flash (`1.025`).

DeepL context (`4.963`) and DeepL no-context (`5.717`) are reuse-only partial rows with `644/648` valid cells. They are included for comparison but are not complete benchmark runs.

## Context-Aware Versus No-Context Baselines

Paired context/no-context rows show that context helps on this benchmark:

- Gemma 4 26B: context `0.813` versus no-context `1.265`, a penalty reduction of `0.452`.
- DeepSeek V4 Flash: context `1.025` versus no-context `1.647`, a penalty reduction of `0.622`.
- Average of those paired rows: context `0.919` versus no-context `1.456`, a penalty reduction of `0.537`.

On context-use samples, the paired average was context `0.880` versus no-context `1.779`. On context-ignore samples, no-context baselines were lower on average, which shows that irrelevant context can also be harmful if a system overuses it.

## LLM Rows Versus Commercial Context-Blind Services

The six context-aware LLM rows averaged about `1.027` mean penalty, compared with Google Cloud Translation Basic at `5.998` and DeepL no-context at `5.717` as a reuse-only partial row (`644/648` valid cells). The about-seven-times comparison is based on Gemma 4 26B A4B (`0.813`): Google Basic's measured penalty was `7.4x` higher (`5.998 / 0.813`), and DeepL no-context's measured penalty was `7.0x` higher (`5.717 / 0.813`). This is lower measured error penalty on this benchmark, not seven times better general translation quality.
