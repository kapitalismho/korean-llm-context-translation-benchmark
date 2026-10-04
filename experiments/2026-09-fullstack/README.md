# Main Experiment 2 — Full-Stack Translation

Saved speech-input → translated-text quality for **six ASR + LLM cascades and three direct speech translators**. The direct speech observations are the same ones used in [Main Experiment 1](../2026-09-integrated-15-system/README.md), not additional runs.

## Setup

- **Grid:** 216 Korean dialogue items × three targets (`en`, `ja`, `zh-Hans`) = **648 expected cells per pipeline**; one to three context turns, single-speaker and dyadic dialogue.
- **Input:** frozen synthesized Korean speech with context. Cascades translate separately collected ASR transcripts; direct translators consume speech directly.
- **Judge reference:** canonical Korean source and context, **not the ASR transcript**. Scores therefore include ASR error propagation.
- **Scoring:** GEMBA-MQM-context (`google/gemini-3.7-flash:batch`); minor 1, major 5, critical 25. Lower mean penalty is better. Failed or missing judgments are excluded, never zero-filled.
- **Components:** Gemini 3.5 **Transcribe** is ASR, distinct from Gemini 3.5 **Live Translate**. Soniox cascades use the latest **pure STT** source, not translation-enabled transcripts; Soniox Translate is the separate direct translator.
- **Scope:** saved observations; no new translation or judging calls. Qwen ASR → GPT-6 Luna pipelines were not executed and are not included.

## Quality

Ranked on **618 cells judged successfully by all nine pipelines** (203 English, 211 Japanese, 204 Simplified Chinese). “All valid” uses each pipeline's own successful judgments out of 648 expected cells; failed and missing counts are separate.

![Full-stack translation: mean penalty on 618 common cells](assets/leaderboard.svg)

| Rank | Pipeline | Common mean (n=618) | All-valid mean | Valid / 648 | Failed | Missing |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | Gemini 3.5 Transcribe → GPT-6 Luna none | 0.676 | 0.682 | 648 | 0 | 0 |
| 2 | Soniox pure STT → GPT-6 Luna none | 0.942 | 0.974 | 648 | 0 | 0 |
| 3 | Qwen3-ASR 1.7B → Gemma 4 26B | 1.024 | 1.079 | 648 | 0 | 0 |
| 4 | Gemini 3.5 Transcribe → Gemma 4 26B | 1.084 | 1.079 | 648 | 0 | 0 |
| 5 | Soniox pure STT → Gemma 4 26B | 1.293 | 1.324 | 648 | 0 | 0 |
| 6 | Qwen 3.8 Live Translate | 2.108 | 2.124 | 647 | 1 | 0 |
| 7 | Qwen3-ASR 0.6B → Gemma 4 26B | 2.374 | 2.437 | 647 | 1 | 0 |
| 8 | Gemini 3.5 Live Translate | 3.754 | 3.723 | 638 | 2 | 8 |
| 9 | Soniox Translate | 4.989 | 5.010 | 630 | 13 | 5 |

Exact means, penalty sums, cell keys, participant IDs, and common-cell language breakdowns: [comparison report](reports/fullstack-comparison.json).

The [SVG chart input](reports/leaderboard-chart-input.json) uses each pipeline's common-cell mean from the comparison report.

### Key findings

- Gemini Transcribe → Luna has the lowest saved common-cell penalty (0.676); Soniox pure STT → Luna is second (0.942).
- Qwen3-ASR 1.7B → Gemma and Gemini Transcribe → Gemma tie on all-valid mean (1.079), but Qwen 1.7B is lower on the common cells (1.024 vs. 1.084).
- Qwen 3.8 is the lowest-penalty direct speech translator (2.108 common-cell mean). It is behind the five leading cascades and ahead of Qwen3-ASR 0.6B → Gemma.

## Timing: separate measurement boundaries

**Integrated cascade end-to-end latency was not measured.** ASR and LLM measurements were collected separately: do not add them and label the result measured E2E. Direct speech full-session times include realtime-paced context/current audio and must not be compared with LLM-only request times.

All values below are milliseconds; p95 uses R7 percentile interpolation.

### Cascade LLM-only requests

| Pipeline | n | Mean ms | p95 ms |
| --- | ---: | ---: | ---: |
| Gemini 3.5 Transcribe → GPT-6 Luna none | 648 | 1,595 | 2,446 |
| Soniox pure STT → GPT-6 Luna none | 648 | 1,511 | 2,077 |
| Qwen3-ASR 1.7B → Gemma 4 26B | 648 | 786 | 1,244 |
| Gemini 3.5 Transcribe → Gemma 4 26B | 648 | 799 | 1,289 |
| Soniox pure STT → Gemma 4 26B | 648 | 1,144 | 2,071 |
| Qwen3-ASR 0.6B → Gemma 4 26B | 648 | 788 | 1,208 |

### Separately collected ASR

| Component | Unit | n | Mean ms | p95 ms |
| --- | --- | ---: | ---: | ---: |
| Qwen3-ASR 0.6B | Isolated turn | 648 | 1,357 | 2,466 |
| Qwen3-ASR 1.7B | Isolated turn | 648 | 383 | 681 |
| Gemini 3.5 Transcribe | Isolated turn, realtime-paced audio session | 648 | 10,706 | 17,708 |
| Soniox pure STT | Multi-turn session | 215 / 216 initial sessions | 34,609 | 69,497 |

Qwen 0.6B measures the local decoder after audio read/validation; 1.7B measures a different local submit/decode path. Gemini includes session open, paced audio, sealing, authoritative transcript, and close. Soniox includes context/current turns and inserted 700 ms silence per turn. Its current-turn finalization wait is a separate client-observed interval (n=215, mean 281 ms, p95 710 ms), not full ASR time.

### Direct speech, realtime-paced full sessions

| Translator | Timed / 648 | Mean ms | p95 ms |
| --- | ---: | ---: | ---: |
| Qwen 3.8 Live Translate | 648 | 32,916 | 68,108 |
| Gemini 3.5 Live Translate | 640 | 37,684 | 75,820 |
| Soniox Translate | 643 | 33,996 | 69,359 |

Timed counts are not valid-judgment counts. Exact timing boundaries and saved metadata: [latency report](reports/fullstack-latency.json).

## Files

- [reports/fullstack-comparison.json](reports/fullstack-comparison.json) and [reports/fullstack-latency.json](reports/fullstack-latency.json) — verbatim source reports, including original metadata.
- `inputs/<run-id>/judge-normalized.jsonl` — all five complete, byte-identical judgment inputs named by the comparison report's `inputSha256`; the Gemma snapshot retains its `partial-first-batch/` subfolder.
- [inputs/asr-soniox-pure-medium-20260929-001/manifest.json](inputs/asr-soniox-pure-medium-20260929-001/manifest.json) — latest Soniox pure-STT cascade manifest, unchanged.
- [import-provenance.json](import-provenance.json) — source-to-local mapping and SHA-256 pins. Hash the mapped local files to verify every original `inputSha256` without the source repository. Source paths in the verbatim reports remain provenance identifiers.
- [Main Experiment 1 translations](../2026-09-integrated-15-system/translations.jsonl) and [manifest](../2026-09-integrated-15-system/manifest.json) — shared direct speech observations and setup; no duplicate direct translation datasets imported here.
