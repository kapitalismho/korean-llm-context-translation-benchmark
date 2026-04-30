Target language: ${targetLanguageLabel}
Context (oldest to newest):
${contextBlock}

Current source:
```${currentSource}```

Candidate translation:
```${translation}```

Evaluate only the translation of the current source utterance. Use previous Korean source turns only as context for disambiguation. If the current source should be interpreted independently, penalize context-driven errors rather than rewarding forced carryover.

Return JSON with:
{
  "has_no_error": boolean,
  "errors": [...],
  "contextBehavior": "used_correctly" | "missed_required_context" | "ignored_irrelevant_context" | "misused_context" | "unclear"
}
