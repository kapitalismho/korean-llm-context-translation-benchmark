# Reproducibility

This project includes the runner used to produce the public experiment reports. Full reruns require provider APIs, credentials, local model servers, and a judge model.

## Setup

```bash
npm install
cp .env.example .env
```

Fill the provider credentials needed for the participants you run. Local llama.cpp arms need servers on ports 8081–8085 (`scripts/llama-server.ps1`); the Papago arm needs the Python bridge (`pip install -r scripts/papago-bridge-requirements.txt`).

## Current Experiment (2026-08, high judge)

Benchmark config:

```text
data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json
```

The published run (`unified-12arm-highjudge-20260822`) is a unified 12-arm collect: the 10 carried arms reuse translations and high-effort judgments byte-identical from `gemini35-live-10p-highjudge-20260820` (translations descend from `gemini35-live-two-voice-20260817`), while `hymt2-7b-q4xl` and `gemma4-12b-qat-q4xl` were translated and judged fresh. A reproduction of the collect would be:

```bash
npm run bench:cli -- \
  --benchmark-config data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json \
  --participant-registry data/participants/registry.json \
  --participants gemma4-e4b-qat-q4,gemma4-e4b-fp16,milmmt-4b-native,gemma4-31b,gemma-4-26b-openrouter,google-cloud-translate-basic,deepl-api,papago-web,deepseek-v4-flash-0731-openrouter,gemini35-live-translate-two-voice,hymt2-7b-q4xl,gemma4-12b-qat-q4xl \
  --fork-from-run gemini35-live-two-voice-20260817 \
  --fork-allow-prompt-mismatch \
  --judge-model google/gemini-3.7-flash:batch \
  --judge-backend openrouter-batch \
  --judge-reasoning-effort high \
  --translation-concurrency-per-model 1 \
  --judge-concurrency 6
```

The fork covers the 10 carried arms; the two new arms have no source rows and therefore run fresh (local llama.cpp servers on ports 8084/8085 respectively). The Gemini 3.5 Live Translate arm is not defined in this repository's registry (its `gemini-live-translate` provider harness and the TTS asset pipeline live with the audio-native collection setup); its provenance is pinned in `experiments/2026-08-gemini35-live-10p-highjudge/audio-assets/manifest.json`.

The Live arm additionally requires:

- the TTS audio asset pipeline that produced `gemba-mqm-context-v1-two-voice` (see `experiments/2026-08-gemini35-live-10p-highjudge/audio-assets/manifest.json` for the model files, voices `sohee`/`uncle_fu`, and qwentts.cpp runtime used), and
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

The 2026-04 run used `data/benchmarks/gemba-mqm-context-v1-gemini-context-v2.json` with the Vertex AI judge (`gemini-3.1-pro-preview`). Its reproduction command is preserved in the git history of this file (see commits before 2026-08) and its provenance in `experiments/2026-04-gemini-context-v2-archived/reports/run-summary.json`.

## Regenerating Reports

After run artifacts exist under `output/`, the runner writes per-run report JSON files (as published under `experiments/<experiment>/reports/`). The chart for the current experiment can be regenerated with:

```bash
node --import tsx scripts/generate-ranking-chart.ts \
  --run-id unified-12arm-highjudge-20260822 \
  --summary-path experiments/2026-08-gemini35-live-10p-highjudge/reports/leaderboard-chart-input.json \
  --run-status-path experiments/2026-08-gemini35-live-10p-highjudge/reports/run-status.json \
  --svg-out docs/assets/leaderboard-2026-08-highjudge.svg \
  --judge-label "Gemini 3.7 Flash (high reasoning effort)"
```

`leaderboard-chart-input.json` is `summary-overall.penalty.json` plus the standalone "Gemini 3.5 Live Translate, CER ≤ 5% subset" row (`gemini35-live-cer-le5-subset`, mean from `ASR-CER-summary-high.json → headline.le5_inclusive`) so the chart matches the README leaderboard. Convert the SVG to PNG at 2× (e.g., headless Chrome: `chrome --headless=new --force-device-scale-factor=2 --window-size=960,586 --screenshot=…`).
