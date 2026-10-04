# Reproducibility

This project includes the runner used to produce the public experiment reports. Full reruns require provider APIs, credentials, local model servers, and a judge model.

## Setup

```bash
npm install
cp .env.example .env
```

Fill the provider credentials needed for the participants you run. Local llama.cpp arms need servers on ports 8081–8085 (`scripts/llama-server.ps1`); the Papago arm needs the Python bridge (`pip install -r scripts/papago-bridge-requirements.txt`).

## Published Main Experiments

The September results are imported collections, not new executions in this repository:

- [Experiment 1](../experiments/2026-09-integrated-15-system/) includes the 15-system reports and cell-level translation/judgment evidence.
- [Experiment 2](../experiments/2026-09-fullstack/) includes the nine-stack comparison, timing report, and judgment inputs.
- [Experiment 3](../experiments/2026-08-gemini35-live-10p-highjudge/ablation/) reuses the existing paired context artifacts.

The GPT-6 Luna, Qwen/Soniox speech, and ASR collection adapters live in the source collection project, `prompt-ab-tester`; the imported manifests describe those runs. The commands below document the earlier runner setup, not a fresh nine-stack execution.

## Earlier Experiment (2026-08, high judge)

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

The runner writes per-run report JSON files under `output/`. Regenerate Experiment 1's chart directly from the published report:

```bash
node --import tsx scripts/generate-ranking-chart.ts \
  --run-id unified-15arm-gpt6-luna-audio-20260927-001 \
  --summary-path experiments/2026-09-integrated-15-system/reports/summary-overall.penalty.json \
  --run-status-path experiments/2026-09-integrated-15-system/reports/run-status.json \
  --svg-out experiments/2026-09-integrated-15-system/assets/leaderboard.svg \
  --judge-label "Gemini 3.7 Flash"
```

This chart uses all 15 systems' all-valid means, matching the README table. The earlier August chart and its CER-subset row remain with the historical publication.

Regenerate Experiment 2 from the 618-cell common means:

```bash
node --import tsx scripts/generate-ranking-chart.ts \
  --run-id asr-soniox-pure-medium-20260929-001 \
  --summary-path experiments/2026-09-fullstack/reports/leaderboard-chart-input.json \
  --svg-out experiments/2026-09-fullstack/assets/leaderboard.svg \
  --title "Full-stack translation" \
  --subtitle "Korean → EN / JA / ZH-Hans · 618 common cells · Mean MQM penalty · Lower is better" \
  --judge-label "Gemini 3.7 Flash"
```

Regenerate Experiment 3 from the 642 valid A/B pairs:

```bash
node --import tsx scripts/generate-ranking-chart.ts \
  --run-id ablation-ab-highjudge-20260820 \
  --summary-path experiments/2026-08-gemini35-live-10p-highjudge/ablation/reports/leaderboard-chart-input.json \
  --svg-out experiments/2026-08-gemini35-live-10p-highjudge/ablation/assets/context-ablation-e4b-q4.svg \
  --title "Context effect" \
  --subtitle "Gemma 4 E4B QAT Q4 · 642 paired cells · Policy + history: 31.5% lower penalty" \
  --judge-label "Gemini 3.7 Flash"
```
