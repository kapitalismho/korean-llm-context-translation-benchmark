# Experiment: Gemini 3.5 Live Translate (Audio-native Two Voice) on the frozen dataset, high-effort judge (2026-08)

- **Run ID:** `gemini35-live-10p-highjudge-20260820`
- **Run date:** 2026-08-20
- **Benchmark config:** `data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json` (10-participant cell grid)
- **Dataset:** `gemba-mqm-context-v1` (fingerprint `9ab9e987…5110`, identical to all prior experiments)
- **Translation prompt:** `data/prompts/puripuly-translation-latest.md` (revision `4a358267…` recorded in the manifest; the forked text rows were generated under the previous revision `792ed1aa…` in their source run, and the fork was made with a prompt mismatch allowed); Live participant uses `data/prompts/gemini-live-translate-no-prompt.md` (provenance marker only — nothing is sent to the Live session)
- **Judge:** GEMBA-MQM-context prompt set, `google/gemini-3.7-flash:batch` via the OpenRouter Batch API with `reasoning effort = high` (5 batch jobs)
- **Provenance:** fork-and-merge run — all 6,468 translations reused from `gemini35-live-two-voice-20260817`; no new translations, all 6,468 cells newly judged with the high-effort judge. See `fork-prepared.json`.

The Gemini 3.5 Live Translate (Audio-native Two Voice) participant speaks the Korean source turns with two locally synthesized TTS voices and streams them into a Gemini Live session (`gemini-3.5-live-translate-preview`); the session's streaming translation is captured. Voices are `Qwen3-TTS-12Hz-0.6B-CustomVoice` (self: `sohee`, other: `uncle_fu`); full audio provenance is in `audio-assets/manifest.json`. The Live session receives no prompt — only audio.

## Leaderboard

Primary score: raw mean penalty (GEMBA-MQM severity weights minor 1 / major 5 / critical 25). Lower is better.

| Rank | System | Mean penalty | Scored samples | Note |
| ---: | --- | ---: | ---: | --- |
| 1 | Gemma 4 31B (OpenRouter) | 0.353 | 648 | Reused translation |
| 2 | Gemma 4 26B A4B (OpenRouter) | 0.387 | 648 | Reused translation |
| 3 | DeepSeek V4 Flash 0731 (OpenRouter) | 0.571 | 648 | Reused translation |
| 4 | Gemma 4 E4B fp16 (llama.cpp, local) | 1.353 | 648 | Reused translation |
| 5 | Gemma 4 E4B QAT Q4 (llama.cpp, local) | 1.577 | 648 | Reused translation |
| 6 | Papago Web | 2.699 | 648 | Reused translation; context-blind |
| 7 | MiLMMT 46-4B X0 native prompt | 3.087 | 647 | Reused translation; context-blind; 1 judge failure |
| 8 | Gemini 3.5 Live Translate, CER ≤ 5% subset | 2.991 | 223 | **See caveats below** |
| 8 | Gemini 3.5 Live Translate (Two Voice) | 3.723 | 638 | **See caveats below**; 2 judge failures |
| 9 | DeepL API | 3.914 | 642 | Reused translation; 4 unresolved + 2 judge failures |
| 10 | Google Cloud Translation Basic | 5.731 | 648 | Reused translation; context-blind |

The common-cell view (631 sample-cells scored OK for every system) keeps this ordering; the Live participant ranks between MiLMMT X0 and DeepL in both views (3.685 common-cell). See `reports/summary-overall.penalty.common-cell.json`.

## Key Findings

- LLMs outperform traditional MT on multi-turn casual dialogue — best LLM 0.35 (Gemma 4 31B) vs. best MT Papago 2.70.
- Context helps: same Gemma 4 E4B QAT Q4 improves 31.5% with full history + policy (1.45 vs. 2.12 sentence-only, same high-effort judge; see `ablation/README.md`).
- Google Translate is competitive for en (1.22) and zh-Hans (2.49) but collapses on ja (13.49), driving its overall 5.73.
- Quantization costs quality for the small local model: Gemma 4 E4B fp16 1.35 → QAT Q4 1.58.

## Caveats — read before citing this run

