# Methodology

This benchmark evaluates Korean source-side multi-turn context translation. Each sample contains one current Korean utterance and one to three prior context turns. Participant systems translate only the current utterance while receiving either the full context prompt or a context-blind prompt, depending on the participant configuration.

## Benchmark Scope

The benchmark focuses on context-sensitive translation phenomena that are common in Korean conversation:

- omitted subjects and objects that require referent recovery,
- ellipsis completion,
- register and politeness carryover,
- pragmatic intent resolution,
- addressivity and speaker relationship cues,
- false leads and stale context that should be ignored.

The benchmark does not claim to measure general translation quality across domains. It is designed for Korean conversational context handling.

## Primary Metric

The primary score is raw mean penalty from the GEMBA-MQM-based evaluation. Lower is better.

Severity weights are:

- minor: 1
- major: 5
- critical: 25

For a participant, `mean_penalty` is the mean total penalty over valid judged cells.

## Experiments

All experiments run on dataset `gemba-mqm-context-v1` (fingerprint `9ab9e98752155a83cda100fc121f1b952474c82c1a20607887d9eb774855d110`). Everything else may differ per experiment:

| | 2026-04 (archived) | 2026-08 issue-1 (archived) | 2026-08 Live (current) |
| --- | --- | --- | --- |
| Run ID | `gemba-mqm-context-v1-gemini-context-v2-expanded-nodeepl-api-20260429-011514` | `issue1-milmmt-e4b-papago-deepseek-0731-integrated-20260815-01` | `gemini35-live-two-voice-20260817` |
| Translation prompt | `gemini-context-v2.md` | `puripuly-translation-latest.md` (MiLMMT arms use their own) | Live: no prompt (audio only, provenance marker file); other rows reused from issue-1 |
| Judge model | `gemini-3.1-pro-preview` | `google/gemini-3.7-flash:batch` | `google/gemini-3.7-flash:batch` |
| Judge backend | Vertex AI | OpenRouter Batch API | OpenRouter Batch API |
| Judge prompt format | JSON structured output | Upstream GEMBA-MQM text annotation | Upstream GEMBA-MQM text annotation |
| Participants | Gemini/Gemma/Qwen/DeepSeek + DeepL + Google | Gemma 31B/26B, DeepSeek 0731, local E4B ×3, MiLMMT ×2, Papago, DeepL, Google | Gemini 3.5 Live Translate (audio-native two voice, new) + issue-1 rows reused |
| Extra arms | no-context baselines | quantization and prompt-regime arms | TTS two-voice audio pipeline, ASR CER analysis |
| Reports | CSV under `experiments/2026-04-…/reports/` | JSON under `experiments/2026-08-…-archived/reports/` | JSON + JSONL raw data under `experiments/2026-08-gemini35-live-two-voice/` |

Because the prompt, judge, and judge prompt format differ, scores from different experiments are not directly comparable. Compare systems only within one experiment.

The 2026-08 issue-1 run was a fork-and-merge continuation: 5,828 translations were reused from an earlier run of the same benchmark config, 1,296 were imported (Papago, DeepSeek 0731), and only missing cells were judged fresh. See `experiments/2026-08-…-archived/fork-prepared.json`.

The 2026-08 Live run forks from the issue-1 run: 7,124 cells are reused, and the 640 Gemini 3.5 Live Translate cells are newly translated and newly judged. The Live participant streams locally TTS-synthesized two-voice audio (`Qwen3-TTS-12Hz-0.6B-CustomVoice`, voices `sohee`/`uncle_fu`) into `gemini-3.5-live-translate-preview`; its streaming transcription is recorded in `translation-provider-details.jsonl` and analyzed in `reports/ASR-CER-analysis.md`. See `experiments/2026-08-gemini35-live-two-voice/README.md`.
