# Korean Multi-turn Context Translation Benchmark

GEMBA-MQM-based benchmark for Korean multi-turn context translation — LLMs vs. commercial translation services, including audio-native speech-to-speech translation.

- Korean conversational utterances (1–3 prior context turns) translated into English, Japanese, and Simplified Chinese
- Tests both required-context recovery (referents, ellipsis, register) and irrelevant-context rejection (topic shifts, false leads)
- A series of experiments on one frozen dataset — each experiment has its own prompt, judge, and participants, so **scores are not comparable across experiments**

## Current Experiment (2026-08)

- **Full details:** [Here](experiments/2026-08-gemini35-live-10p-highjudge/)
- **Setup:** Gemini 3.5 Live Translate (audio-native, two-voice TTS) vs. the 2026-08 text/MT field — Gemma 4 31B/26B, DeepSeek V4 Flash 0731, local Gemma 4 E4B arms (fp16/QAT Q4), MiLMMT 46-4B X0, Papago/DeepL/Google. All rows judged by Gemini 3.7 Flash (batch) with high reasoning effort; all translations are fork-reused from the issue-1 run, all cells are freshly judged

**Key findings:**

- Gemma 4 31B leads overall (0.353), ahead of Gemma 4 26B (0.387) and DeepSeek V4 Flash 0731 (0.571)
- DeepSeek 0731 is best on Simplified Chinese (0.329) and misses required context on only 2.8% of samples
- Papago is the strongest traditional MT service (2.699) vs. DeepL (3.914) and Google (5.731)
- Local Gemma 4 E4B degrades with quantization: FP16 1.353 → QAT Q4 1.577
- MiLMMT 46-4B fails in the native prompt regime: 3.087 (25.7% missed context)
- Gemini 3.5 Live Translate lands mid-pack (3.723): far behind the text LLMs (Gemma 4 31B 0.353, Gemma 4 26B 0.387, DeepSeek 0731 0.571), behind Papago (2.699), ahead of DeepL (3.914) and Google Basic (5.731). Even on the CER ≤ 5% subset (223 judged cells, 35% of Live sessions), its penalty is 2.991 — still far above the text LLMs
- Live misses required context on 9.2% of samples and misuses context on 6.0% — worse than the leading text models (1.2–2.8% missed, ≤0.9% misused)
- Live's ASR CER (current utterance) has mean 0.112 — roughly one wrong character per nine; correlation with quality penalty is weak (r = 0.29), and even the cleanest-CER samples score far below the text LLMs
- [CER caveats](experiments/2026-08-gemini35-live-10p-highjudge/README.md#caveats--read-before-citing-this-run): ASR analysis is unofficial, and the strict CER mean is above the 5% band
- Ablation appendix (context on/off, Gemma 4 E4B QAT Q4): full context beats sentence-only by 31.5% (1.452 vs. 2.118) — [Here](experiments/2026-08-gemini35-live-10p-highjudge/ablation/)

![Overall leaderboard: lower mean penalty is better](docs/assets/leaderboard-2026-08-highjudge.svg)

Primary score: raw mean penalty — lower is better.

| Rank | System | Mean penalty | Samples |
| ---: | --- | ---: | ---: |
| 1 | Gemma 4 31B | 0.353 | 648 |
| 2 | Gemma 4 26B A4B | 0.387 | 648 |
| 3 | DeepSeek V4 Flash 0731 | 0.571 | 648 |
| 4 | Gemma 4 E4B fp16 | 1.353 | 648 |
| 5 | Gemma 4 E4B QAT Q4 | 1.577 | 648 |
| 6 | Papago Web | 2.699 | 648 |
| 7 | MiLMMT 46-4B X0 | 3.087 | 647 |
| 8 | Gemini 3.5 Live Translate, CER ≤ 5% subset | 2.991 | 223 |
| 8 | Gemini 3.5 Live Translate | 3.723 | 638 |
| 9 | DeepL API | 3.914 | 642 |
| 10 | Google Cloud Translation Basic | 5.731 | 648 |

## Previous Experiment (2026-04, archived)

- **Full details:** [Here](experiments/2026-04-gemini-context-v2-archived/)
- Gemini 3.1 Flash-lite led (0.573); context-aware LLMs beat commercial services, context use beat no-context baselines
- Different prompt (`gemini-context-v2.md`) and judge (`gemini-3.1-pro-preview`) — **not directly comparable** with the current experiment

## Dataset

- `gemba-mqm-context-v1` — 216 Korean items × 3 target languages (fingerprint `9ab9e987…5110`)
- Runtime data: `data/datasets/gemba-mqm-context-v1/runtime.json` — authoring assets alongside

## Reproduction

```bash
npm install && cp .env.example .env
npm run bench:cli -- \
  --benchmark-config data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json \
  --participants gemini35-live-translate-two-voice \
  --judge-model google/gemini-3.7-flash:batch \
  --judge-backend openrouter-batch \
  --judge-reasoning-effort high
```

- Full reruns need provider API keys, the two-voice TTS asset pipeline, and a judge model — [Here](docs/reproducibility.md)

## Documentation

- Current experiment details: [Here](experiments/2026-08-gemini35-live-10p-highjudge/README.md)
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
