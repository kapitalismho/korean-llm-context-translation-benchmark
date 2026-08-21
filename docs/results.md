# Results

Results are published per experiment under `experiments/`. Each experiment folder contains the canonical report tables (`reports/`) and a README with setup, leaderboard, and caveats.

- Current experiment: `experiments/2026-08-gemini35-live-10p-highjudge/`
- Archived experiments: `experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/`, `experiments/2026-04-gemini-context-v2-archived/`

Primary score is raw mean penalty from the GEMBA-MQM-based evaluation. Lower is better.

## 2026-08 High-Judge Experiment: Notable Slices

All numbers below come from `experiments/2026-08-gemini35-live-10p-highjudge/reports/`. The run reuses the full 10-participant row set from the live-two-voice run (6,468 cells, including its 640 Gemini 3.5 Live Translate cells); every cell was newly judged by `google/gemini-3.7-flash:batch` with high reasoning effort.

### Overall

- **Gemini 3.5 Live Translate (audio-native, two voice) scores 3.723** — behind every text LLM arm and Papago (2.699), ahead of DeepL (3.914) and Google Cloud Translation Basic (5.731). Common-cell (631 cells): 3.685, same ordering.
- The gap to the text LLMs is large: Gemma 4 31B 0.353 / 26B 0.387 / DeepSeek 0731 0.571; even the small local Gemma 4 E4B arms (1.353–1.577) are 2.5× better.
- Error profile on the 638 scored Live cells: 14 critical / 325 major / 400 minor; `accuracy/mistranslation` (346) and `accuracy/addition` (122) dominate, consistent with an audio-native pipeline that must transcribe before translating.

### By Target Language (common-cell)

- **English:** Gemma 4 31B best (0.082), ahead of Gemma 4 26B (0.197) and DeepSeek V4 Flash 0731 (0.361). Live is weakest here (4.221, 6 of its 14 critical errors).
- **Japanese:** Gemma 4 31B best (0.493), Gemma 4 26B second (0.573). Live 3.512.
- **Simplified Chinese:** DeepSeek V4 Flash 0731 best of all systems (0.329). Live's strongest language (3.329).

### Audio-Native ASR / CER

- Current-utterance CER (strict definition, see `reports/ASR-CER-analysis-high.md`): mean 0.112, median 0.077, p90 0.190, trim-exact 11.1% (CER values reused from the v2-strict detail of the source run; penalties are the high-effort ones).
- CER correlates only weakly with quality penalty (r = 0.29, R² ≈ 0.08); context CER has no correlation (r = 0.03).
- Even in the cleanest CER bucket (CER ≤ 5%, 223 judged cells), Live's mean penalty is 2.991 — 2–8× above the text models. Transcription errors explain part of the quality gap, not all of it.
- Caveats: the CER analysis is unofficial, 3.1% of Live sessions carry a wrong `languageCode` label (Korean audio labeled `ja`/`en`, sometimes with a genuinely Japanese transcription), and the strict CER mean does not fall within a 5% band.

### Context Turn Count

Quality degrades as prior-context length grows (1 → 3 turns) for every system. Live: ctx1 2.944 → ctx2 3.326 → ctx3 4.947 (per-language and per-turn tables in `reports/leaderboard.by-context-turn-count*.json`).

### Context Ablation Appendix (Gemma 4 E4B QAT Q4)

`experiments/2026-08-gemini35-live-10p-highjudge/ablation/` isolates the context effect on one fixed local model (QAT Q4, local llama.cpp) under the same high-effort judge: sentence-only prompt (`neutral-context.md`) vs. the production prompt (policy + full history).

- A (sentence only) 2.118 vs. B (policy + history) 1.452 — a 31.5% improvement; paired (642 pairs): B better 236, A better 134, equal 272.
- The gap widens with context length (ctx1 0.995 → 1.722, ctx3 2.243 → 2.648) and holds in both `use` and `ignore` slices, i.e. context helps even when it should be rejected.
- A/B is only valid within this appendix: B is a fresh translation under the current prompt revision and must not be compared against the main leaderboard's Q4 row (previous revision).

### Run Validity and Cost

- 6,480 expected cells, 6,468 normalized, 6,463 scored. `benchmarkValid: false` due to 12 unresolved translation failures (8 Live session timeouts + 4 historical DeepL) and 5 judge failures (2 Live cells, DeepL en/zh, MiLMMT X0 en — all invalid MQM annotations from the batch judge). The common-cell ordering matches the full ordering.
- Judge cost: $7.13 (`gemini-3.7-flash:batch` with high reasoning effort via OpenRouter, 5 batch jobs). No translations were generated in this run; translation costs were not tracked.

## Archived Experiments

- **2026-08 issue-1** — the MiLMMT / Gemma 4 E4B experiment that precedes this run is archived at `experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/`. Its 12-participant grid (including the Gemma 4 E4B QAT Q2 and MiLMMT X2 arms dropped from the current run) is the source of the reused rows here. Its per-language and per-phenomenon analysis is preserved in its README and `reports/`.
- **2026-04** — the original context-v2 experiment is archived at `experiments/2026-04-gemini-context-v2-archived/` (different prompt and judge; not directly comparable).

## Cross-Experiment Comparability

All experiments share the dataset but differ in translation prompt, judge model, judge prompt format, and participant set. In addition, this run *reuses* all of its rows from the live-two-voice run: no new translations were generated, only the judge. Do not treat the reused rows as fresh measurements, and do not mix scores from different experiments in one table or chart.
