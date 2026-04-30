import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BenchmarkConfig } from '../src/benchmark-config.js';
import { prepareForkRun } from '../src/fork-run.js';
import type { Condition } from '../src/llm-client.js';
import { computeFileSha256, readJsonlRecords } from '../src/run-artifacts.js';
import { TestRunner } from '../src/runner.js';

const DATASET_FINGERPRINT = 'a'.repeat(64);
const PROMPT_FINGERPRINT = 'b'.repeat(64);
const SENTENCE_TRACK_FIELDS = {
  datasetKind: 'sentence',
  judgePromptSetId: 'gemba-mqm-v1',
} as const;

function writeSourceRunArtifacts(params: {
  outputDir: string;
  manifest?: Record<string, unknown>;
  translations?: Array<Record<string, unknown>>;
  translationFailures?: Array<Record<string, unknown>>;
  translationMetrics?: Array<Record<string, unknown>>;
  normalizedJudges?: Array<Record<string, unknown>>;
  rawJudges?: Array<Record<string, unknown>>;
  judgeMetrics?: Array<Record<string, unknown>>;
  judgeFailures?: Array<Record<string, unknown>>;
}): void {
  const sourceRunDir = join(params.outputDir, 'run-source');
  mkdirSync(sourceRunDir, { recursive: true });

  writeFileSync(join(sourceRunDir, 'manifest.json'), `${JSON.stringify(params.manifest ?? {
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
    limitApplied: 2,
    participants: [
      {
        participantId: 'qwen-3.5-plus',
        displayName: 'Qwen 3.5 Plus',
        provider: 'qwen',
        providerModelId: 'qwen3.5-plus',
      },
      {
        participantId: 'deepl-api',
        displayName: 'DeepL API',
        provider: 'deepl',
        providerModelId: 'deepl-api',
      },
    ],
    translationConcurrencyPerModel: 2,
    resume: false,
  }, null, 2)}\n`);
  writeFileSync(join(sourceRunDir, 'translations.jsonl'), `${(params.translations ?? []).map((record) => JSON.stringify(record)).join('\n')}${(params.translations ?? []).length > 0 ? '\n' : ''}`);
  writeFileSync(join(sourceRunDir, 'translation-failures.jsonl'), `${(params.translationFailures ?? []).map((record) => JSON.stringify(record)).join('\n')}${(params.translationFailures ?? []).length > 0 ? '\n' : ''}`);
  writeFileSync(join(sourceRunDir, 'translation-metrics.jsonl'), `${(params.translationMetrics ?? []).map((record) => JSON.stringify(record)).join('\n')}${(params.translationMetrics ?? []).length > 0 ? '\n' : ''}`);
  writeFileSync(join(sourceRunDir, 'judge-normalized.jsonl'), `${(params.normalizedJudges ?? []).map((record) => JSON.stringify(record)).join('\n')}${(params.normalizedJudges ?? []).length > 0 ? '\n' : ''}`);
  writeFileSync(join(sourceRunDir, 'judge-raw.jsonl'), `${(params.rawJudges ?? []).map((record) => JSON.stringify(record)).join('\n')}${(params.rawJudges ?? []).length > 0 ? '\n' : ''}`);
  writeFileSync(join(sourceRunDir, 'judge-metrics.jsonl'), `${(params.judgeMetrics ?? []).map((record) => JSON.stringify(record)).join('\n')}${(params.judgeMetrics ?? []).length > 0 ? '\n' : ''}`);
  writeFileSync(join(sourceRunDir, 'judge-failures.jsonl'), `${(params.judgeFailures ?? []).map((record) => JSON.stringify(record)).join('\n')}${(params.judgeFailures ?? []).length > 0 ? '\n' : ''}`);
}