1. **ASR/CER analysis is unofficial.** `reports/ASR-CER-analysis-high.md`, `reports/ASR-CER-summary-high.json`, and `reports/ASR-CER-highjudge-join.jsonl` are a standalone analysis of the Live participant's streaming transcription events (`input_transcription_events` in `translation-provider-details.jsonl`). It is not produced by the benchmark runner's report pipeline and is published here as-is. CER values are reused from the v2-strict detail of the source run (translations are byte-identical); only the penalties are the high-effort ones.
2. **CER is measured against the intended transcript, not the audio.** Reference is `runtime.json` source text (`trim()` only). CER values include non-ASR effects: 20/640 records (3.1%) carry a wrong `languageCode` label (e.g. Korean audio labeled `ja`/`en`, sometimes with a genuinely Japanese transcription), which inflates the CER tail. The 8 Live session timeouts (2 samples across all 3 languages, `ctx3-single-use-pragmatic_intent_resolution-003/004`) have no transcription and are excluded from CER analysis (denominator 640, not 648).
3. **The strict CER mean is above a 5% band.** Under the strict CER definition in `ASR-CER-analysis-high.md` (current-utterance, per-turn accumulated, `trim()`-normalized, codepoint Levenshtein), mean CER for the Live participant is **0.112**, median 0.077, p90 0.190. The CER ≤ 5% subset row in the leaderboard uses the inclusive band (224 cells, 223 judged); the repo documents the strict numbers and does not claim a clean-ASR result.
4. **Session variance.** The same source item scored in different target-language sessions shows per-sample CER spread (mean max−min range 0.046), so per-cell CER is noisy.
5. **Forked translations, fresh judge.** All 6,468 translations are reused from `gemini35-live-two-voice-20260817`; 5,828 of them (the text participants) were generated under the previous revision of `puripuly-translation-latest.md` in their original runs, and the fork was made with a prompt mismatch allowed. This run measures the high-effort judge applied to those reused translations — do not treat the text rows as fresh measurements.
6. **Automated judge.** All 6,468 cells were newly judged by `gemini-3.7-flash:batch` with reasoning effort high in this run. Scores are automated-judge measurements.

## Run Validity

`reports/run-status.json` reports `benchmarkValid: false`:

- 6,480 expected cells; 6,468 normalized; 6,463 scored
- 5 judge failures in this run, all invalid MQM annotations from the batch judge: 2 Live cells (`ctx2-single-use-pragmatic_intent_resolution-003::en`, `ctx3-single-ignore-stale_context_resistance-001::en`), DeepL en/zh (`ctx2-single-use-referent_resolution-001`), MiLMMT X0 en (`ctx2-dyadic-ignore-stale_context_resistance-003`)
- 12 unresolved translation failures: 8 Live session timeouts (5 attempts each, `AbortError: Live session request timed out`) + 4 historical DeepL failures carried over from the forked source run

Rankings are stable under the common-cell restriction (631 cells), so the headline ordering is robust to the missing cells.

## Context Behavior Highlights

`missed_required_context_rate` / `misused_context_rate` (from `reports/context-behavior.rates.json`):

- Gemma 4 31B: 1.2% missed, 0% misused; Gemma 4 26B: 1.4% / 0.9%; DeepSeek 0731: 2.8% / 0.5%
- Gemini 3.5 Live Translate: 9.2% missed, 6.0% misused
- DeepL: 16.6% missed, 5.1% misused
- MiLMMT X0 native: 25.7% missed; Papago Web: 26.6% missed, 0% misused; Google Cloud Translation Basic: 30.8% missed

## Cost

Judge phase cost $7.13 total (`gemini-3.7-flash:batch`, high reasoning effort, 5 batch jobs). Translation costs were not tracked (no translations were generated in this run; local models, bundled services, and OpenRouter rows recorded as unknown).

## Files

- `translations.jsonl` — all 6,468 translation cells (fork-copied from `gemini35-live-two-voice-20260817`)
- `translation-provider-details.jsonl` — per-Live-cell input audio asset hashes, streaming transcription events (`input_transcription_events`), and output events
- `translation-failures.jsonl` — 12 unresolved translation failures (8 Live timeouts + 4 historical DeepL)
- `judge-normalized.jsonl` / `judge-raw.jsonl` — normalized and raw judge outputs for all 6,468 cells (5 cells have no valid annotation)
- `judge-events.jsonl` / `judge-failures.jsonl` — judge run events and failure records
- `reports/` — canonical result tables (overall/by-language/by-phenomenon/by-context slices, context behavior, severity, error classes, cost, run status) plus the standalone `ASR-CER-*` ASR analysis (high-judge recalculation)
- `audio-assets/manifest.json` — TTS provenance (voices `sohee`/`uncle_fu`, qwentts.cpp runtime, SHA-256s; PCM files not committed)
- `manifest.json` — run configuration (prompt/audio paths rewritten to repo-relative locations; fingerprints unchanged)
- `fork-prepared.json` — fork-and-merge provenance record
- `run-state.json` — completion counters per participant
- `ablation/` — appendix: single-model context A/B ablation on Gemma 4 E4B QAT Q4 (sentence-only vs. policy + full history, same high-effort judge); see `ablation/README.md`
