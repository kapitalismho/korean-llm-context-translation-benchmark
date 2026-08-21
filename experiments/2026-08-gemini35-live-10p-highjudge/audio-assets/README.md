# Audio Assets Provenance (gemba-mqm-context-v1-two-voice)

This folder stores the provenance record for the TTS audio asset set used by the Gemini 3.5 Live Translate (Two Voice) participant.

- `manifest.json` — the canonical audio asset manifest: per-utterance PCM file references, per-file SHA-256 checksums, voice mapping (self: `sohee`, other: `uncle_fu`), and the full qwentts.cpp runtime/inference provenance (model GGUF SHA-256s, Vulkan backend evidence, converter arguments, seed 1234).

The actual PCM audio files (648 files, ~16 kHz mono) are not committed to this repository; the manifest's SHA-256 references are sufficient to verify a regenerated copy. Fingerprint of this manifest: `98779efb78936b92c4b03ab7bb3feb66f0d9124da459bfb24488f0a74c03225f` (recorded in `../manifest.json` as `audioAssetManifestFingerprintSha256`). This is the corrected revision of the asset manifest: identical PCM content (all per-file SHA-256s unchanged) with `datasetFingerprintSha256` fixed from a stale value to the runtime dataset fingerprint `9ab9e987…5110`.
