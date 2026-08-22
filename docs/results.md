# Results

Results are published per experiment under `experiments/`. Each experiment folder contains the canonical report tables (`reports/`) and a README with setup, leaderboard, and caveats.

- Current experiment: `experiments/2026-08-gemini35-live-10p-highjudge/`
- Archived experiments: `experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/`, `experiments/2026-04-gemini-context-v2-archived/`

Primary score is raw mean penalty from the GEMBA-MQM-based evaluation. Lower is better.

## 2026-08 High-Judge Experiment: Notable Slices

All numbers below come from `experiments/2026-08-gemini35-live-10p-highjudge/reports/`. The unified 12-arm run carries over the full 10-participant row set of the 2026-08-20 high-judge publication (6,468 cells, translations *and* judgments byte-identical) and adds two fresh arms — Hy-MT2 7B and Gemma 4 12B QAT Q4 (1,296 cells translated and judged new) — for 7,764 cells total, all under the same high-effort `google/gemini-3.7-flash:batch` judge.

### Overall

- LLMs outperform traditional MT on multi-turn casual dialogue — best LLM 0.35 (Gemma 4 31B) vs. best MT Papago 2.70.
- Context helps: same Gemma 4 E4B QAT Q4 improves 31.5% with full history + policy (1.45 vs. 2.12 sentence-only, same high-effort judge; see `ablation/` appendix).
- Google Translate is competitive for en (1.22) and zh-Hans (2.49) but collapses on ja (13.49), driving its overall 5.73.
- Quantization costs quality for the small local model: Gemma 4 E4B fp16 1.35 → QAT Q4 1.58.
- New arms: Gemma 4 12B QAT Q4 is the strongest local arm overall (0.855, between DeepSeek V4 Flash and E4B fp16); dedicated MT model Hy-MT2 7B scores 1.86 — behind the Gemma locals, ahead of Papago, and with the highest context-misuse rate in the field (8.3%).

### By Target Language (common-cell)

- **English:** Gemma 4 31B best (0.082), ahead of Gemma 4 26B (0.197) and DeepSeek V4 Flash 0731 (0.361). Google 1.22 (competitive).
- **Japanese:** Gemma 4 31B best (0.493), Gemma 4 26B second (0.573). Google collapses to 13.49 (43 critical / 323 major) — majority of its overall penalty.
- **Simplified Chinese:** DeepSeek V4 Flash 0731 best of all systems (0.329). Google 2.49 (competitive).

### Audio-Native ASR / CER

- Current-utterance CER (strict definition, see `reports/ASR-CER-analysis-high.md`): mean 0.112, median 0.077, p90 0.190, trim-exact 11.1% (recomputed from this run's `translation-provider-details.jsonl`; values identical to the previous publication).
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

- 7,776 expected cells, 7,764 normalized, 7,759 scored. `benchmarkValid: false` due to 12 unresolved translation failures (8 Live session timeouts across `ctx3-single-use-pragmatic_intent_resolution-002/003/004` + 4 historical DeepL en/zh) and 5 judge failures (2 Live cells, DeepL en/zh, MiLMMT X0 en — all invalid MQM annotations from the batch judge, inherited unchanged from the carried arms). The common-cell ordering matches the full ordering.
- Judge cost recorded in the merged artifacts: $7.74 (`gemini-3.7-flash:batch` with high reasoning effort via OpenRouter; includes the inherited batch jobs plus the two fresh arms' sessions). Translation costs were not tracked.

## Archived Experiments

- **2026-08 issue-1** — the MiLMMT / Gemma 4 E4B experiment that precedes this run is archived at `experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/`. Its 12-participant grid (including the Gemma 4 E4B QAT Q2 and MiLMMT X2 arms dropped from the current run) is the source of the reused rows here. Its per-language and per-phenomenon analysis is preserved in its README and `reports/`.
- **2026-04** — the original context-v2 experiment is archived at `experiments/2026-04-gemini-context-v2-archived/` (different prompt and judge; not directly comparable).

## Cross-Experiment Comparability

All experiments share the dataset but differ in translation prompt, judge model, judge prompt format, and participant set. In addition, this run *reuses* the rows of its 10 carried arms (translations and judgments) from the 2026-08-20 high-judge publication; only Hy-MT2 7B and Gemma 4 12B QAT Q4 are fresh measurements. Do not treat the carried rows as fresh measurements, and do not mix scores from different experiments in one table or chart.
