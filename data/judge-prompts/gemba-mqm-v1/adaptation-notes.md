# GEMBA-MQM v1 adaptation notes

- Upstream repo: MicrosoftTranslator/GEMBA
- Upstream commit: a7a7eff8e46998447c6cbf09d06affc8f1b99ab4
- Source files: `gemba/prompt.py`, `gemba/gemba_mqm_utils.py`
- Adaptations:
  - preserve the upstream MQM system line and rubric wording as closely as possible
  - preserve the upstream few-shot examples while converting assistant exemplars to the required JSON output shape
  - strict JSON output
  - sentence-only interpretation rule
  - target-language scope fixed to English, Japanese, Chinese Simplified
  - Vertex structured output schema
