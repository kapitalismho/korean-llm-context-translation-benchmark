# Results

Results are published per experiment under `experiments/`. Each experiment folder contains the canonical report tables (`reports/`) and a README with setup, leaderboard, and caveats.

- Current experiment: `experiments/2026-08-gemini35-live-two-voice/`
- Archived experiments: `experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/`, `experiments/2026-04-gemini-context-v2/`

Primary score is raw mean penalty from the GEMBA-MQM-based evaluation. Lower is better.

## 2026-08 Live Experiment: Notable Slices

All numbers below come from `experiments/2026-08-gemini35-live-two-voice/reports/`. The run reuses the 2026-08 issue-1 row set (7,124 cells) and adds 640 new Gemini 3.5 Live Translate cells; every row was judged by `google/gemini-3.7-flash:batch`.

### Overall

- **Gemini 3.5 Live Translate (audio-native, two voice) scores 4.033** — behind every text LLM arm and Papago (2.801), ahead of DeepL (4.107) and Google Cloud Translation Basic (5.810). Common-cell (617 cells): 3.976, same ordering.
- The gap to the text LLMs is large: Gemma 4 31B 0.333 / 26B 0.403 / DeepSeek 0731 0.606; even the small local Gemma 4 E4B arms (1.311–1.639) are 2.5× better.
- Error profile on the 638 scored Live cells: 19 critical / 337 major / 413 minor; `accuracy/mistranslation` (365) and `accuracy/addition` (121) dominate, consistent with an audio-native pipeline that must transcribe before translating.

### By Target Language (common-cell)

- **English:** Gemma 4 31B best (0.090), ahead of Gemma 4 26B (0.201) and DeepSeek V4 Flash 0731 (0.387). Live is weakest here (4.580, 7 of its 19 critical errors).
- **Japanese:** Gemma 4 31B best (0.462), Gemma 4 26B second (0.571). Live's best language (3.559).
- **Simplified Chinese:** DeepSeek V4 Flash 0731 best of all systems (0.327). Live 3.962.

### Audio-Native ASR / CER

- Current-utterance CER (strict definition, see `reports/ASR-CER-analysis.md`): mean 0.112, median 0.077, p90 0.190, trim-exact 11.1%.
- CER correlates only weakly with quality penalty (r = 0.36, R² ≈ 0.13); context CER has no correlation (r = 0.03).
- Even in the cleanest CER bucket (0–5% CER, 218 records), Live's mean penalty is 3.24 — 2–8× above the text models. Transcription errors explain part of the quality gap, not all of it.
- Caveats: the CER analysis is unofficial, 3.1% of Live sessions carry a wrong `languageCode` label (Korean audio labeled `ja`/`en`, sometimes with a genuinely Japanese transcription), and the strict CER mean does not fall within a 5% band.

### Context Turn Count

Quality degrades as prior-context length grows (1 → 3 turns) for every system. Live: ctx1 3.630 → ctx2 3.660 → ctx3 4.841 (per-language and per-turn tables in `reports/leaderboard.by-context-turn-count*.json`).

### Run Validity and Cost

- 7,776 expected cells, 7,764 normalized, 7,105 scored. `benchmarkValid: false` due to 12 unresolved translation failures (8 Live session timeouts + 4 historical DeepL) and 19 judge failures (17 carried over on Gemma 4 E4B QAT Q2 en/ja + 2 new Live cells). The common-cell ordering matches the full ordering.
- Judge cost: $7.17 (`gemini-3.7-flash:batch` via OpenRouter, 3 batch jobs). Translation costs were not tracked for this run.

## Archived Experiment (2026-08 issue-1)

The MiLMMT / Gemma 4 E4B experiment that precedes this run is archived at `experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/`. Its 7,128-cell grid is the source of the reused rows here; the run itself is fully valid except for the documented judge failures. Its per-language and per-phenomenon analysis is preserved in its README and `reports/`.

## Cross-Experiment Comparability

All experiments share the dataset but differ in translation prompt, judge model, judge prompt format, and participant set. In addition, this Live run *reuses* most of its rows from the issue-1 run: only the 640 Live cells are new. Do not treat the reused rows as fresh measurements, and do not mix scores from different experiments in one table or chart.
