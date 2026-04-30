# Evaluation

The benchmark uses reference-free GEMBA-MQM-based judging adapted for Korean multi-turn context translation. For each participant output, the judge receives the Korean source item, context metadata, target language, and translation. The judge emits structured errors with severity and class labels.

## Severity Weights

- minor: 1
- major: 5
- critical: 25

The cell penalty is the sum of error severity weights. The public leaderboard reports mean cell penalty.

## Judge Configuration

The public result set uses:

- judge backend: Vertex AI
- judge model: `gemini-3.1-pro-preview`
- judge prompt set: `gemba-mqm-context-v1`

The runner also supports a Gemini CLI judge backend for experiments, but public benchmark reports should identify the judge backend used.

## Context Behavior Labels

The judge also records context behavior labels:

- `used_correctly`
- `missed_required_context`
- `ignored_irrelevant_context`
- `misused_context`
- `unclear`

These labels support context-use and context-ignore slice analysis in `reports/context-behavior.csv`.
