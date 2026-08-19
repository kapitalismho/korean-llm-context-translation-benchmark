# Reproducibility

This project includes the runner used to produce the public experiment reports. Full reruns require provider APIs, credentials, local model servers, and a judge model.

## Setup

```bash
npm install
cp .env.example .env
```

Fill the provider credentials needed for the participants you run. Local llama.cpp arms need servers on ports 8080–8083 (`scripts/llama-server.ps1`); the Papago arm needs the Python bridge (`pip install -r scripts/papago-bridge-requirements.txt`).

## Current Experiment (2026-08 Live)

Benchmark config:

```text
data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json
```

The published Live run (`gemini35-live-two-voice-20260817`) is a fork of the issue-1 run: 7,124 cells were copied from `issue1-milmmt-e4b-papago-deepseek-0731-integrated-20260815-01` and only the 640 Gemini 3.5 Live Translate cells were newly translated. A fresh Live-only run would be:

```bash
npm run bench:cli -- \
  --benchmark-config data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json \
  --participant-registry data/participants/registry.json \
  --participants gemini35-live-translate-two-voice \
  --judge-model google/gemini-3.7-flash:batch \
  --judge-backend openrouter-batch
```

The Live arm additionally requires:

- the TTS audio asset pipeline that produced `gemba-mqm-context-v1-two-voice` (see `experiments/2026-08-gemini35-live-two-voice/audio-assets/manifest.json` for the model files, voices `sohee`/`uncle_fu`, and qwentts.cpp runtime used), and
- a `gemini-live-translate-no-prompt.md` provenance marker matching the recorded fingerprint (its contents are never sent to the Live session).

Full issue-1-style reruns (all text participants) are documented in `experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/README.md#reproduction` and below.

## Archived Experiment (2026-08 issue-1)

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

The launch helper `scripts/experiment/launch-issue1.ps1` wraps the full sequence used for the published issue-1 run, including the fork-and-merge integration (`scripts/experiment/prepare-integrated-papago-deepseek.ts`).

## Archived Experiment (2026-04)

The 2026-04 run used `data/benchmarks/gemba-mqm-context-v1-gemini-context-v2.json` with the Vertex AI judge (`gemini-3.1-pro-preview`). Its reproduction command is preserved in the git history of this file (see commits before 2026-08) and its provenance in `experiments/2026-04-gemini-context-v2/reports/run-summary.json`.

## Regenerating Reports

After run artifacts exist under `output/`, the runner writes per-run report JSON files (as published under `experiments/<experiment>/reports/`). The chart for the current experiment can be regenerated with:

```bash
node --import tsx scripts/generate-ranking-chart.ts \
  --run-id gemini35-live-two-voice-20260817 \
  --summary-path experiments/2026-08-gemini35-live-two-voice/reports/summary-overall.penalty.json \
  --run-status-path experiments/2026-08-gemini35-live-two-voice/reports/run-status.json \
  --svg-out docs/assets/leaderboard-2026-08-live.svg \
  --judge-label "Gemini 3.7 Flash"
```
