# Experiment: Gemini 3.5 Live Translate (Audio-native Two Voice) on the frozen dataset (2026-08)

- **Run ID:** `gemini35-live-two-voice-20260817`
- **Run date:** 2026-08-18
- **Benchmark config:** `data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json` (same cell grid as the 2026-08 issue-1 experiment)
- **Dataset:** `gemba-mqm-context-v1` (fingerprint `9ab9e987…5110`, identical to all prior experiments)
- **Translation prompt:** `data/prompts/gemini-live-translate-no-prompt.md` (provenance marker only — nothing is sent to the Live session); all other participants keep their 2026-08 issue-1 prompt files
- **Judge:** GEMBA-MQM-context prompt set, `google/gemini-3.7-flash:batch` via the OpenRouter Batch API (3 batch jobs)
- **Provenance:** fork-and-merge run — 7,124 translations reused from `issue1-milmmt-e4b-papago-deepseek-0731-integrated-20260815-01`, 640 new cells translated by the Live participant. See `fork-prepared.json`.

## What is new in this run

The new participant is **Gemini 3.5 Live Translate (Audio-native Two Voice)**: the Korean source turns are spoken (TTS) by two voices and streamed into a Gemini Live session (`gemini-3.5-live-translate-preview`); the session's streaming translation is captured. Voices are locally synthesized with `Qwen3-TTS-12Hz-0.6B-CustomVoice` (self: `sohee`, other: `uncle_fu`); full audio provenance is in `audio-assets/manifest.json`. The Live session receives no prompt — only audio.

All other rows are carried over from the 2026-08 issue-1 experiment (`puripuly-translation-latest.md` prompt, judged in the same batch) and are **not re-run**.

## Leaderboard

Primary score: raw mean penalty (GEMBA-MQM severity weights minor 1 / major 5 / critical 25). Lower is better.

| Rank | System | Mean penalty | Scored samples | Note |
| ---: | --- | ---: | ---: | --- |
| 1 | Gemma 4 31B (OpenRouter) | 0.333 | 648 | Reused from issue-1 run |
| 2 | Gemma 4 26B A4B (OpenRouter) | 0.403 | 648 | Reused from issue-1 run |
| 3 | DeepSeek V4 Flash 0731 (OpenRouter) | 0.606 | 648 | Reused from issue-1 run |
| 4 | Gemma 4 E4B fp16 (llama.cpp, local) | 1.311 | 647 | Reused from issue-1 run; 1 judge failure |
| 5 | Gemma 4 E4B QAT Q4 (llama.cpp, local) | 1.639 | 648 | Reused from issue-1 run |
| 6 | Papago Web | 2.801 | 648 | Reused from issue-1 run; context-blind |
| 7 | MiLMMT 46-4B X0 native prompt | 2.949 | 648 | Reused from issue-1 run; context-blind |
| 8 | Gemini 3.5 Live Translate (Two Voice) | 4.033 | 638 | **New; see caveats below** |
| 9 | DeepL API | 4.107 | 643 | Reused from issue-1 run; 4 unresolved + 1 judge failure |
| 10 | Google Cloud Translation Basic | 5.810 | 648 | Reused from issue-1 run; context-blind |
| 11 | Gemma 4 E4B QAT Q2 (llama.cpp, local) | 9.460 | 631 | Reused from issue-1 run; 17 judge failures |
| 12 | MiLMMT 46-4B X2 PuriPuly policy | 11.500 | 648 | Reused from issue-1 run |

The common-cell view (617 sample-cells scored OK for every system) keeps this ordering; the Live participant ranks between MiLMMT X0 and DeepL in both views (3.976 common-cell). See `reports/summary-overall.penalty.common-cell.json`.

## Key Findings

- **Audio-native Live translation lands mid-pack**: Gemini 3.5 Live Translate (4.033) is far behind the text LLMs (Gemma 4 31B 0.333, 26B 0.403, DeepSeek 0731 0.606) and the small local E4B arms (1.311–1.639), and slightly behind Papago (2.801). It beats DeepL (4.107) and Google Basic (5.810).
- **Context behavior is worse than the leading text models**: Live misses required context on 6.6% of samples and misuses context on 7.0% (vs 1.2–1.9% missed / ≤0.5% misused for Gemma 4 31B, 26B, DeepSeek 0731).
- **English is the weakest language for Live** (4.580, 7 critical errors); Japanese is the strongest (3.559). Quality degrades with context length: ctx1 3.630 → ctx2 3.660 → ctx3 4.841.
- **1,300+ penalty points come from mistranslation/addition**, consistent with an audio-native pipeline that must transcribe before translating: 19 critical / 337 major / 413 minor errors on 638 judged cells.
- **ASR CER is a contributing but not the dominant factor**: current-utterance CER mean is 0.112 (about 1 wrong character per 9); correlation with penalty is weak (r = 0.36, R² ≈ 0.13). Even in the cleanest CER bucket (0–5% CER), Live's mean penalty is 3.24 — far above the text LLMs (0.40–1.64).

