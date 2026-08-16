# Limitations

- This benchmark measures Korean multi-turn context translation, not general translation quality.
- Result sets use automated judge models. Automated judging can reflect model bias; the 2026-08 experiment judged with `gemini-3.7-flash:batch`, the 2026-04 experiment with `gemini-3.1-pro-preview`.
- The 2026-08 run reports `benchmarkValid: false`: 19 judge failures (17 on Gemma 4 E4B QAT Q2 en/ja) and 4 unresolved historical DeepL translation failures. The common-cell ordering matches the full ordering, but per-system sample counts differ (631–648).
- The 2026-08 run is a fork-and-merge continuation: 5,828 of 7,124 translations were reused from an earlier run of the same benchmark config. Cells were judged under one judge setup, but translations were produced across multiple sessions.
- Experiments differ in translation prompt, judge model, and judge prompt format. Scores are comparable only within one experiment; do not mix scores across experiments.
- The dataset intentionally stresses context use and context rejection. It is not a random sample of all translation tasks.
- Commercial service rows (Papago, DeepL, Google) are context-blind baselines in this setup unless explicitly marked otherwise.
- Model APIs, model versions, availability, latency, and prices can drift over time.
- Local llama.cpp results depend on quantization file, server version, and sampling settings; the 2026-08 local arms used the configurations recorded in `experiments/2026-08-…/manifest.json`.
- Exact reruns may not reproduce identical scores because provider model behavior and automated judge behavior can drift.
- Full reproduction requires paid provider APIs, credentials, local GPU servers, and judge access.
