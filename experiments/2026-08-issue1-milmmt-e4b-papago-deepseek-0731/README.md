# Experiment: Issue #1 — MiLMMT / Gemma 4 E4B local arms vs Papago, DeepSeek 0731 (2026-08)

- **Run ID:** `issue1-milmmt-e4b-papago-deepseek-0731-integrated-20260815-01`
- **Run date:** 2026-08-15
- **Benchmark config:** `data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json`
- **Dataset:** `gemba-mqm-context-v1` (fingerprint `9ab9e987…5110`, identical to the 2026-04 experiment)
- **Translation prompt:** `data/prompts/puripuly-translation-latest.md` (all chat participants; MiLMMT arms use their own prompt files)
- **Judge:** GEMBA-MQM-context prompt set, `google/gemini-3.7-flash:batch` via the OpenRouter Batch API (2 batch jobs)
- **Provenance:** fork-and-merge run — 5,828 translations reused from `issue1-milmmt-e4b-20260815-e4b-t1-judge`, 1,296 imported (papago-web 648, deepseek-v4-flash-0731 648), missing cells judged fresh. See `fork-prepared.json`.

The 2026-04 experiment used a different prompt (`gemini-context-v2.md`), a different judge model (`gemini-3.1-pro-preview`), and a JSON-output judge prompt format. Scores from the two experiments are **not directly comparable**.

## Leaderboard

Primary score: raw mean penalty (GEMBA-MQM severity weights minor 1 / major 5 / critical 25). Lower is better.

| Rank | System | Mean penalty | Scored samples | Note |
| ---: | --- | ---: | ---: | --- |
| 1 | Gemma 4 31B (OpenRouter) | 0.333 | 648 | Fully valid |
| 2 | Gemma 4 26B A4B (OpenRouter) | 0.403 | 648 | Fully valid |
| 3 | DeepSeek V4 Flash 0731 (OpenRouter) | 0.606 | 648 | Fully valid |
| 4 | Gemma 4 E4B fp16 (llama.cpp, local) | 1.311 | 647 | 1 judge failure |
| 5 | Gemma 4 E4B QAT Q4 (llama.cpp, local) | 1.639 | 648 | Fully valid |
| 6 | Papago Web | 2.801 | 648 | Context-blind |
| 7 | MiLMMT 46-4B X0 native prompt | 2.949 | 648 | Sentence-level prompt, context-blind |
| 8 | DeepL API | 4.107 | 643 | 4 unresolved + 1 judge failure |
| 9 | Google Cloud Translation Basic | 5.810 | 648 | Context-blind |
| 10 | Gemma 4 E4B QAT Q2 (llama.cpp, local) | 9.460 | 631 | 17 judge failures |
| 11 | MiLMMT 46-4B X2 PuriPuly policy | 11.500 | 648 | Fully valid |

The common-cell view (625 sample-cells scored OK for every system) preserves the full ordering; see `reports/summary-overall.penalty.common-cell.json`.

## Key Findings

- **Gemma 4 31B leads overall (0.333)**, ahead of Gemma 4 26B (0.403) and DeepSeek V4 Flash 0731 (0.606).
- **DeepSeek V4 Flash 0731 is the best system on zh-Hans** (0.327 common-cell, vs Gemma 26B 0.439 / 31B 0.444) and misses required context on only 1.9% of samples.
- **Papago Web is the strongest traditional MT service (2.801)**, ahead of DeepL (4.107) and Google Cloud Translation Basic (5.810). It never misuses context but misses required context on 24.5% of samples — context-blind, as expected for sentence-level MT.
- **Local Gemma 4 E4B degrades with quantization:** fp16 1.311 → QAT Q4 1.639 → QAT Q2 collapses to 9.460 (31 critical errors on English alone).
- **MiLMMT 46-4B fails in both prompt regimes:** the native X0 prompt misses required context on 24.1% of samples (2.949), while applying the PuriPuly policy prompt (X2) causes context misuse on 25.5% of samples and the worst overall score (11.500). A completion-style MT model does not absorb a conversational-context policy prompt.

## Context Behavior Highlights

`missed_required_context_rate` / `misused_context_rate` (from `reports/context-behavior.rates.json`):

- Gemma 4 31B / 26B / DeepSeek 0731: 1.2–1.9% missed, ≤0.5% misused
- Papago Web: 24.5% missed, 0% misused
- MiLMMT X0 native: 24.1% missed; MiLMMT X2 PuriPuly: 25.5% misused
- Google Cloud Translation Basic: 27.3% missed

## Run Validity

`reports/run-status.json` reports `benchmarkValid: false`:

- 7,128 expected cells; 7,124 normalized; 7,105 scored
- 19 judge failures (invalid MQM annotations from the batch judge), concentrated in `gemma4-e4b-qat-q2` en/ja (17)
- 4 unresolved historical DeepL translation failures carried over from the forked source run

Rankings are stable under the common-cell restriction (625 cells), so the headline ordering is robust to the missing cells.

## Cost

Judge phase cost $6.64 total (`gemini-3.7-flash:batch`). Translation costs were not tracked for this run (local models, bundled services, and OpenRouter rows recorded as unknown).

## Reproduction

- Launch helper: `scripts/experiment/launch-issue1.ps1` (uses `scripts/experiment/models.json`)
- Local arms need llama.cpp servers on ports 8080–8083: `scripts/llama-server.ps1`
- Papago arm needs the Python bridge: `pip install -r scripts/papago-bridge-requirements.txt` (see `.env.example`)
- Direct runner invocation: see `docs/reproducibility.md`

## Files

- `reports/` — canonical result tables (overall/by-language/by-phenomenon/by-context slices, context behavior, severity, error classes, cost, run status)
- `manifest.json` — run configuration (promptFile paths rewritten to repo-relative locations; fingerprints unchanged)
- `fork-prepared.json` — fork-and-merge provenance record
