# Experiment: Unified 12-arm collect on the frozen dataset, high-effort judge (2026-08)

- **Run ID:** `unified-12arm-highjudge-20260822`
- **Run date:** 2026-08-22
- **Benchmark config:** `data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json` (12-participant cell grid)
- **Dataset:** `gemba-mqm-context-v1` (216 items × 3 target languages; repo freeze fingerprint `9ab9e987…5110`. The run manifest records `765b89dc…`, the collector's `runtime.json` serialization without the optional `relativeTimeLabel` fields — sample content is byte-identical, see the manifest's `datasetFingerprintNote`)
- **Translation prompt:** `data/prompts/puripuly-translation-latest.md` (revision `4a358267…`) for the LLM arms; `data/prompts/milmmt-x0-native.md` for MiLMMT X0; Live participant uses `data/prompts/gemini-live-translate-no-prompt.md` (provenance marker only — nothing is sent to the Live session); Hy-MT2 7B uses its llama.cpp sampling preset (`llamaCppSampling: hymt2`)
- **Judge:** GEMBA-MQM-context prompt set, `google/gemini-3.7-flash:batch` via the OpenRouter Batch API with `reasoning effort = high`
- **Provenance:** unified 12-arm collect — all 6,468 cells of the 10 carried arms (translations *and* high-effort judgments) are byte-identical to `gemini35-live-10p-highjudge-20260820` (translations descend from `gemini35-live-two-voice-20260817`; the 5 batch jobs in the manifest are that run's inherited judge jobs). The 2 new arms were translated and judged fresh in their own high-judge sessions (`hymt2-7b-q4xl-highjudge-20260822`, `gemma4-12b-qat-q4xl-highjudge-20260822`). Per-row lineage is in `source_run_id` / `run_id` fields of `translations.jsonl` / `judge-normalized.jsonl`.

The Gemini 3.5 Live Translate (Audio-native Two Voice) participant speaks the Korean source turns with two locally synthesized TTS voices and streams them into a Gemini Live session (`gemini-3.5-live-translate-preview`); the session's streaming translation is captured. Voices are `Qwen3-TTS-12Hz-0.6B-CustomVoice` (self: `sohee`, other: `uncle_fu`); full audio provenance is in `audio-assets/manifest.json`. The Live session receives no prompt — only audio.

## Leaderboard

Primary score: raw mean penalty (GEMBA-MQM severity weights minor 1 / major 5 / critical 25). Lower is better.

| Rank | System | Mean penalty | Scored samples | Note |
| ---: | --- | ---: | ---: | --- |
| 1 | Gemma 4 31B (OpenRouter) | 0.353 | 648 | Carried over |
| 2 | Gemma 4 26B A4B (OpenRouter) | 0.387 | 648 | Carried over |
| 3 | DeepSeek V4 Flash 0731 (OpenRouter) | 0.571 | 648 | Carried over |
| 4 | Gemma 4 12B QAT Q4 (llama.cpp, local) | 0.855 | 648 | **New arm** — best local model |
| 5 | Gemma 4 E4B fp16 (llama.cpp, local) | 1.353 | 648 | Carried over |
| 6 | Gemma 4 E4B QAT Q4 (llama.cpp, local) | 1.577 | 648 | Carried over |
| 7 | Hy-MT2 7B (llama.cpp, local) | 1.863 | 648 | **New arm** — dedicated MT model |
| 8 | Papago Web | 2.699 | 648 | Carried over; context-blind |
| 9 | MiLMMT 46-4B X0 native prompt | 3.087 | 647 | Carried over; context-blind; 1 judge failure |
| - | Gemini 3.5 Live Translate, CER ≤ 5% subset | 2.991 | 223 | **See caveats below** |
| 10 | Gemini 3.5 Live Translate (Two Voice) | 3.723 | 638 | **See caveats below**; carried over; 2 judge failures |
| 11 | DeepL API | 3.914 | 642 | Carried over; 4 unresolved + 2 judge failures |
| 12 | Google Cloud Translation Basic | 5.731 | 648 | Carried over; context-blind |

The common-cell view (631 sample-cells scored OK for every system) keeps this ordering; see `reports/summary-overall.penalty.common-cell.json`.

## Key Findings

- LLMs outperform traditional MT on multi-turn casual dialogue — best LLM 0.35 (Gemma 4 31B) vs. best MT Papago 2.70.
- Context helps: same Gemma 4 E4B QAT Q4 improves 31.5% with full history + policy (1.45 vs. 2.12 sentence-only, same high-effort judge; see `ablation/README.md`).
- Google Translate is competitive for en (1.22) and zh-Hans (2.49) but collapses on ja (13.49), driving its overall 5.73.
- Quantization costs quality for the small local model: Gemma 4 E4B fp16 1.35 → QAT Q4 1.58.
- New in this run: Gemma 4 12B QAT Q4 is the strongest local arm overall (0.855), landing between DeepSeek V4 Flash and E4B fp16; the dedicated MT model Hy-MT2 7B scores 1.86 — behind the Gemma locals but ahead of Papago, and it misuses irrelevant context more than any other system (8.3%).

## Caveats — read before citing this run

1. **Carried-over rows are not fresh measurements.** The 10 carried arms keep both translations and high-effort judgments byte-identical from the 2026-08-20 publication; this run adds the two new arms and re-publishes everything under one artifact set. Only `hymt2-7b-q4xl` and `gemma4-12b-qat-q4xl` are fresh measurements.
2. **Forked translations under a prior prompt revision.** The carried text-arm translations were generated under a previous revision of `puripuly-translation-latest.md` (`792ed1aa…`) in their source runs; the fork was made with a prompt mismatch allowed. The current revision fingerprint is recorded in the manifest.
3. **ASR/CER analysis is unofficial.** `reports/ASR-CER-analysis-high.md`, `reports/ASR-CER-summary-high.json`, and `reports/ASR-CER-highjudge-join.jsonl` are a standalone analysis of the Live participant's streaming transcription events (`input_transcription_events` in `translation-provider-details.jsonl`). It is not produced by the benchmark runner's report pipeline. For this run it was fully recomputed from the unified artifacts and cross-checked against the previous publication (all 640 CER values, penalties, behaviors identical).
4. **CER is measured against the intended transcript, not the audio.** Reference is `runtime.json` source text (`trim()` only). CER values include non-ASR effects: 20/640 records (3.1%) carry a wrong `languageCode` label (e.g., Korean audio labeled `ja`/`en`), which inflates the CER tail. The 8 Live session-timeout cells have no transcription and are excluded from CER analysis (denominator 640, not 648).
5. **The strict CER mean is above a 5% band.** Under the strict CER definition in `ASR-CER-analysis-high.md` (current-utterance, per-turn accumulated, `trim()`-normalized, codepoint Levenshtein), mean CER for the Live participant is **0.112**, median 0.077, p90 0.190. The CER ≤ 5% subset row uses the inclusive band (224 cells, 223 judged); the repo documents the strict numbers and does not claim a clean-ASR result.
6. **Session variance.** The same source item scored in different target-language sessions shows per-sample CER spread (mean max−min range 0.046), so per-cell CER is noisy.
7. **Automated judge.** All cells were judged by `gemini-3.7-flash:batch` with reasoning effort high (carried or fresh). Scores are automated-judge measurements.

## Run Validity

`reports/run-status.json` reports `benchmarkValid: false`:

- 7,776 expected cells; 7,764 normalized; 7,759 scored
- 5 judge failures, all invalid MQM annotations from the batch judge, inherited unchanged from the carried arms: 2 Live cells (`ctx2-single-use-pragmatic_intent_resolution-003::en`, `ctx3-single-ignore-stale_context_resistance-001::en`), DeepL en/zh (`ctx2-single-use-referent_resolution-001`), MiLMMT X0 en (`ctx2-dyadic-ignore-stale_context_resistance-003`)
- 12 unresolved translation failures: 8 Live session timeouts across 3 samples (`ctx3-single-use-pragmatic_intent_resolution-002/003/004`; `AbortError: Live session request timed out`) + 4 historical DeepL failures (en/zh on 2 samples) carried over from the forked source runs

Rankings are stable under the common-cell restriction (631 cells), so the headline ordering is robust to the missing cells.

## Context Behavior Highlights

`missed_required_context_rate` / `misused_context_rate` (from `reports/context-behavior.rates.json`):

- Gemma 4 31B: 1.2% missed, 0% misused; Gemma 4 26B: 1.4% / 0.9%; DeepSeek 0731: 2.8% / 0.5%; **Gemma 4 12B QAT Q4: 2.3% missed, 0% misused**
- **Hy-MT2 7B: 6.0% missed, 8.3% misused** — highest context misuse in the field
- Gemini 3.5 Live Translate: 9.2% missed, 6.0% misused
- DeepL: 16.6% missed, 5.1% misused
- MiLMMT X0 native: 25.7% missed; Papago Web: 26.6% missed, 0% misused; Google Cloud Translation Basic: 30.8% missed

## Cost

Judge-phase cost recorded in the merged artifacts totals $7.74 (`google/gemini-3.7-flash:batch` high reasoning effort; includes the inherited 2026-08-20 batch jobs plus the two fresh arms' sessions). Translation costs were not tracked (local models, bundled services, and OpenRouter rows recorded as unknown).

## Files

- `translations.jsonl` — all 7,764 translation cells (6,468 carried byte-identical; `hymt2-7b-q4xl` and `gemma4-12b-qat-q4xl` fresh)
- `translation-provider-details.jsonl` — per-Live-cell input audio asset hashes, streaming transcription events (`input_transcription_events`), and output events (640 Live cells)
- `translation-failures.jsonl` — 12 unresolved translation failures (8 Live timeouts + 4 historical DeepL)
- `judge-normalized.jsonl` / `judge-raw.jsonl` — normalized and raw judge outputs for all 7,764 cells (5 cells have no valid annotation); `run_id` per row records the judging session
- `judge-events.jsonl` / `judge-failures.jsonl` — empty in this collect (no judge work was submitted during assembly); failure details live in `reports/run-status.json` and `reports/failed-samples.by-language.json`
- `reports/` — canonical result tables (overall/by-language/by-phenomenon/by-context slices, context behavior, severity, error classes, cost, run status) plus the standalone recomputed `ASR-CER-*` ASR analysis
- `audio-assets/manifest.json` — TTS provenance (voices `sohee`/`uncle_fu`, qwentts.cpp runtime, SHA-256s; PCM files not committed)
- `manifest.json` — run configuration (paths rewritten to repo-relative locations; fingerprints unchanged; see `provenanceNote` / `datasetFingerprintNote` / `sanitized`)
- `run-state.json` — completion counters per participant
- `ablation/` — appendix: single-model context A/B ablation on Gemma 4 E4B QAT Q4 (sentence-only vs. policy + full history, same high-effort judge); see `ablation/README.md`
