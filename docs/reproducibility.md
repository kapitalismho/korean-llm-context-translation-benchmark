# Reproducibility

This project includes the runner used to produce the public reports. Full reruns require paid provider APIs, credentials, and a judge model.

## Setup

```bash
npm install
cp .env.example .env
```

Fill the provider credentials needed for the participants you run. Vertex AI judge runs require `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT`, and `GOOGLE_CLOUD_LOCATION`.

## Canonical Benchmark Config

Use:

```text
data/benchmarks/gemba-mqm-context-v1-gemini-context-v2.json
```

## Example Full-Style Run

```bash
npm run bench:cli -- \
  --benchmark-config data/benchmarks/gemba-mqm-context-v1-gemini-context-v2.json \
  --participant-registry data/participants/registry.json \
  --participants gemini-3.1-flash-lite,gemini-3-flash,gemma-4-26b-openrouter,qwen-3.5-plus,qwen-3.5-flash,deepseek-v4-flash,gemma-4-26b-openrouter-nocontext-baseline,deepseek-v4-flash-nocontext-baseline,google-cloud-translate-basic \
  --judge-model gemini-3.1-pro-preview \
  --translation-concurrency-per-model 1 \
  --judge-concurrency 6
```

## Regenerating Public Reports

After run artifacts exist under `output/`, run:

```bash
npm run reports:public
```

This writes stable public tables under `reports/` and strips private run fields from `reports/run-summary.json`.

To regenerate reports from a different run ID, pass explicit run IDs:

```bash
npm run reports:public -- \
  --main-run-id your-main-run-id \
  --deepl-context-run-id your-deepl-context-run-id \
  --deepl-nocontext-run-id your-deepl-nocontext-run-id
```

Omit the DeepL flags if you did not create DeepL reuse runs.
