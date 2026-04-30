# Third-Party Notices

## GEMBA / MQM Materials

This project uses a GEMBA-MQM-based evaluation adapted for Korean multi-turn context translation. It adapts GEMBA-MQM evaluation concepts and prompt material; vendored upstream material is preserved under `vendor/gemba/`.

Reference: Kocmi and Federmann (2023), "GEMBA-MQM: Detecting Translation Quality Error Spans with GPT-4".

Vendored GEMBA commit: `a7a7eff8e46998447c6cbf09d06affc8f1b99ab4`.

Vendored GEMBA material is not licensed under this repository's MIT code license unless the upstream license explicitly says so. Keep the upstream license files in `vendor/gemba/`, preserve upstream copyright notices, and treat the vendored material according to its original license terms, including any attribution or share-alike requirements.

The public release includes a GEMBA license notice at `vendor/gemba/LICENSE.md`. The upstream license URL is <https://github.com/MicrosoftTranslator/GEMBA/blob/main/LICENSE.md>; the vendored material retains the upstream CC BY-SA 4.0 notice.

## Provider APIs

The runner can call third-party model APIs including Gemini, Qwen/DashScope, OpenRouter, DeepSeek, DeepL, Google Cloud Translation Basic, and Vertex AI. Users are responsible for complying with each provider's terms when running the benchmark.

## Dataset, Reports, and Code

Dataset and public reports are licensed under CC BY 4.0. Benchmark-owned code is licensed under MIT. Vendored third-party material retains its upstream license.
