# Korean Multi-turn Context Translation Benchmark

GEMBA-MQM-based benchmark for Korean multi-turn context translation — LLMs vs. commercial translation services.

- Korean conversational utterances (1–3 prior context turns) translated into English, Japanese, and Simplified Chinese
- Tests both required-context recovery (referents, ellipsis, register) and irrelevant-context rejection (topic shifts, false leads)
- A series of experiments on one frozen dataset — each experiment has its own prompt, judge, and participants, so **scores are not comparable across experiments**

## Current Experiment (2026-08)

- **Full details:** [Here](experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731/)
- **Setup:** Gemma 4 31B/26B, DeepSeek V4 Flash 0731, three local Gemma 4 E4B arms (llama.cpp), two MiLMMT 46-4B arms, Papago/DeepL/Google — PuriPuly prompt, judged by Gemini 3.7 Flash

**Key findings:**

- Gemma 4 31B leads overall (0.333), ahead of Gemma 4 26B (0.403) and DeepSeek V4 Flash 0731 (0.606)
- DeepSeek 0731 is best on Simplified Chinese (0.327) and misses required context on only 1.9% of samples
- Papago is the strongest traditional MT service (2.801) vs. DeepL (4.107) and Google (5.810)
- Local Gemma 4 E4B degrades with quantization: FP16 1.311 → QAT Q4 1.639 → QAT Q2 collapses at 9.460
- MiLMMT 46-4B fails in both prompt regimes: native 2.949 (24.1% missed context), Context policy 11.500 (25.5% misused context)

![Overall leaderboard: lower mean penalty is better](docs/assets/leaderboard-2026-08.svg)

Primary score: raw mean penalty — lower is better.

| Rank | System | Mean penalty | Samples |
| ---: | --- | ---: | ---: |
| 1 | Gemma 4 31B | 0.333 | 648 |
| 2 | Gemma 4 26B A4B | 0.403 | 648 |
| 3 | DeepSeek V4 Flash 0731 | 0.606 | 648 |
| 4 | Gemma 4 E4B FP16 | 1.311 | 647 |
| 5 | Gemma 4 E4B QAT Q4 | 1.639 | 648 |
| 6 | Papago | 2.801 | 648 |
| 7 | MiLMMT 46-4B | 2.949 | 648 |
| 8 | DeepL | 4.107 | 643 |
| 9 | Google Translation Basic | 5.810 | 648 |
| 10 | Gemma 4 E4B QAT Q2| 9.460 | 631 |
| 11 | MiLMMT 46-4B Context policy | 11.500 | 648 |

## Previous Experiment (2026-04)

- **Full details:** [Here](experiments/2026-04-gemini-context-v2/)
- Gemini 3.1 Flash-lite led (0.573); context-aware LLMs beat commercial services, context use beat no-context baselines
- Different prompt (`gemini-context-v2.md`) and judge (`gemini-3.1-pro-preview`) — **not directly comparable** with 2026-08

## Dataset

- `gemba-mqm-context-v1` — 216 Korean items × 3 target languages (fingerprint `9ab9e987…5110`)
- Runtime data: `data/datasets/gemba-mqm-context-v1/runtime.json` — authoring assets alongside

## Reproduction

```bash
npm install && cp .env.example .env
npm run bench:cli -- \
  --benchmark-config data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json \
  --participants gemma4-31b,gemma-4-26b-openrouter,deepseek-v4-flash-0731-openrouter \
  --judge-model google/gemini-3.7-flash:batch \
  --judge-backend openrouter-batch
```

- Full reruns need provider API keys, local llama.cpp servers, and a judge model — [Here](docs/reproducibility.md)

## Documentation

- Current experiment details: [Here](experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731/README.md)
- Methodology & experiment comparison: [Here](docs/methodology.md)
- Result analysis: [Here](docs/results.md)
- Evaluation (GEMBA-MQM judging): [Here](docs/evaluation.md)
- Dataset schema & authoring: [Here](docs/dataset.md)
- Limitations: [Here](docs/limitations.md)
- Reproducibility: [Here](docs/reproducibility.md)

## License

- Code: MIT
- Dataset & public reports: CC BY 4.0 (`data/LICENSE`)
- Vendored GEMBA: upstream license (`docs/third-party-notices.md`)
