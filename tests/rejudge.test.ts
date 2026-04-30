import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BenchmarkConfig } from '../src/benchmark-config.js';
import type { Condition } from '../src/llm-client.js';
import { prepareRejudgeRun, rewriteTranslationRecordForRun } from '../src/rejudge.js';
import { readJsonlRecords } from '../src/run-artifacts.js';
import { TestRunner } from '../src/runner.js';

const DATASET_FINGERPRINT = 'a'.repeat(64);
const PROMPT_FINGERPRINT = 'b'.repeat(64);
const SENTENCE_TRACK_FIELDS = {
  datasetKind: 'sentence',
  judgePromptSetId: 'gemba-mqm-v1',
} as const;

test('rewriteTranslationRecordForRun rewrites the stable key and keeps provenance', () => {
  const rewritten = rewriteTranslationRecordForRun({
    stable_key: 'old-run::1::ja::qwen3.5-plus',
    source_id: '1',
    source: 'Hello',
    source_lang: 'en',
    target_language: 'ja',
    target_language_label: 'Japanese',
    participant_id: 'qwen-3.5-plus',
    participant_model_id: 'qwen3.5-plus',
    translation: 'こんにちは',
    context_turn_count: 2,
    speaker_mode: 'dyadic',
    context_expectation: 'use',
    primary_phenomenon: 'referent_resolution',
  }, 'new-run', 'old-run');

  assert.equal(rewritten.stable_key, 'new-run::1::ja::qwen-3.5-plus');
  assert.equal(rewritten.source_run_id, 'old-run');
  assert.equal(rewritten.source_stable_key, 'old-run::1::ja::qwen3.5-plus');
  assert.equal(rewritten.context_turn_count, 2);
  assert.equal(rewritten.speaker_mode, 'dyadic');
  assert.equal(rewritten.context_expectation, 'use');
  assert.equal(rewritten.primary_phenomenon, 'referent_resolution');
});

