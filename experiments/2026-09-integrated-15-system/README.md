# Main Experiment 1 — 15-System Integrated Comparison

## Setup

- **Run:** `unified-15arm-gpt6-luna-audio-20260927-001`; assembled 2026-09-27.
- **Dataset:** 216 Korean dialogue items × English, Japanese, and Simplified Chinese = 648 cells per system.
- **Participants:** 12 text-input systems + 3 direct speech-translation systems. Speech systems receive synthesized two-voice Korean audio history, not the text-input task. TTS: Qwen3-TTS-12Hz-0.6B-CustomVoice; self `sohee`, other `uncle_fu`.
- **Score:** GEMBA-MQM context penalty, minor 1 / major 5 / critical 25; lower is better. Automated judge: `google/gemini-3.7-flash:batch`.
- **Assembly:** 13-system base plus Qwen and Soniox speech observations; translations and judgments are reused from the source runs, not fresh measurements at assembly. Per-row lineage and configuration remain in the [manifest](manifest.json), [assembly provenance](assembly-provenance.json), and JSONL evidence.

The same three direct speech systems' observations are reused in [Main Experiment 2 — full-stack pipelines](../2026-09-fullstack/README.md); these are not independent repetitions. The single-model context comparison is [Main Experiment 3 — context ablation](../2026-08-gemini35-live-10p-highjudge/ablation/README.md).

## Overall leaderboard

Full valid means use all cells with `status: ok` for each system. Common means use the **612 sample-language cells scored OK for all 15 systems**. The rank order is unchanged on the common-cell subset. Values below are rounded to three decimals; exact means are in the [full report](reports/summary-overall.penalty.json) and [common-cell report](reports/summary-overall.penalty.common-cell.json).

| Rank | System | Input | Full mean | Valid n | Common mean (n = 612) |
| ---: | --- | --- | ---: | ---: | ---: |
| 1 | GPT-6 Luna (OpenRouter) | Text | 0.130 | 648 | 0.108 |
| 2 | Gemma 4 31B via OpenRouter | Text | 0.353 | 648 | 0.345 |
| 3 | Gemma 4 26B via OpenRouter | Text | 0.387 | 648 | 0.399 |
| 4 | DeepSeek V4 Flash (0731) via OpenRouter | Text | 0.571 | 648 | 0.583 |
| 5 | Gemma 4 12B QAT Q4 | Text | 0.855 | 648 | 0.835 |
| 6 | Gemma 4 E4B fp16 (llama.cpp) | Text | 1.353 | 648 | 1.337 |
| 7 | Gemma 4 E4B QAT Q4 (llama.cpp) | Text | 1.577 | 648 | 1.560 |
| 8 | Hy-MT2 7B | Text | 1.863 | 648 | 1.838 |
| 9 | Qwen 3.8 LiveTranslate (two-voice audio history) | Speech | 2.124 | 647 | 2.114 |
| 10 | Papago Web | Text | 2.699 | 648 | 2.585 |
| 11 | MiLMMT 46-4B X0 (native) | Text | 3.087 | 647 | 3.078 |
| 12 | Gemini 3.5 Live Translate (Audio-native Two Voice) | Speech | 3.723 | 638 | 3.709 |
| 13 | DeepL API | Text | 3.914 | 642 | 3.820 |
| 14 | Soniox STT-RT v5 one-way translation (two-voice audio history) | Speech | 5.010 | 630 | 4.897 |
| 15 | Google Cloud Translation Basic | Text | 5.731 | 648 | 5.886 |

### Speech translation — current-utterance CER ≤ 5%

The [audio-ASR report](reports/audio-asr.json) separately scores cells whose recognized **current utterance** has **CER ≤ 5%** (inclusive). CER is Unicode-codepoint Levenshtein distance divided by the trimmed reference length, with trim-only normalization. Means use valid (`status: ok`) MQM judgments and are rounded to three decimals.

| System | Mean penalty (CER ≤ 5%) | Valid n |
| --- | ---: | ---: |
| Qwen 3.8 Live Translate | 1.392 | 286 |
| Gemini 3.5 Live Translate | 2.991 | 223 |
| Soniox Translate | 3.473 | 355 |

Qualifying cells are selected per system, not matched across all three systems. Context-audio CER is not constrained by this filter, so these are conditional clean-current results, not ASR-free translation scores. Gemini has 224 qualifying cells with one failed judgment; Soniox has 357 with two failed judgments; Qwen has 286 with no failed judgments.

## Key findings

- GPT-6 Luna leads the text systems: **0.130**, followed by Gemma 4 31B (**0.353**) and Gemma 4 26B (**0.387**).
- Gemma 4 12B QAT Q4 is the strongest local text system: **0.855**. E4B fp16 (**1.353**) scores better than E4B QAT Q4 (**1.577**).
- Among direct speech systems, Qwen 3.8 LiveTranslate (**2.124**) scores better than Gemini 3.5 Live Translate (**3.723**) and Soniox STT-RT v5 (**5.010**).
- Papago is the strongest traditional text MT service here (**2.699**), ahead of DeepL (**3.914**) and Google Cloud Translation Basic (**5.731**).

## Coverage

[Run status](reports/run-status.json) records `benchmarkValid: false`: 9,720 expected cells, 9,703 normalized rows, and **9,684 valid judgments**. There are 17 unresolved translation cells and 19 failed judgments. The failure artifact retains 769 historical translation-failure records; that is not the unresolved-cell count. The judge-failure log contains 14 source-run failures; the status report also accounts for 5 inherited failures.

## Files

- [`reports/`](reports/) — all 20 source reports, including full/common overall and language slices, context behavior, severity, errors, coverage, cost, and audio-ASR analysis.
- [`translations.jsonl`](translations.jsonl) — 9,703 translations with source-run lineage.
- [`judge-normalized.jsonl`](judge-normalized.jsonl) — 9,703 normalized judgments; use `status: ok` and `summary.total_penalty` to reproduce the means. Common-cell keys are `source_id` + `target_language`, intersected across all 15 participants.
- [`judge-raw.jsonl`](judge-raw.jsonl) — 9,684 raw judge outputs.
- [`translation-metrics.jsonl`](translation-metrics.jsonl) — 9,055 recorded translation-metric rows; not every translation has a metric row.
- [`translation-failures.jsonl`](translation-failures.jsonl) / [`judge-failures.jsonl`](judge-failures.jsonl) — retained failure evidence.
- [`manifest.json`](manifest.json) / [`assembly-provenance.json`](assembly-provenance.json) — participant settings, dataset/prompt/audio fingerprints, and source artifact hashes.

All imported reports, JSONL files, and assembly provenance are **byte-identical source copies**. Only the manifest was changed: eight workstation-specific prompt/audio paths were rewritten as source-repository-relative provenance references, and a `sanitized` record identifies the changed fields and original manifest SHA-256. All original non-path fields and fingerprints are unchanged. Referenced raw audio, bulky provider diagnostics, judge metrics, empty event logs, and process scripts are not imported.
