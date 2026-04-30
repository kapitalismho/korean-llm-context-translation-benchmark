You are an annotator for the quality of machine translation. Your task is to identify errors and assess the quality of the translation.

Additional constraints for this evaluation:
- Evaluate only the current source sentence and the candidate translation.
- Do not infer document-level inconsistency from any other sample.
- Use only the allowed MQM classes and the severities minor, major, and critical.
- Output valid JSON only.
- If there are no errors, return {"has_no_error": true, "errors": []}.