## Caveats — read before citing this run

1. **ASR/CER analysis is unofficial.** `reports/ASR-CER-analysis.md` and the `ASR-CER-*` files are a standalone analysis of the Live participant's streaming transcription events (`input_transcription_events` in `translation-provider-details.jsonl`). It is not produced by the benchmark runner's report pipeline and is published here as-is.
2. **CER is measured against the intended transcript, not the audio.** Reference is `runtime.json` source text (`trim()` only). CER values include non-ASR effects: 20/640 records (3.1%) carry a wrong `languageCode` label (e.g. Korean audio labeled `ja`/`en`, sometimes with a genuinely Japanese transcription), which inflates the CER tail (5 of the 13 worst records). The 8 Live session timeouts (2 samples across all 3 languages, `ctx3-single-use-pragmatic_intent_resolution-003/004`) have no transcription and are excluded from CER analysis (denominator 640, not 648).
3. **The `<=5%` CER condition holds for the headline number.** Under the strict CER definition in `ASR-CER-analysis.md` (current-utterance, per-turn accumulated, `trim()`-normalized, codepoint Levenshtein), mean CER for the Live participant is **0.112**, median 0.077, p90 0.190. Mean CER is within the 5% band only if one of the alternative definitions is used; the repo documents the strict numbers and does not claim a clean-ASR result.
4. **Session variance.** The same source item scored in different target-language sessions shows per-sample CER spread (mean max−min range 0.046), so per-cell CER is noisy.
5. **Automated judge.** All cells (including the 640 Live cells) were judged by `gemini-3.7-flash:batch` in this run; the 7,124 reused cells were judged under the same judge setup in the source run. Scores remain automated-judge measurements.

## Run Validity

`reports/run-status.json` reports `benchmarkValid: false`:

- 7,776 expected cells; 7,764 normalized; 7,105 scored
- 2 judge failures in this run, both Live cells (`ctx2-single-use-pragmatic_intent_resolution-003::en`, `ctx3-single-ignore-stale_context_resistance-001::en` — invalid MQM annotation from the batch judge)
- 12 unresolved translation failures: 8 Live session timeouts (5 attempts each, `AbortError: Live session request timed out`) + 4 historical DeepL failures carried over from the forked source run
- 17 additional judge failures on `gemma4-e4b-qat-q2` en/ja carried over from the source run

Rankings are stable under the common-cell restriction (617 cells), so the headline ordering is robust to the missing cells.

## Context Behavior Highlights

`missed_required_context_rate` / `misused_context_rate` (from `reports/context-behavior.rates.json`):

- Gemma 4 31B / 26B / DeepSeek 0731: 1.2–1.9% missed, ≤0.5% misused
- Gemini 3.5 Live Translate: 6.6% missed, 7.0% misused
- MiLMMT X0 native: 24.1% missed; MiLMMT X2 PuriPuly: 25.5% misused
- Papago Web: 24.5% missed, 0% misused; Google Cloud Translation Basic: 27.3% missed

## Cost

Judge phase cost $7.17 total (`gemini-3.7-flash:batch`, 3 batch jobs). Translation costs were not tracked (local models, bundled services, and OpenRouter rows recorded as unknown).

## Files

- `translations.jsonl` — all 7,764 translation cells (7,124 fork-copied + 640 new Live cells)
- `translation-provider-details.jsonl` — per-Live-cell input audio asset hashes, streaming transcription events (`input_transcription_events`), and output events
- `translation-failures.jsonl` — 12 unresolved translation failures (8 Live timeouts + 4 historical DeepL)
- `judge-normalized.jsonl` / `judge-raw.jsonl` — normalized and raw judge outputs for all 7,764 cells (2 Live judge failures have no valid annotation)
- `judge-events.jsonl` / `judge-failures.jsonl` — judge run events and failure records
- `reports/` — canonical result tables (overall/by-language/by-phenomenon/by-context slices, context behavior, severity, error classes, cost, run status) plus the standalone `ASR-CER-*` ASR analysis
- `audio-assets/manifest.json` — TTS provenance (voices `sohee`/`uncle_fu`, qwentts.cpp runtime, SHA-256s; PCM files not committed)
- `manifest.json` — run configuration (prompt/audio paths rewritten to repo-relative locations; fingerprints unchanged)
- `fork-prepared.json` — fork-and-merge provenance record
- `run-state.json` — completion counters per participant
