# Evaluation

The benchmark uses reference-free GEMBA-MQM-based judging adapted for Korean multi-turn context translation. For each participant output, the judge receives the Korean source item (prior context turns followed by the current utterance), target language, and translation. The judge emits errors with severity and class labels plus a context behavior verdict.

## Severity Weights

- minor: 1
- major: 5
- critical: 25

The cell penalty is the sum of error severity weights. The public leaderboards report mean cell penalty.

## Judge Prompt Format

The current judge prompt set (`data/judge-prompts/gemba-mqm-context-v1/`) uses the upstream GEMBA-MQM text annotation format — `Critical:` / `Major:` / `Minor:` severity sections with `<class> - "<span>"` error lines — extended with a trailing `contextBehavior:` line. The client parses and validates the text response. The 2026-04 experiment used an earlier JSON-output version of the same prompt set, preserved under `experiments/2026-04-gemini-context-v2/judge-prompts/`.

## Judge Configuration

- 2026-08 experiment: judge backend `openrouter-batch`, judge model `google/gemini-3.7-flash:batch`
- 2026-04 experiment: judge backend `vertex`, judge model `gemini-3.1-pro-preview`

The runner also supports a Vertex AI judge backend and a Gemini CLI judge backend for experiments, but public benchmark reports should identify the judge backend used.

## Context Behavior Labels

The judge also records context behavior labels:

- `used_correctly`
- `missed_required_context`
- `ignored_irrelevant_context`
- `misused_context`
- `unclear`

These labels support context-use and context-ignore slice analysis (see `context-behavior.*` in each experiment's `reports/` folder).