test('prepareRejudgeRun preserves source manifest provenance for a complete source run', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'rejudge-run-'));

  try {
    const sourceRunDir = join(outputDir, 'run-source');
    mkdirSync(sourceRunDir, { recursive: true });

    writeFileSync(join(sourceRunDir, 'manifest.json'), `${JSON.stringify({
      manifestVersion: 3,
      runId: 'run-source',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      judgeModelId: 'gemini-2.5-flash',
      targetLanguages: ['en', 'ja'],
      targetLanguageLabels: {
        en: 'English',
        ja: 'Japanese',
      },
      limitApplied: 2,
      participants: [
        {
          participantId: 'qwen-3.5-plus',
          displayName: 'Qwen 3.5 Plus',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
      ],
      translationConcurrencyPerModel: 3,
      resume: false,
    }, null, 2)}\n`);
    writeFileSync(join(sourceRunDir, 'translations.jsonl'), [
      JSON.stringify({
        stable_key: 'run-source::1::en::qwen-3.5-plus',
        source_id: '1',
        source: 'Hello',
        source_lang: 'en',
        target_language: 'en',
        target_language_label: 'English',
        participant_id: 'qwen-3.5-plus',
        participant_model_id: 'qwen3.5-plus',
        translation: 'Hello',
      }),
      JSON.stringify({
        stable_key: 'run-source::1::ja::qwen-3.5-plus',
        source_id: '1',
        source: 'Hello',
        source_lang: 'en',
        target_language: 'ja',
        target_language_label: 'Japanese',
        participant_id: 'qwen-3.5-plus',
        participant_model_id: 'qwen3.5-plus',
        translation: 'こんにちは',
        context_turn_count: 2,
        speaker_mode: 'dyadic',
        context_expectation: 'use',
        primary_phenomenon: 'referent_resolution',
      }),
      JSON.stringify({
        stable_key: 'run-source::2::en::qwen-3.5-plus',
        source_id: '2',
        source: 'World',
        source_lang: 'en',
        target_language: 'en',
        target_language_label: 'English',
        participant_id: 'qwen-3.5-plus',
        participant_model_id: 'qwen3.5-plus',
        translation: 'World',
      }),
      JSON.stringify({
        stable_key: 'run-source::2::ja::qwen-3.5-plus',
        source_id: '2',
        source: 'World',
        source_lang: 'en',
        target_language: 'ja',
        target_language_label: 'Japanese',
        participant_id: 'qwen-3.5-plus',
        participant_model_id: 'qwen3.5-plus',
        translation: '世界',
      }),
    ].join('\n') + '\n');

    const prepared = prepareRejudgeRun({
      outputDir,
      sourceRunId: 'run-source',
      newRunId: 'run-rejudge',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      targetLanguages: ['en', 'ja'],
      targetLanguageLabels: {
        en: 'English',
        ja: 'Japanese',
      },
      judgePromptVersion: 'gemba-mqm-v1',
      judgeModelId: 'gemini-3.1-pro-preview',
      vertexProject: null,
      vertexRegion: null,
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
    });

    const manifest = JSON.parse(readFileSync(prepared.layout.manifestPath, 'utf8')) as Record<string, unknown>;
    const copiedTranslations = readJsonlRecords<Array<Record<string, unknown>>[number]>(prepared.layout.translationJsonlPath);

    assert.equal(manifest.manifestVersion, 3);
    assert.equal(manifest.promptVersion, 'source-prompt.md');
    assert.equal(manifest.datasetVersion, 'sentences.json');
    assert.equal(manifest.datasetKind, 'sentence');
    assert.equal(manifest.datasetFingerprintSha256, DATASET_FINGERPRINT);
    assert.equal(manifest.limitApplied, 2);
    assert.equal(manifest.promptFingerprintSha256, PROMPT_FINGERPRINT);
    assert.equal(manifest.judgePromptSetId, 'gemba-mqm-v1');
    assert.equal(manifest.translationConcurrencyPerModel, 3);
    assert.equal(manifest.rejudgeFromRunId, 'run-source');
    assert.equal(manifest.reusedTranslations, true);
    assert.deepEqual((manifest.participants as Array<{ participantId: string }>).map((participant) => participant.participantId), ['qwen-3.5-plus']);
    assert.equal(prepared.translationCount, 4);
    assert.equal(copiedTranslations[1]?.context_turn_count, 2);
    assert.equal(copiedTranslations[1]?.speaker_mode, 'dyadic');
    assert.equal(copiedTranslations[1]?.context_expectation, 'use');
    assert.equal(copiedTranslations[1]?.primary_phenomenon, 'referent_resolution');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareRejudgeRun rejects source runs whose datasetKind does not match the requested rejudge configuration', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'rejudge-run-'));

  try {
    const sourceRunDir = join(outputDir, 'run-source');
    mkdirSync(sourceRunDir, { recursive: true });

    writeFileSync(join(sourceRunDir, 'manifest.json'), `${JSON.stringify({
      manifestVersion: 3,
      runId: 'run-source',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      judgeModelId: 'gemini-2.5-flash',
      targetLanguages: ['ja'],
      targetLanguageLabels: {
        ja: 'Japanese',
      },
      limitApplied: 0,
      participants: [
        {
          participantId: 'qwen-3.5-plus',
          displayName: 'Qwen 3.5 Plus',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
      ],
      translationConcurrencyPerModel: 1,
      resume: false,
    }, null, 2)}\n`);
    writeFileSync(join(sourceRunDir, 'translations.jsonl'), '');

    assert.throws(
      () => prepareRejudgeRun({
        outputDir,
        sourceRunId: 'run-source',
        newRunId: 'run-rejudge',
        benchmarkId: 'gemba-mqm-v1',
        datasetVersion: 'sentences.json',
        datasetKind: 'context',
        judgePromptSetId: 'gemba-mqm-v1',
        datasetFingerprintSha256: DATASET_FINGERPRINT,
        targetLanguages: ['ja'],
        targetLanguageLabels: {
          ja: 'Japanese',
        },
        judgePromptVersion: 'gemba-mqm-v1',
        judgeModelId: 'gemini-3.1-pro-preview',
        vertexProject: null,
        vertexRegion: null,
        vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      }),
      /source run datasetKind does not match the requested rejudge configuration/i,
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareRejudgeRun rejects source runs whose judgePromptSetId does not match the requested rejudge configuration', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'rejudge-run-'));

  try {
    const sourceRunDir = join(outputDir, 'run-source');
    mkdirSync(sourceRunDir, { recursive: true });

    writeFileSync(join(sourceRunDir, 'manifest.json'), `${JSON.stringify({
      manifestVersion: 3,
      runId: 'run-source',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      judgeModelId: 'gemini-2.5-flash',
      targetLanguages: ['ja'],
      targetLanguageLabels: {
        ja: 'Japanese',
      },
      limitApplied: 0,
      participants: [
        {
          participantId: 'qwen-3.5-plus',
          displayName: 'Qwen 3.5 Plus',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
      ],
      translationConcurrencyPerModel: 1,
      resume: false,
    }, null, 2)}\n`);
    writeFileSync(join(sourceRunDir, 'translations.jsonl'), '');

    assert.throws(
      () => prepareRejudgeRun({
        outputDir,
        sourceRunId: 'run-source',
        newRunId: 'run-rejudge',
        benchmarkId: 'gemba-mqm-v1',
        datasetVersion: 'sentences.json',
        datasetKind: 'sentence',
        judgePromptSetId: 'gemba-mqm-context-v1',
        datasetFingerprintSha256: DATASET_FINGERPRINT,
        targetLanguages: ['ja'],
        targetLanguageLabels: {
          ja: 'Japanese',
        },
        judgePromptVersion: 'gemba-mqm-v1',
        judgeModelId: 'gemini-3.1-pro-preview',
        vertexProject: null,
        vertexRegion: null,
        vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      }),
      /source run judgePromptSetId does not match the requested rejudge configuration/i,
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareRejudgeRun rejects partial source runs even when no failure records exist', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'rejudge-run-'));

  try {
    const sourceRunDir = join(outputDir, 'run-source');
    mkdirSync(sourceRunDir, { recursive: true });

    writeFileSync(join(sourceRunDir, 'manifest.json'), `${JSON.stringify({
      manifestVersion: 3,
      runId: 'run-source',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      judgeModelId: 'gemini-2.5-flash',
      targetLanguages: ['en', 'ja'],
      targetLanguageLabels: {
        en: 'English',
        ja: 'Japanese',
      },
      limitApplied: 2,
      participants: [
        {
          participantId: 'qwen-3.5-plus',
          displayName: 'Qwen 3.5 Plus',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
      ],
      translationConcurrencyPerModel: 1,
      resume: false,
    }, null, 2)}\n`);
    writeFileSync(join(sourceRunDir, 'translations.jsonl'), [
      JSON.stringify({
        stable_key: 'run-source::1::en::qwen-3.5-plus',
        source_id: '1',
        source: 'Hello',
        source_lang: 'en',
        target_language: 'en',
        target_language_label: 'English',
        participant_id: 'qwen-3.5-plus',
        participant_model_id: 'qwen3.5-plus',
        translation: 'Hello',
      }),
      JSON.stringify({
        stable_key: 'run-source::1::ja::qwen-3.5-plus',
        source_id: '1',
        source: 'Hello',
        source_lang: 'en',
        target_language: 'ja',
        target_language_label: 'Japanese',
        participant_id: 'qwen-3.5-plus',
        participant_model_id: 'qwen3.5-plus',
        translation: 'こんにちは',
      }),
      JSON.stringify({
        stable_key: 'run-source::2::en::qwen-3.5-plus',
        source_id: '2',
        source: 'World',
        source_lang: 'en',
        target_language: 'en',
        target_language_label: 'English',
        participant_id: 'qwen-3.5-plus',
        participant_model_id: 'qwen3.5-plus',
        translation: 'World',
      }),
    ].join('\n') + '\n');

    assert.throws(
      () => prepareRejudgeRun({
        outputDir,
        sourceRunId: 'run-source',
        newRunId: 'run-rejudge',
        benchmarkId: 'gemba-mqm-v1',
        datasetVersion: 'sentences.json',
        ...SENTENCE_TRACK_FIELDS,
        datasetFingerprintSha256: DATASET_FINGERPRINT,
        targetLanguages: ['en', 'ja'],
        targetLanguageLabels: {
          en: 'English',
          ja: 'Japanese',
        },
        judgePromptVersion: 'gemba-mqm-v1',
        judgeModelId: 'gemini-3.1-pro-preview',
        vertexProject: null,
        vertexRegion: null,
        vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      }),
      /translation success coverage/i,
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareRejudgeRun rejects pre-v3 source manifests explicitly', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'rejudge-run-'));

  try {
    const sourceRunDir = join(outputDir, 'run-source');
    mkdirSync(sourceRunDir, { recursive: true });

    writeFileSync(join(sourceRunDir, 'manifest.json'), `${JSON.stringify({
      manifestVersion: 2,
      runId: 'run-source',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      judgeModelId: 'gemini-2.5-flash',
      targetLanguages: ['en', 'ja'],
      targetLanguageLabels: {
        en: 'English',
        ja: 'Japanese',
      },
      limitApplied: 1,
      participants: [
        {
          participantId: 'qwen-3.5-plus',
          displayName: 'Qwen 3.5 Plus',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
      ],
      translationConcurrencyPerModel: 1,
    }, null, 2)}\n`);
    writeFileSync(join(sourceRunDir, 'translations.jsonl'), '');

    assert.throws(
      () => prepareRejudgeRun({
        outputDir,
        sourceRunId: 'run-source',
        newRunId: 'run-rejudge',
        benchmarkId: 'gemba-mqm-v1',
        datasetVersion: 'sentences.json',
        ...SENTENCE_TRACK_FIELDS,
        datasetFingerprintSha256: DATASET_FINGERPRINT,
        targetLanguages: ['en', 'ja'],
        targetLanguageLabels: {
          en: 'English',
          ja: 'Japanese',
        },
        judgePromptVersion: 'gemba-mqm-v1',
        judgeModelId: 'gemini-3.1-pro-preview',
        vertexProject: null,
        vertexRegion: null,
        vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      }),
      /pre-v3 runs are unsupported for rejudge/i,
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareRejudgeRun rejects in-place dataset edits even when the basename is unchanged', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'rejudge-run-'));

  try {
    const sourceRunDir = join(outputDir, 'run-source');
    mkdirSync(sourceRunDir, { recursive: true });

    writeFileSync(join(sourceRunDir, 'manifest.json'), `${JSON.stringify({
      manifestVersion: 3,
      runId: 'run-source',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      judgeModelId: 'gemini-2.5-flash',
      targetLanguages: ['ja'],
      targetLanguageLabels: {
        ja: 'Japanese',
      },
      limitApplied: 1,
      participants: [
        {
          participantId: 'qwen-3.5-plus',
          displayName: 'Qwen 3.5 Plus',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
      ],
      translationConcurrencyPerModel: 1,
      resume: false,
    }, null, 2)}\n`);
    writeFileSync(join(sourceRunDir, 'translations.jsonl'), '');

    assert.throws(
      () => prepareRejudgeRun({
        outputDir,
        sourceRunId: 'run-source',
        newRunId: 'run-rejudge',
        benchmarkId: 'gemba-mqm-v1',
        datasetVersion: 'sentences.json',
        ...SENTENCE_TRACK_FIELDS,
        datasetFingerprintSha256: 'c'.repeat(64),
        targetLanguages: ['ja'],
        targetLanguageLabels: {
          ja: 'Japanese',
        },
        judgePromptVersion: 'gemba-mqm-v1',
        judgeModelId: 'gemini-3.1-pro-preview',
        vertexProject: null,
        vertexRegion: null,
        vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      }),
      /source run dataset fingerprint does not match the requested rejudge configuration/i,
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareRejudgeRun rejects source runs with unresolved translation failures', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'rejudge-run-'));

  try {
    const sourceRunDir = join(outputDir, 'run-source');
    mkdirSync(sourceRunDir, { recursive: true });

    writeFileSync(join(sourceRunDir, 'manifest.json'), `${JSON.stringify({
      manifestVersion: 3,
      runId: 'run-source',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      judgeModelId: 'gemini-2.5-flash',
      targetLanguages: ['ja'],
      targetLanguageLabels: {
        ja: 'Japanese',
      },
      limitApplied: 1,
      participants: [
        {
          participantId: 'qwen-3.5-plus',
          displayName: 'Qwen 3.5 Plus',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
      ],
      translationConcurrencyPerModel: 1,
      resume: false,
    }, null, 2)}\n`);
    writeFileSync(join(sourceRunDir, 'translations.jsonl'), '');
    writeFileSync(join(sourceRunDir, 'translation-failures.jsonl'), `${JSON.stringify({
      recorded_at: '2026-04-18T10:00:00.000Z',
      stable_key: 'run-source::1::ja::qwen-3.5-plus',
      participant_id: 'qwen-3.5-plus',
      participant_model_id: 'qwen3.5-plus',
      provider: 'qwen',
      source_id: '1',
      source_lang: 'en',
      target_language: 'ja',
      final_disposition: 'retry_exhausted',
      error_class: 'rate_limit',
      attempts_used: 5,
      last_error_summary: '429 rate limit',
    })}\n`);

    assert.throws(
      () => prepareRejudgeRun({
        outputDir,
        sourceRunId: 'run-source',
        newRunId: 'run-rejudge',
        benchmarkId: 'gemba-mqm-v1',
        datasetVersion: 'sentences.json',
        ...SENTENCE_TRACK_FIELDS,
        datasetFingerprintSha256: DATASET_FINGERPRINT,
        targetLanguages: ['ja'],
        targetLanguageLabels: {
          ja: 'Japanese',
        },
        judgePromptVersion: 'gemba-mqm-v1',
        judgeModelId: 'gemini-3.1-pro-preview',
        vertexProject: null,
        vertexRegion: null,
        vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      }),
      /unresolved translation failures/i,
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareRejudgeRun output can continue through the normal runner resume path', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'rejudge-run-'));

  try {
    const sourceRunDir = join(outputDir, 'run-source');
    mkdirSync(sourceRunDir, { recursive: true });

    writeFileSync(join(sourceRunDir, 'manifest.json'), `${JSON.stringify({
      manifestVersion: 3,
      runId: 'run-source',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      judgeModelId: 'gemini-2.5-flash',
      targetLanguages: ['ja'],
      targetLanguageLabels: {
        ja: 'Japanese',
      },
      limitApplied: 1,
      participants: [
        {
          participantId: 'qwen-3.5-plus',
          displayName: 'Qwen 3.5 Plus',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
      ],
      translationConcurrencyPerModel: 1,
      resume: false,
    }, null, 2)}\n`);
    writeFileSync(join(sourceRunDir, 'translations.jsonl'), `${JSON.stringify({
      stable_key: 'run-source::1::ja::qwen-3.5-plus',
      source_id: '1',
      source: 'Hello',
      source_lang: 'en',
      target_language: 'ja',
      target_language_label: 'Japanese',
      participant_id: 'qwen-3.5-plus',
      participant_model_id: 'qwen3.5-plus',
      translation: 'こんにちは',
    })}\n`);

    const prepared = prepareRejudgeRun({
      outputDir,
      sourceRunId: 'run-source',
      newRunId: 'run-rejudge',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      targetLanguages: ['ja'],
      targetLanguageLabels: {
        ja: 'Japanese',
      },
      judgePromptVersion: 'gemba-mqm-v1',
      judgeModelId: 'gemini-3.1-pro-preview',
      vertexProject: null,
      vertexRegion: null,
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
    });

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Rejudge resume integration.',
      sharedPromptFile: 'current-prompt.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: {
        ja: 'Japanese',
      },
    };
    const conditions: Condition[] = [
      {
        label: 'qwen-3.5-plus',
        provider: 'qwen',
        model: 'qwen3.5-plus',
        promptFile: 'current-prompt.md',
        prompt: 'Translate the text.',
        dataFile: 'sentences.json',
        testCases: [
          {
            id: 1,
            source: 'Hello',
            sourceLang: 'en',
            targetLangs: ['ja'],
          },
        ],
        client: {
          getModelName: () => 'qwen3.5-plus',
          getProviderName: () => 'qwen',
          getRequestTimeoutMs: () => 30_000,
          translate: async () => {
            throw new Error('translate should not be called during rejudge resume');
          },
        },
      },
    ];

    const runner = new TestRunner(benchmarkConfig, conditions, {
      preflight: async () => {},
      judge: async () => ({
        rawText: '{"has_no_error":true,"errors":[]}',
        usage: {
          provider: 'vertex',
          model: 'gemini-3.1-pro-preview',
          phase: 'judge',
          inputTokens: 10,
          outputTokens: 5,
          latencyMs: 1,
          costStatus: 'estimated',
          computedCostUsd: 0.01,
        },
      }),
    }, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'current-prompt.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: prepared.runId,
      delayMs: 0,
      resume: true,
      skipTranslationPhase: true,
      judgeModelId: prepared.judgeModelId,
      participants: prepared.participants,
    });

    await runner.run();

    const manifest = JSON.parse(readFileSync(prepared.layout.manifestPath, 'utf8')) as Record<string, unknown>;
    const normalizedJudgeRecords = readJsonlRecords<{ stable_key: string }>(join(prepared.layout.runDir, 'judge-normalized.jsonl'));

    assert.equal(manifest.promptVersion, 'source-prompt.md');
    assert.equal(manifest.rejudgeFromRunId, 'run-source');
    assert.equal(manifest.reusedTranslations, true);
    assert.equal(normalizedJudgeRecords.length, 1);
    assert.equal(normalizedJudgeRecords[0]?.stable_key, 'run-rejudge::1::ja::qwen-3.5-plus');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