test('prepareForkRun creates a new run and reuses only overlapping participant translations', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'fork-run-'));

  try {
    writeSourceRunArtifacts({
      outputDir,
      translations: [
        {
          stable_key: 'run-source::1::ja::qwen-3.5-plus',
          source_id: '1',
          source: 'Hello',
          source_lang: 'en',
          target_language: 'ja',
          target_language_label: 'Japanese',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          translation: 'こんにちは',
        },
        {
          stable_key: 'run-source::2::ja::qwen-3.5-plus',
          source_id: '2',
          source: 'World',
          source_lang: 'en',
          target_language: 'ja',
          target_language_label: 'Japanese',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          translation: '世界',
        },
        {
          stable_key: 'run-source::1::ja::deepl-api',
          source_id: '1',
          source: 'Hello',
          source_lang: 'en',
          target_language: 'ja',
          target_language_label: 'Japanese',
          participant_id: 'deepl-api',
          participant_model_id: 'deepl-api',
          translation: 'こんにちは-deepl',
        },
        {
          stable_key: 'run-source::3::ja::qwen-3.5-plus',
          source_id: '3',
          source: 'Extra',
          source_lang: 'en',
          target_language: 'ja',
          target_language_label: 'Japanese',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          translation: '余分',
        },
      ],
      translationMetrics: [
        {
          stable_key: 'run-source::1::ja::qwen-3.5-plus',
          provider: 'qwen',
          model: 'qwen3.5-plus',
          phase: 'translation',
          inputTokens: 10,
          outputTokens: 5,
          latencyMs: 100,
          costStatus: 'estimated',
          computedCostUsd: 0.01,
        },
        {
          stable_key: 'run-source::2::ja::qwen-3.5-plus',
          provider: 'qwen',
          model: 'qwen3.5-plus',
          phase: 'translation',
          inputTokens: 11,
          outputTokens: 6,
          latencyMs: 101,
          costStatus: 'estimated',
          computedCostUsd: 0.02,
        },
      ],
    });

    const prepared = prepareForkRun({
      outputDir,
      sourceRunId: 'run-source',
      newRunId: 'run-fork',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      targetLanguages: ['ja'],
      targetLanguageLabels: {
        ja: 'Japanese',
      },
      judgeModelId: 'gemini-3.1-pro-preview',
      vertexProject: null,
      vertexRegion: null,
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      translationConcurrencyPerModel: 3,
      limitApplied: 2,
      allowedSourceIds: ['1', '2'],
      participants: [
        {
          participantId: 'qwen-3.5-plus',
          displayName: 'Qwen 3.5 Plus',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
        {
          participantId: 'gemini-3-flash',
          displayName: 'Gemini 3 Flash',
          provider: 'gemini',
          providerModelId: 'gemini-3-flash-preview',
        },
      ],
    });

    const manifest = JSON.parse(readFileSync(prepared.layout.manifestPath, 'utf8')) as Record<string, unknown>;
    const copiedTranslations = readJsonlRecords<Array<Record<string, unknown>>[number]>(prepared.layout.translationJsonlPath);
    const copiedTranslationMetrics = readJsonlRecords<Array<Record<string, unknown>>[number]>(prepared.layout.translationMetricsJsonlPath);

    assert.equal(prepared.runId, 'run-fork');
    assert.equal(prepared.translationCount, 2);
    assert.equal(manifest.forkFromRunId, 'run-source');
    assert.equal(manifest.rejudgeFromRunId, undefined);
    assert.equal(manifest.reusedTranslations, undefined);
    assert.equal(manifest.promptVersion, 'source-prompt.md');
    assert.equal(manifest.promptFingerprintSha256, PROMPT_FINGERPRINT);
    assert.equal(manifest.translationConcurrencyPerModel, 3);
    assert.deepEqual((manifest.participants as Array<{ participantId: string }>).map((participant) => participant.participantId), [
      'qwen-3.5-plus',
      'gemini-3-flash',
    ]);
    assert.deepEqual(copiedTranslations.map((record) => record.participant_id), ['qwen-3.5-plus', 'qwen-3.5-plus']);
    assert.deepEqual(copiedTranslations.map((record) => record.stable_key), [
      'run-fork::1::ja::qwen-3.5-plus',
      'run-fork::2::ja::qwen-3.5-plus',
    ]);
    assert.deepEqual(copiedTranslationMetrics.map((record) => record.stable_key), [
      'run-fork::1::ja::qwen-3.5-plus',
      'run-fork::2::ja::qwen-3.5-plus',
    ]);
    assert.equal(copiedTranslations[0]?.source_run_id, 'run-source');
    assert.equal(copiedTranslations[0]?.source_stable_key, 'run-source::1::ja::qwen-3.5-plus');
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareForkRun reuses successful judge artifacts and skips judge failures', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'fork-run-'));

  try {
    writeSourceRunArtifacts({
      outputDir,
      translations: [
        {
          stable_key: 'run-source::1::ja::qwen-3.5-plus',
          source_id: '1',
          source: 'Hello',
          source_lang: 'en',
          target_language: 'ja',
          target_language_label: 'Japanese',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          translation: 'こんにちは',
        },
        {
          stable_key: 'run-source::2::ja::qwen-3.5-plus',
          source_id: '2',
          source: 'World',
          source_lang: 'en',
          target_language: 'ja',
          target_language_label: 'Japanese',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          translation: '世界',
        },
      ],
      translationMetrics: [
        {
          stable_key: 'run-source::1::ja::qwen-3.5-plus',
          provider: 'qwen',
          model: 'qwen3.5-plus',
          phase: 'translation',
          inputTokens: 10,
          outputTokens: 5,
          latencyMs: 100,
          costStatus: 'estimated',
          computedCostUsd: 0.01,
        },
        {
          stable_key: 'run-source::2::ja::qwen-3.5-plus',
          provider: 'qwen',
          model: 'qwen3.5-plus',
          phase: 'translation',
          inputTokens: 11,
          outputTokens: 6,
          latencyMs: 101,
          costStatus: 'estimated',
          computedCostUsd: 0.02,
        },
      ],
      normalizedJudges: [
        {
          run_id: 'run-source',
          source_id: '1',
          target_language: 'ja',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          judge_model_id: 'gemini-2.5-flash',
          status: 'ok',
          errors: [],
          summary: {
            has_no_error: true,
            critical_count: 0,
            major_count: 0,
            minor_count: 0,
            total_penalty: 0,
          },
          raw_judge_output: '{"has_no_error":true,"errors":[]}',
          stable_key: 'run-source::1::ja::qwen-3.5-plus',
        },
        {
          run_id: 'run-source',
          source_id: '2',
          target_language: 'ja',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          judge_model_id: 'gemini-2.5-flash',
          status: 'judge_failed',
          errors: [],
          summary: null,
          raw_judge_output: 'rate limited',
          stable_key: 'run-source::2::ja::qwen-3.5-plus',
        },
      ],
      rawJudges: [
        {
          stable_key: 'run-source::1::ja::qwen-3.5-plus',
          source_id: '1',
          target_language: 'ja',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          raw_judge_output: '{"has_no_error":true,"errors":[]}',
        },
      ],
      judgeMetrics: [
        {
          stable_key: 'run-source::1::ja::qwen-3.5-plus',
          provider: 'vertex',
          model: 'gemini-2.5-flash',
          phase: 'judge',
          inputTokens: 20,
          outputTokens: 10,
          latencyMs: 200,
          costStatus: 'estimated',
          computedCostUsd: 0.03,
        },
      ],
      judgeFailures: [
        {
          stable_key: 'run-source::2::ja::qwen-3.5-plus',
          source_id: '2',
          target_language: 'ja',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          error: 'rate limited',
          raw_judge_output: 'rate limited',
        },
      ],
    });

    const prepared = prepareForkRun({
      outputDir,
      sourceRunId: 'run-source',
      newRunId: 'run-fork',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      targetLanguages: ['ja'],
      targetLanguageLabels: {
        ja: 'Japanese',
      },
      judgeModelId: 'gemini-2.5-flash',
      vertexProject: null,
      vertexRegion: null,
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      translationConcurrencyPerModel: 2,
      limitApplied: 2,
      allowedSourceIds: ['1', '2'],
      participants: [
        {
          participantId: 'qwen-3.5-plus',
          displayName: 'Qwen 3.5 Plus',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
      ],
    });

    const normalizedJudges = readJsonlRecords<Array<Record<string, unknown>>[number]>(prepared.layout.normalizedJudgeJsonlPath);
    const rawJudges = readJsonlRecords<Array<Record<string, unknown>>[number]>(prepared.layout.rawJudgeJsonlPath);
    const judgeMetrics = readJsonlRecords<Array<Record<string, unknown>>[number]>(prepared.layout.judgeMetricsJsonlPath);
    const judgeFailures = readJsonlRecords<Array<Record<string, unknown>>[number]>(prepared.layout.failuresJsonlPath);

    assert.equal(normalizedJudges.length, 1);
    assert.equal(normalizedJudges[0]?.run_id, 'run-fork');
    assert.equal(normalizedJudges[0]?.status, 'ok');
    assert.equal(normalizedJudges[0]?.stable_key, 'run-fork::1::ja::qwen-3.5-plus');
    assert.equal(rawJudges.length, 1);
    assert.equal(rawJudges[0]?.stable_key, 'run-fork::1::ja::qwen-3.5-plus');
    assert.equal(judgeMetrics.length, 1);
    assert.equal(judgeMetrics[0]?.stable_key, 'run-fork::1::ja::qwen-3.5-plus');
    assert.equal(judgeFailures.length, 0);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareForkRun does not reuse judge successes when the requested judge model differs', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'fork-run-'));

  try {
    writeSourceRunArtifacts({
      outputDir,
      translations: [
        {
          stable_key: 'run-source::1::ja::qwen-3.5-plus',
          source_id: '1',
          source: 'Hello',
          source_lang: 'en',
          target_language: 'ja',
          target_language_label: 'Japanese',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          translation: 'こんにちは',
        },
      ],
      translationMetrics: [
        {
          stable_key: 'run-source::1::ja::qwen-3.5-plus',
          provider: 'qwen',
          model: 'qwen3.5-plus',
          phase: 'translation',
          inputTokens: 10,
          outputTokens: 5,
          latencyMs: 100,
          costStatus: 'estimated',
          computedCostUsd: 0.01,
        },
      ],
      normalizedJudges: [
        {
          run_id: 'run-source',
          source_id: '1',
          target_language: 'ja',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          judge_model_id: 'gemini-2.5-flash',
          status: 'ok',
          errors: [],
          summary: {
            has_no_error: true,
            critical_count: 0,
            major_count: 0,
            minor_count: 0,
            total_penalty: 0,
          },
          raw_judge_output: '{"has_no_error":true,"errors":[]}',
          stable_key: 'run-source::1::ja::qwen-3.5-plus',
        },
      ],
      rawJudges: [
        {
          stable_key: 'run-source::1::ja::qwen-3.5-plus',
          source_id: '1',
          target_language: 'ja',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          raw_judge_output: '{"has_no_error":true,"errors":[]}',
        },
      ],
      judgeMetrics: [
        {
          stable_key: 'run-source::1::ja::qwen-3.5-plus',
          provider: 'vertex',
          model: 'gemini-2.5-flash',
          phase: 'judge',
          inputTokens: 20,
          outputTokens: 10,
          latencyMs: 200,
          costStatus: 'estimated',
          computedCostUsd: 0.03,
        },
      ],
    });

    const prepared = prepareForkRun({
      outputDir,
      sourceRunId: 'run-source',
      newRunId: 'run-fork',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      targetLanguages: ['ja'],
      targetLanguageLabels: {
        ja: 'Japanese',
      },
      judgeModelId: 'gemini-3.1-pro-preview',
      vertexProject: null,
      vertexRegion: null,
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      translationConcurrencyPerModel: 2,
      limitApplied: 1,
      allowedSourceIds: ['1'],
      participants: [
        {
          participantId: 'qwen-3.5-plus',
          displayName: 'Qwen 3.5 Plus',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
      ],
    });

    assert.equal(readJsonlRecords(prepared.layout.normalizedJudgeJsonlPath).length, 0);
    assert.equal(readJsonlRecords(prepared.layout.rawJudgeJsonlPath).length, 0);
    assert.equal(readJsonlRecords(prepared.layout.judgeMetricsJsonlPath).length, 0);
    assert.equal(readJsonlRecords(prepared.layout.translationMetricsJsonlPath).length, 1);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareForkRun rejects overlapping participants whose snapshot changed', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'fork-run-'));

  try {
    writeSourceRunArtifacts({ outputDir });

    assert.throws(
      () => prepareForkRun({
        outputDir,
        sourceRunId: 'run-source',
        newRunId: 'run-fork',
        benchmarkId: 'gemba-mqm-v1',
        datasetVersion: 'sentences.json',
        ...SENTENCE_TRACK_FIELDS,
        datasetFingerprintSha256: DATASET_FINGERPRINT,
        promptVersion: 'source-prompt.md',
        promptFingerprintSha256: PROMPT_FINGERPRINT,
        judgePromptVersion: 'gemba-mqm-v1',
        targetLanguages: ['ja'],
        targetLanguageLabels: {
          ja: 'Japanese',
        },
        judgeModelId: 'gemini-3.1-pro-preview',
        vertexProject: null,
        vertexRegion: null,
        vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
        translationConcurrencyPerModel: 2,
        limitApplied: 2,
        allowedSourceIds: ['1', '2'],
        participants: [
          {
            participantId: 'qwen-3.5-plus',
            displayName: 'Qwen 3.5 Plus (Renamed)',
            provider: 'qwen',
            providerModelId: 'qwen3.5-plus',
          },
          {
            participantId: 'gemini-3-flash',
            displayName: 'Gemini 3 Flash',
            provider: 'gemini',
            providerModelId: 'gemini-3-flash-preview',
          },
        ],
      }),
      /does not match the source manifest snapshot/i,
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareForkRun computes participant prompt fingerprints before comparing override snapshots', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'fork-run-'));

  try {
    const promptFile = join(outputDir, 'simple-translation.md');
    writeFileSync(promptFile, 'Translate ${sourceName} into ${targetName}.');
    const promptFingerprintSha256 = computeFileSha256(promptFile);

    writeSourceRunArtifacts({
      outputDir,
      manifest: {
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
        targetLanguageLabels: { ja: 'Japanese' },
        limitApplied: 1,
        participants: [
          {
            participantId: 'deepseek-v4-flash-nocontext-baseline',
            displayName: 'DeepSeek V4 Flash (No context baseline)',
            provider: 'deepseek',
            providerModelId: 'deepseek-v4-flash',
            promptFile,
            promptFingerprintSha256,
          },
        ],
        translationConcurrencyPerModel: 1,
        resume: false,
      },
    });

    const prepared = prepareForkRun({
      outputDir,
      sourceRunId: 'run-source',
      newRunId: 'run-fork',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      datasetKind: 'sentence',
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      judgePromptSetId: 'gemba-mqm-v1',
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
      judgeModelId: 'gemini-2.5-flash',
      vertexProject: null,
      vertexRegion: null,
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      translationConcurrencyPerModel: 1,
      limitApplied: 1,
      allowedSourceIds: ['1'],
      participants: [
        {
          participantId: 'deepseek-v4-flash-nocontext-baseline',
          displayName: 'DeepSeek V4 Flash (No context baseline)',
          provider: 'deepseek',
          providerModelId: 'deepseek-v4-flash',
          promptFile,
        },
      ],
    });

    assert.equal(prepared.participants[0]?.promptFingerprintSha256, promptFingerprintSha256);
    const forkManifest = JSON.parse(readFileSync(join(outputDir, 'run-fork', 'manifest.json'), 'utf8')) as {
      participants: Array<{ promptFile?: string; promptFingerprintSha256?: string }>;
    };
    assert.equal(forkManifest.participants[0]?.promptFile, promptFile);
    assert.equal(forkManifest.participants[0]?.promptFingerprintSha256, promptFingerprintSha256);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareForkRun reports missing override prompt files clearly without creating fork artifacts', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'fork-run-'));

  try {
    const promptFile = join(outputDir, 'missing-simple-translation.md');
    writeSourceRunArtifacts({
      outputDir,
      manifest: {
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
        targetLanguageLabels: { ja: 'Japanese' },
        limitApplied: 1,
        participants: [
          {
            participantId: 'deepseek-v4-flash-nocontext-baseline',
            displayName: 'DeepSeek V4 Flash (No context baseline)',
            provider: 'deepseek',
            providerModelId: 'deepseek-v4-flash',
            promptFile,
            promptFingerprintSha256: 'c'.repeat(64),
          },
        ],
        translationConcurrencyPerModel: 1,
        resume: false,
      },
    });

    assert.throws(
      () => prepareForkRun({
        outputDir,
        sourceRunId: 'run-source',
        newRunId: 'run-fork',
        benchmarkId: 'gemba-mqm-v1',
        datasetVersion: 'sentences.json',
        datasetKind: 'sentence',
        datasetFingerprintSha256: DATASET_FINGERPRINT,
        promptVersion: 'source-prompt.md',
        promptFingerprintSha256: PROMPT_FINGERPRINT,
        judgePromptVersion: 'gemba-mqm-v1',
        judgePromptSetId: 'gemba-mqm-v1',
        targetLanguages: ['ja'],
        targetLanguageLabels: { ja: 'Japanese' },
        judgeModelId: 'gemini-2.5-flash',
        vertexProject: null,
        vertexRegion: null,
        vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
        translationConcurrencyPerModel: 1,
        limitApplied: 1,
        allowedSourceIds: ['1'],
        participants: [
          {
            participantId: 'deepseek-v4-flash-nocontext-baseline',
            displayName: 'DeepSeek V4 Flash (No context baseline)',
            provider: 'deepseek',
            providerModelId: 'deepseek-v4-flash',
            promptFile,
          },
        ],
      }),
      /participant prompt file not found/i,
    );
    assert.equal(existsSync(join(outputDir, 'run-fork')), false);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareForkRun rejects empty override prompt files before creating fork artifacts', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'fork-run-'));

  try {
    const promptFile = join(outputDir, 'empty-simple-translation.md');
    writeFileSync(promptFile, '   \n');
    writeSourceRunArtifacts({
      outputDir,
      manifest: {
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
        targetLanguageLabels: { ja: 'Japanese' },
        limitApplied: 1,
        participants: [
          {
            participantId: 'deepseek-v4-flash-nocontext-baseline',
            displayName: 'DeepSeek V4 Flash (No context baseline)',
            provider: 'deepseek',
            providerModelId: 'deepseek-v4-flash',
            promptFile,
            promptFingerprintSha256: computeFileSha256(promptFile),
          },
        ],
        translationConcurrencyPerModel: 1,
        resume: false,
      },
    });

    assert.throws(
      () => prepareForkRun({
        outputDir,
        sourceRunId: 'run-source',
        newRunId: 'run-fork',
        benchmarkId: 'gemba-mqm-v1',
        datasetVersion: 'sentences.json',
        datasetKind: 'sentence',
        datasetFingerprintSha256: DATASET_FINGERPRINT,
        promptVersion: 'source-prompt.md',
        promptFingerprintSha256: PROMPT_FINGERPRINT,
        judgePromptVersion: 'gemba-mqm-v1',
        judgePromptSetId: 'gemba-mqm-v1',
        targetLanguages: ['ja'],
        targetLanguageLabels: { ja: 'Japanese' },
        judgeModelId: 'gemini-2.5-flash',
        vertexProject: null,
        vertexRegion: null,
        vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
        translationConcurrencyPerModel: 1,
        limitApplied: 1,
        allowedSourceIds: ['1'],
        participants: [
          {
            participantId: 'deepseek-v4-flash-nocontext-baseline',
            displayName: 'DeepSeek V4 Flash (No context baseline)',
            provider: 'deepseek',
            providerModelId: 'deepseek-v4-flash',
            promptFile,
          },
        ],
      }),
      /participant prompt file is empty/i,
    );
    assert.equal(existsSync(join(outputDir, 'run-fork')), false);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('prepareForkRun rejects source runs whose prompt version does not match the requested fork configuration', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'fork-run-'));

  try {
    writeSourceRunArtifacts({ outputDir });

    assert.throws(
      () => prepareForkRun({
        outputDir,
        sourceRunId: 'run-source',
        newRunId: 'run-fork',
        benchmarkId: 'gemba-mqm-v1',
        datasetVersion: 'sentences.json',
        ...SENTENCE_TRACK_FIELDS,
        datasetFingerprintSha256: DATASET_FINGERPRINT,
        promptVersion: 'different-prompt.md',
        promptFingerprintSha256: PROMPT_FINGERPRINT,
        judgePromptVersion: 'gemba-mqm-v1',
        targetLanguages: ['ja'],
        targetLanguageLabels: {
          ja: 'Japanese',
        },
        judgeModelId: 'gemini-3.1-pro-preview',
        vertexProject: null,
        vertexRegion: null,
        vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
        translationConcurrencyPerModel: 2,
        limitApplied: 2,
        allowedSourceIds: ['1', '2'],
        participants: [
          {
            participantId: 'qwen-3.5-plus',
            displayName: 'Qwen 3.5 Plus',
            provider: 'qwen',
            providerModelId: 'qwen3.5-plus',
          },
          {
            participantId: 'gemini-3-flash',
            displayName: 'Gemini 3 Flash',
            provider: 'gemini',
            providerModelId: 'gemini-3-flash-preview',
          },
        ],
      }),
      /source run promptVersion does not match the requested fork configuration/i,
    );
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('forked runs resume from copied translations and do not reuse unresolved failures', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'fork-run-'));

  try {
    writeSourceRunArtifacts({
      outputDir,
      manifest: {
        manifestVersion: 3,
        runId: 'run-source',
        benchmarkId: 'gemba-mqm-v1',
        datasetVersion: 'sentences.json',
        ...SENTENCE_TRACK_FIELDS,
        datasetFingerprintSha256: DATASET_FINGERPRINT,
        promptVersion: 'source-prompt.md',
        promptFingerprintSha256: PROMPT_FINGERPRINT,
        judgePromptVersion: 'gemba-mqm-v1',
        judgeModelId: null,
        targetLanguages: ['ja'],
        targetLanguageLabels: {
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
      },
      translations: [
        {
          stable_key: 'run-source::1::ja::qwen-3.5-plus',
          source_id: '1',
          source: 'Hello',
          source_lang: 'en',
          target_language: 'ja',
          target_language_label: 'Japanese',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          translation: 'こんにちは',
        },
      ],
      translationFailures: [
        {
          recorded_at: '2026-04-19T20:00:00.000Z',
          stable_key: 'run-source::2::ja::qwen-3.5-plus',
          participant_id: 'qwen-3.5-plus',
          participant_model_id: 'qwen3.5-plus',
          provider: 'qwen',
          source_id: '2',
          source_lang: 'en',
          target_language: 'ja',
          final_disposition: 'retry_exhausted',
          error_class: 'rate_limit',
          attempts_used: 5,
          last_error_summary: '429 rate limit',
        },
      ],
    });

    const prepared = prepareForkRun({
      outputDir,
      sourceRunId: 'run-source',
      newRunId: 'run-fork',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      targetLanguages: ['ja'],
      targetLanguageLabels: {
        ja: 'Japanese',
      },
      judgeModelId: null,
      vertexProject: null,
      vertexRegion: null,
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      translationConcurrencyPerModel: 1,
      limitApplied: 2,
      allowedSourceIds: ['1', '2'],
      participants: [
        {
          participantId: 'qwen-3.5-plus',
          displayName: 'Qwen 3.5 Plus',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
        {
          participantId: 'gemini-3-flash',
          displayName: 'Gemini 3 Flash',
          provider: 'gemini',
          providerModelId: 'gemini-3-flash-preview',
        },
      ],
    });

    let qwenCalls = 0;
    let geminiCalls = 0;
    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Fork run runner integration.',
      sharedPromptFile: 'source-prompt.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };
    const conditions: Condition[] = [
      {
        label: 'qwen-3.5-plus',
        provider: 'qwen',
        model: 'qwen3.5-plus',
        promptFile: 'source-prompt.md',
        prompt: 'Translate the text.',
        dataFile: 'sentences.json',
        testCases: [
          { id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] },
          { id: 2, source: 'World', sourceLang: 'en', targetLangs: ['ja'] },
        ],
        client: {
          getModelName: () => 'qwen3.5-plus',
          getProviderName: () => 'qwen',
          getRequestTimeoutMs: () => 30_000,
          translate: async (text) => {
            qwenCalls += 1;
            return {
              output: `qwen:${text}`,
              latencyMs: 1,
              usage: {
                provider: 'qwen',
                model: 'qwen3.5-plus',
                phase: 'translation',
                inputTokens: 1,
                outputTokens: 1,
                latencyMs: 1,
                costStatus: 'estimated',
                computedCostUsd: 0.01,
              },
            };
          },
        },
      },
      {
        label: 'gemini-3-flash',
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        promptFile: 'source-prompt.md',
        prompt: 'Translate the text.',
        dataFile: 'sentences.json',
        testCases: [
          { id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] },
          { id: 2, source: 'World', sourceLang: 'en', targetLangs: ['ja'] },
        ],
        client: {
          getModelName: () => 'gemini-3-flash-preview',
          getProviderName: () => 'gemini',
          getRequestTimeoutMs: () => 30_000,
          translate: async (text) => {
            geminiCalls += 1;
            return {
              output: `gemini:${text}`,
              latencyMs: 1,
              usage: {
                provider: 'gemini',
                model: 'gemini-3-flash-preview',
                phase: 'translation',
                inputTokens: 1,
                outputTokens: 1,
                latencyMs: 1,
                costStatus: 'estimated',
                computedCostUsd: 0.01,
              },
            };
          },
        },
      },
    ];

    const runner = new TestRunner(benchmarkConfig, conditions, null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'source-prompt.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: prepared.runId,
      forkFromRunId: 'run-source',
      delayMs: 0,
      limit: 2,
      limitApplied: 2,
      resume: true,
      participants: prepared.participants,
      translationConcurrencyPerModel: 1,
    });

    await runner.run();

    const translations = readJsonlRecords<Array<{ stable_key: string; participant_id: string; source_id: string }>[number]>(prepared.layout.translationJsonlPath);

    assert.equal(qwenCalls, 1);
    assert.equal(geminiCalls, 2);
    assert.equal(translations.length, 4);
    assert.deepEqual(translations.map((record) => record.stable_key).sort(), [
      'run-fork::1::ja::qwen-3.5-plus',
      'run-fork::1::ja::gemini-3-flash',
      'run-fork::2::ja::qwen-3.5-plus',
      'run-fork::2::ja::gemini-3-flash',
    ].sort());
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});
