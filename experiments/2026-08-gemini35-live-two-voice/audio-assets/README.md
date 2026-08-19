# Audio Assets Provenance (gemba-mqm-context-v1-two-voice)

This folder stores the provenance record for the TTS audio asset set used by the Gemini 3.5 Live Translate (Two Voice) participant.

- `manifest.json` — the canonical audio asset manifest: per-utterance PCM file references, per-file SHA-256 checksums, voice mapping (self: `sohee`, other: `uncle_fu`), and the full qwentts.cpp runtime/inference provenance (model GGUF SHA-256s, Vulkan backend evidence, converter arguments, seed 1234).

The actual PCM audio files (670 files, ~16 kHz mono) are not committed to this repository; the manifest's SHA-256 references are sufficient to verify a regenerated copy. Fingerprint of this manifest: `a1ef15154e6cec4bfd9a416603a00f14df8617951153a69ab598d0b558dcd04a` (recorded in `../manifest.json` as `audioAssetManifestFingerprintSha256`).
