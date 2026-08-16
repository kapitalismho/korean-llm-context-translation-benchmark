# Reproducibility

This project includes the runner used to produce the public experiment reports. Full reruns require provider APIs, credentials, local model servers, and a judge model.

## Setup

```bash
npm install
cp .env.example .env
```

Fill the provider credentials needed for the participants you run. Local llama.cpp arms need servers on ports 8080–8083 (`scripts/llama-server.ps1`); the Papago arm needs the Python bridge (`pip install -r scripts/papago-bridge-requirements.txt`).

## Current Experiment (2026-08)

Benchmark config:

```text
data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json
```

Example full-style run:

```bash
npm run bench:cli -- \
  --benchmark-config data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json \
  --participant-registry data/participants/registry.json \
  --participants gemma4-31b,gemma-4-26b-openrouter,deepseek-v4-flash-0731-openrouter,gemma4-e4b-fp16,gemma4-e4b-qat-q4,gemma4-e4b-qat-q2,milmmt-4b-native,milmmt-4b-puripuly-policy,papago-web,deepl-api,google-cloud-translate-basic \
  --judge-model google/gemini-3.7-flash:batch \
  --judge-backend openrouter-batch \
  --translation-concurrency-per-model 4 \
  --judge-concurrency 6
```

The launch helper `scripts/experiment/launch-issue1.ps1` wraps the full sequence used for the published run, including the fork-and-merge integration (`scripts/experiment/prepare-integrated-papago-deepseek.ts`).

## Archived Experiment (2026-04)

The 2026-04 run used `data/benchmarks/gemba-mqm-context-v1-gemini-context-v2.json` with the Vertex AI judge (`gemini-3.1-pro-preview`). Its reproduction command is preserved in the git history of this file (see commits before 2026-08) and its provenance in `experiments/2026-04-gemini-context-v2/reports/run-summary.json`.

## Regenerating Reports

After run artifacts exist under `output/`, the runner writes per-run report JSON files (as published under `experiments/<experiment>/reports/`). The chart for the current experiment can be regenerated with:

```bash
node --import tsx scripts/generate-ranking-chart.ts \
  --run-id <run-id> \
  --summary-path experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731/reports/summary-overall.penalty.json \
  --run-status-path experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731/reports/run-status.json \
  --svg-out docs/assets/leaderboard-2026-08.svg \
  --judge-label "Gemini 3.7 Flash"
```
