# gemba-mqm-context-v1 adaptation notes

- Base the prompt set on the pinned `gemba-mqm-v1` assets rather than inventing a new rubric.
- Preserve the same MQM class inventory and severity scale.
- Use the upstream GEMBA-MQM **text annotation format** (Critical:/Major:/Minor: severity sections with `<class> - "<span>"` error lines) instead of JSON structured output; the client parses and validates the text response.
- Extend the input contract so the judge can see Korean source-side context: the source block lists prior conversation turns followed by the current utterance on the last line.
- Extend the output contract with a trailing `contextBehavior:` line so the judge reports context use/ignore behavior.
- Keep context examples focused on current-utterance translation rather than document-level consistency.
