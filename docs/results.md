# Results

Results are published per experiment under `experiments/`. Each experiment folder contains the canonical report tables (`reports/`) and a README with setup, leaderboard, and caveats.

- Current experiment: `experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731/`
- Archived experiment: `experiments/2026-04-gemini-context-v2/`

Primary score is raw mean penalty from the GEMBA-MQM-based evaluation. Lower is better.

## 2026-08 Experiment: Notable Slices

All numbers below come from `experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731/reports/`. Common-cell tables restrict to the 625 sample-cells scored OK for every system.

### By Target Language (common-cell)

- **English:** Gemma 4 31B best (0.090), ahead of Gemma 4 26B (0.201) and DeepSeek V4 Flash 0731 (0.387).
- **Japanese:** Gemma 4 31B best (0.462), Gemma 4 26B second (0.571). Google Cloud Translation Basic is weakest (13.57).
- **Simplified Chinese:** DeepSeek V4 Flash 0731 best of all systems (0.327), ahead of Gemma 4 26B (0.439) and Gemma 4 31B (0.444).

### Local Deployment Arms (Gemma 4 E4B on llama.cpp)

- fp16: 1.311, QAT Q4: 1.639, QAT Q2: 9.460. Aggressive Q2 quantization collapses quality (31 critical errors on English alone).
- fp16 and QAT Q4 never misuse context (0% misuse rate); QAT Q2 both misses (12.0%) and misuses (12.1%) context.

### MiLMMT 46-4B Prompt Regimes

- X0 native sentence-level prompt: 2.949 overall, misses required context on 24.1% of samples.
- X2 PuriPuly policy prompt (completion mode): 11.500 overall — worst system — and misuses context on 25.5% of samples. The conversational-context policy prompt makes this completion-style MT model over-apply context.
- MiLMMT X2 is worst on 8 of 10 phenomena (worst: register carryover 15.88, sense disambiguation 15.78).

### Commercial Services

- Papago Web (2.801) leads DeepL (4.107) and Google Cloud Translation Basic (5.810).
- Context behavior is the expected sentence-MT pattern: Papago misses required context 24.5% / misuses 0%; Google Basic misses 27.3%; DeepL misses 16.3% / misuses 4.7%.

### Context Turn Count

Performance degrades as prior-context length grows (1 → 3 turns) for every system. The top three (Gemma 4 31B, Gemma 4 26B, DeepSeek 0731) stay on top at every turn count.

### Run Validity and Cost

- 7,128 expected cells, 7,124 normalized, 7,105 scored. `benchmarkValid: false` due to 19 judge failures (17 on Gemma 4 E4B QAT Q2 en/ja) and 4 unresolved historical DeepL translation failures. The common-cell ordering matches the full ordering.
- Judge cost: $6.64 (`gemini-3.7-flash:batch` via OpenRouter). Translation costs were not tracked for this run.

## Cross-Experiment Comparability

The two experiments share the dataset but differ in translation prompt, judge model, judge prompt format, and participant set. In particular, Gemma 4 26B A4B scored 0.813 in 2026-04 and 0.403 in 2026-08; treat the change as a new measurement under a different setup, not as model drift. Do not mix scores from the two experiments in one table or chart.
