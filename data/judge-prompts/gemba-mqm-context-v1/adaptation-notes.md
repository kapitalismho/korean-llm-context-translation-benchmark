# gemba-mqm-context-v1 adaptation notes

- Base the prompt set on the pinned `gemba-mqm-v1` assets rather than inventing a new rubric.
- Preserve the same MQM class inventory and severity scale.
- Extend only the user prompt contract and response schema so the judge can see Korean source-side context and emit `contextBehavior`.
- Keep context examples focused on current-utterance translation rather than document-level consistency.
