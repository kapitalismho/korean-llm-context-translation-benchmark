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

## Current Public Result Source

The primary public result source is run `gemba-mqm-context-v1-gemini-context-v2-expanded-nodeepl-api-20260429-011514`, using prompt `gemini-context-v2.md`, dataset fingerprint `9ab9e98752155a83cda100fc121f1b952474c82c1a20607887d9eb774855d110`, judge backend `vertex`, and judge model `gemini-3.1-pro-preview`.

DeepL rows come from reuse-only partial integrations and are annotated separately in `reports/leaderboard.overall.csv`.
