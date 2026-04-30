import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BenchmarkConfig } from '../src/benchmark-config.js';
import type { ContextRuntimeSample } from '../src/context-benchmark-types.js';
import type { Condition } from '../src/llm-client.js';
import {
  computeFileSha256,
  clearRunManifestFingerprintDefaults,
  createRunLayout,
  readJsonlRecords,
  setRunManifestFingerprintDefaults,
  writeJsonlRecord,
} from '../src/run-artifacts.js';
import { writeRunEvent } from '../src/run-observability.js';
import {
  buildPendingJudgeWorkItems,
  TestRunner,
  type TranslationArtifactRecord,
} from '../src/runner.js';

const DATASET_FINGERPRINT = 'a'.repeat(64);
const PROMPT_FINGERPRINT = 'b'.repeat(64);
const SENTENCE_TRACK_FIELDS = {
  datasetKind: 'sentence',
  judgePromptSetId: 'gemba-mqm-v1',
} as const;
const CONTEXT_TRACK_FIELDS = {
  datasetKind: 'context',
  judgePromptSetId: 'gemba-mqm-context-v1',
} as const;

const CONTEXT_SAMPLE: ContextRuntimeSample = {
  sampleId: 'ctx2-dyadic-use-referent_resolution-001',
  contextTurnCount: 2,
  speakerMode: 'dyadic',
  contextExpectation: 'use',
  primaryPhenomenon: 'referent_resolution',
  secondaryPhenomena: ['self_other_deixis'],
  contextTurns: [
    { speakerRole: 'other', relativeTimeLabel: '18s ago', sourceText: '어 안녕' },
    { speakerRole: 'self', relativeTimeLabel: '6s ago', sourceText: '지금 막 들어왔어' },
  ],
  currentSource: { speakerRole: 'self', relativeTimeLabel: null, sourceText: '거기 몇시야?' },
};

function setDefaultFingerprints(): void {
  setRunManifestFingerprintDefaults({
    datasetFingerprintSha256: DATASET_FINGERPRINT,
    promptFingerprintSha256: PROMPT_FINGERPRINT,
  });
}

async function captureContextTranslationInput(
  participantId: string,
  provider: Condition['provider'],
  model: string,
): Promise<string> {
  const outputDir = mkdtempSync(join(tmpdir(), `runner-context-${provider}-`));

  try {
    setDefaultFingerprints();

    let capturedText = '';

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: `Context translation runner test for ${provider}.`,
      sharedPromptFile: 'gemini.md',
      dataFile: 'context-runtime.json',
      ...CONTEXT_TRACK_FIELDS,
      targetLanguages: ['en'],
      targetLanguageLabels: { en: 'English' },
    };

    const conditions: Condition[] = [
      {
        label: participantId,
        provider,
        model,
        promptFile: 'gemini.md',
        prompt: 'Translate the text.',
        dataFile: 'context-runtime.json',
        testCases: [CONTEXT_SAMPLE],
        client: {
          getModelName: () => model,
          getProviderName: () => provider,
          getRequestTimeoutMs: () => 30_000,
          translate: async (text) => {
            capturedText = text;

            return {
              output: 'What time is it there?',
              latencyMs: 1,
              usage: {
                provider,
                model,
                phase: 'translation',
                inputTokens: 10,
                outputTokens: 5,
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
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-context-v1',
      outputDir,
      runId: `run-context-${participantId}`,
      delayMs: 0,
      resume: false,
    });

    await runner.run();

    return capturedText;
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
}

test('buildPendingJudgeWorkItems skips already-normalized stable keys', () => {
  const items = buildPendingJudgeWorkItems(
    [
      {
        stable_key: 'run-001::1::ja::qwen-3.5-plus',
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
        stable_key: 'run-001::1::ja::qwen-3.6-plus',
        source_id: '1',
        source: 'Hello',
        source_lang: 'en',
        target_language: 'ja',
        target_language_label: 'Japanese',
        participant_id: 'qwen-3.6-plus',
        participant_model_id: 'qwen3.6-plus',
        translation: 'やあ',
      },
    ],
    new Set(['run-001::1::ja::qwen-3.5-plus']),
  );

  assert.equal(items.length, 1);
  assert.equal(items[0]?.participant_id, 'qwen-3.6-plus');
});

test('buildPendingJudgeWorkItems rebuilds persisted context judge items and fails clearly when the sample is missing', () => {
  const translations: TranslationArtifactRecord[] = [
    {
      stable_key: `run-ctx::${CONTEXT_SAMPLE.sampleId}::en::A`,
      source_id: CONTEXT_SAMPLE.sampleId,
      source: CONTEXT_SAMPLE.currentSource.sourceText,
      source_lang: 'Korean',
      target_language: 'en',
      target_language_label: 'English',
      participant_id: 'A',
      participant_model_id: 'qwen3.5-plus',
      translation: 'What time is it there?',
      dataset_kind: 'context',
      context_turn_count: CONTEXT_SAMPLE.contextTurnCount,
      speaker_mode: CONTEXT_SAMPLE.speakerMode,
      context_expectation: CONTEXT_SAMPLE.contextExpectation,
      primary_phenomenon: CONTEXT_SAMPLE.primaryPhenomenon,
      secondary_phenomena: CONTEXT_SAMPLE.secondaryPhenomena,
    },
  ];

  const pending = buildPendingJudgeWorkItems(
    translations,
    new Set<string>(),
    new Map([[CONTEXT_SAMPLE.sampleId, CONTEXT_SAMPLE]]),
  );

  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.contextSample?.sampleId, CONTEXT_SAMPLE.sampleId);
  assert.throws(
    () => buildPendingJudgeWorkItems(translations, new Set<string>(), new Map()),
    /missing context sample.*source_id.*ctx2-dyadic-use-referent_resolution-001/i,
  );
});

test('TestRunner skips judge preflight when no pending judge work remains on resume', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-resume-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Test benchmark config.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: {
        ja: 'Japanese',
      },
    };

    const conditions: Condition[] = [
      {
        label: 'A',
        provider: 'qwen',
        model: 'qwen3.5-plus',
        promptFile: 'gemini.md',
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
            throw new Error('translate should not be called when resuming existing artifacts');
          },
        },
      },
    ];

    const layout = createRunLayout(outputDir, {
      manifestVersion: 3,
      runId: 'run-001',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      judgeModelId: 'gemini-2.5-flash',
      promptVersion: 'gemini.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
      limitApplied: 1,
      participants: [
        {
          participantId: 'A',
          displayName: 'A',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
      ],
      translationConcurrencyPerModel: 1,
      vertexProject: 'demo-project',
      vertexRegion: 'us-central1',
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      resume: false,
    });

    writeJsonlRecord(layout.translationJsonlPath, {
      stable_key: 'run-001::1::ja::A',
      source_id: '1',
      source: 'Hello',
      source_lang: 'en',
      target_language: 'ja',
      target_language_label: 'Japanese',
      participant_id: 'A',
      participant_model_id: 'qwen3.5-plus',
      translation: 'こんにちは',
    });

    writeJsonlRecord(layout.normalizedJudgeJsonlPath, {
      run_id: 'run-001',
      source_id: '1',
      target_language: 'ja',
      participant_id: 'A',
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
      stable_key: 'run-001::1::ja::A',
    });

    let preflightCalls = 0;
    let judgeCalls = 0;

    const runner = new TestRunner(benchmarkConfig, conditions, {
      preflight: async () => {
        preflightCalls += 1;
      },
      judge: async () => {
        judgeCalls += 1;
        return {
          rawText: '{"has_no_error":true,"errors":[]}',
          usage: {
            provider: 'vertex',
            model: 'gemini-2.5-flash',
            phase: 'judge',
            inputTokens: 10,
            outputTokens: 5,
            latencyMs: 1,
            costStatus: 'estimated',
            computedCostUsd: 0.01,
          },
        };
      },
    }, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-001',
      delayMs: 0,
      resume: true,
      judgeModelId: 'gemini-2.5-flash',
    });

    await runner.run();

    assert.equal(preflightCalls, 0);
    assert.equal(judgeCalls, 0);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner sends rendered context model input and persists context translation artifacts', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-context-translation-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Context translation runner test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'context-runtime.json',
      ...CONTEXT_TRACK_FIELDS,
      targetLanguages: ['zh-Hans'],
      targetLanguageLabels: { 'zh-Hans': 'Chinese Simplified' },
    };

    let capturedText = '';
    let capturedSourceLang = '';
    let capturedTargetLang = '';

    const conditions: Condition[] = [
      {
        label: 'A',
        provider: 'qwen',
        model: 'qwen3.5-plus',
        promptFile: 'gemini.md',
        prompt: 'Translate the text.',
        dataFile: 'context-runtime.json',
        testCases: [CONTEXT_SAMPLE],
        client: {
          getModelName: () => 'qwen3.5-plus',
          getProviderName: () => 'qwen',
          getRequestTimeoutMs: () => 30_000,
          translate: async (text, _prompt, sourceLang, targetLang) => {
            capturedText = text;
            capturedSourceLang = sourceLang;
            capturedTargetLang = targetLang;

            return {
              output: 'What time is it there?',
              latencyMs: 1,
              usage: {
                provider: 'qwen',
                model: 'qwen3.5-plus',
                phase: 'translation',
                inputTokens: 10,
                outputTokens: 5,
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
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-context-v1',
      outputDir,
      runId: 'run-context-translation',
      delayMs: 0,
      resume: false,
    });

    await runner.run();

    const translationRecords = readJsonlRecords<{
      stable_key: string;
      source_id: string;
      source: string;
      source_lang: string;
      target_language: string;
      target_language_label: string;
      dataset_kind?: string;
      context_turn_count?: number;
      speaker_mode?: string;
      context_expectation?: string;
      primary_phenomenon?: string;
      secondary_phenomena?: string[];
    }>(join(outputDir, 'run-context-translation', 'translations.jsonl'));

    assert.match(capturedText, /^<context>\n/);
    assert.match(capturedText, /\n<\/context>\n\n<input>\n/);
    assert.match(capturedText, /^<context>\n\[other, 18s ago\] 어 안녕\n\[self, 6s ago\] 지금 막 들어왔어\n<\/context>\n\n<input>\n거기 몇시야\?\n<\/input>$/);
    assert.equal(capturedSourceLang, 'Korean');
    assert.equal(capturedTargetLang, 'Chinese Simplified');
    assert.equal(translationRecords.length, 1);
    assert.equal(
      translationRecords[0]?.stable_key,
      `run-context-translation::${CONTEXT_SAMPLE.sampleId}::zh-Hans::A`,
    );
    assert.equal(translationRecords[0]?.source_id, CONTEXT_SAMPLE.sampleId);
    assert.equal(translationRecords[0]?.source, CONTEXT_SAMPLE.currentSource.sourceText);
    assert.equal(translationRecords[0]?.source_lang, 'Korean');
    assert.equal(translationRecords[0]?.target_language, 'zh-Hans');
    assert.equal(translationRecords[0]?.target_language_label, 'Chinese Simplified');
    assert.equal(translationRecords[0]?.dataset_kind, 'context');
    assert.equal(translationRecords[0]?.context_turn_count, 2);
    assert.equal(translationRecords[0]?.speaker_mode, 'dyadic');
    assert.equal(translationRecords[0]?.context_expectation, 'use');
    assert.equal(translationRecords[0]?.primary_phenomenon, 'referent_resolution');
    assert.deepEqual(translationRecords[0]?.secondary_phenomena, ['self_other_deixis']);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner sends rendered context input to deepl-api on the context benchmark', async () => {
  const capturedText = await captureContextTranslationInput('deepl-api', 'deepl', 'deepl-api');

  assert.match(capturedText, /^<context>\n/);
  assert.match(capturedText, /\n<\/context>\n\n<input>\n/);
});

test('TestRunner sends only the current utterance to deepl-api-nocontext on the context benchmark', async () => {
  const capturedText = await captureContextTranslationInput('deepl-api-nocontext', 'deepl', 'deepl-api');

  assert.equal(capturedText, CONTEXT_SAMPLE.currentSource.sourceText);
});

test('TestRunner sends only the current utterance to google-web on the context benchmark', async () => {
  const capturedText = await captureContextTranslationInput('google-translate-web', 'google-web', 'google-translate-web');

  assert.equal(capturedText, CONTEXT_SAMPLE.currentSource.sourceText);
});

test('TestRunner sends only the current utterance to google-translate-basic on the context benchmark', async () => {
  const capturedText = await captureContextTranslationInput('google-cloud-translate-basic', 'google-translate-basic', 'google-translate-basic');

  assert.equal(capturedText, CONTEXT_SAMPLE.currentSource.sourceText);
});

test('TestRunner treats -nocontext participants as context-blind on the context benchmark', async () => {
  const capturedText = await captureContextTranslationInput('gemini-3-flash-nocontext', 'gemini', 'gemini-3-flash-preview');

  assert.equal(capturedText, CONTEXT_SAMPLE.currentSource.sourceText);
});

test('TestRunner treats -nocontext-baseline participants as context-blind on the context benchmark', async () => {
  const baselineParticipants = [
    ['gemma-4-26b-openrouter-nocontext-baseline', 'openrouter', 'google/gemma-4-26b-a4b-it'],
    ['deepseek-v4-flash-nocontext-baseline', 'deepseek', 'deepseek-v4-flash'],
  ] as const;

  for (const [participantId, provider, model] of baselineParticipants) {
    const capturedText = await captureContextTranslationInput(participantId, provider, model);
    assert.equal(capturedText, CONTEXT_SAMPLE.currentSource.sourceText);
  }
});

test('TestRunner rebuilds pending context judge work on resume and renders the numbered context judge prompt', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-context-judge-resume-'));

  try {
    const datasetPath = join(outputDir, 'context-runtime.json');
    writeFileSync(datasetPath, `${JSON.stringify([CONTEXT_SAMPLE], null, 2)}\n`, 'utf8');
    const datasetFingerprintSha256 = computeFileSha256(datasetPath);
    setRunManifestFingerprintDefaults({
      datasetFingerprintSha256,
      promptFingerprintSha256: PROMPT_FINGERPRINT,
    });

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Context judge resume test.',
      sharedPromptFile: 'gemini.md',
      dataFile: datasetPath,
      ...CONTEXT_TRACK_FIELDS,
      targetLanguages: ['en'],
      targetLanguageLabels: { en: 'English' },
    };

    const conditions: Condition[] = [
      {
        label: 'A',
        provider: 'qwen',
        model: 'qwen3.5-plus',
        promptFile: 'gemini.md',
        prompt: 'Translate the text.',
        dataFile: datasetPath,
        testCases: [CONTEXT_SAMPLE],
        client: {
          getModelName: () => 'qwen3.5-plus',
          getProviderName: () => 'qwen',
          getRequestTimeoutMs: () => 30_000,
          translate: async () => {
            throw new Error('translate should not be called when judging from persisted context artifacts');
          },
        },
      },
    ];

    const layout = createRunLayout(outputDir, {
      manifestVersion: 3,
      runId: 'run-context-judge-resume',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'context-runtime.json',
      ...CONTEXT_TRACK_FIELDS,
      datasetFingerprintSha256,
      judgeModelId: 'gemini-2.5-flash',
      promptVersion: 'gemini.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-context-v1',
      targetLanguages: ['en'],
      targetLanguageLabels: { en: 'English' },
      limitApplied: 1,
      participants: [
        {
          participantId: 'A',
          displayName: 'A',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
      ],
      translationConcurrencyPerModel: 1,
      vertexProject: 'demo-project',
      vertexRegion: 'us-central1',
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      resume: false,
    });

    writeJsonlRecord(layout.translationJsonlPath, {
      stable_key: `run-context-judge-resume::${CONTEXT_SAMPLE.sampleId}::en::A`,
      source_id: CONTEXT_SAMPLE.sampleId,
      source: CONTEXT_SAMPLE.currentSource.sourceText,
      source_lang: 'Korean',
      target_language: 'en',
      target_language_label: 'English',
      participant_id: 'A',
      participant_model_id: 'qwen3.5-plus',
      translation: 'What time is it there?',
      dataset_kind: 'context',
      context_turn_count: CONTEXT_SAMPLE.contextTurnCount,
      speaker_mode: CONTEXT_SAMPLE.speakerMode,
      context_expectation: CONTEXT_SAMPLE.contextExpectation,
      primary_phenomenon: CONTEXT_SAMPLE.primaryPhenomenon,
      secondary_phenomena: CONTEXT_SAMPLE.secondaryPhenomena,
    });

    let capturedJudgePrompt = '';
    const runner = new TestRunner(benchmarkConfig, conditions, {
      preflight: async () => {},
      judge: async (request) => {
        capturedJudgePrompt = request.contents.at(-1)?.parts[0]?.text ?? '';

        return {
          rawText: '{"has_no_error":true,"errors":[],"contextBehavior":"used_correctly"}',
          usage: {
            provider: 'vertex',
            model: 'gemini-2.5-flash',
            phase: 'judge',
            inputTokens: 10,
            outputTokens: 5,
            latencyMs: 1,
            costStatus: 'estimated',
            computedCostUsd: 0.01,
          },
        };
      },
    }, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-context-v1',
      outputDir,
      runId: 'run-context-judge-resume',
      delayMs: 0,
      resume: true,
      skipTranslationPhase: true,
      judgeModelId: 'gemini-2.5-flash',
    });

    await runner.run();

    assert.match(capturedJudgePrompt, /Context \(oldest to newest\):/);
    assert.match(capturedJudgePrompt, /1\. \[other, 18s ago\] 어 안녕/);
    assert.match(capturedJudgePrompt, /2\. \[self, 6s ago\] 지금 막 들어왔어/);
    assert.match(capturedJudgePrompt, /Current source:\n```거기 몇시야\?```/);
    assert.match(capturedJudgePrompt, /Candidate translation:\n```What time is it there\?```/);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner rejects context resume result rebuilding when the active dataset fingerprint differs from the manifest', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-context-fingerprint-'));

  try {
    clearRunManifestFingerprintDefaults();

    const datasetPath = join(outputDir, 'context-runtime.json');
    writeFileSync(datasetPath, `${JSON.stringify([CONTEXT_SAMPLE], null, 2)}\n`, 'utf8');

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Context fingerprint guard test.',
      sharedPromptFile: 'gemini.md',
      dataFile: datasetPath,
      ...CONTEXT_TRACK_FIELDS,
      targetLanguages: ['en'],
      targetLanguageLabels: { en: 'English' },
    };

    const conditions: Condition[] = [
      {
        label: 'A',
        provider: 'qwen',
        model: 'qwen3.5-plus',
        promptFile: 'gemini.md',
        prompt: 'Translate the text.',
        dataFile: datasetPath,
        testCases: [CONTEXT_SAMPLE],
        client: {
          getModelName: () => 'qwen3.5-plus',
          getProviderName: () => 'qwen',
          getRequestTimeoutMs: () => 30_000,
          translate: async () => {
            throw new Error('translate should not run when resuming persisted context artifacts');
          },
        },
      },
    ];

    const layout = createRunLayout(outputDir, {
      manifestVersion: 3,
      runId: 'run-context-fingerprint',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'context-runtime.json',
      ...CONTEXT_TRACK_FIELDS,
      datasetFingerprintSha256: 'c'.repeat(64),
      judgeModelId: 'gemini-2.5-flash',
      promptVersion: 'gemini.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-context-v1',
      targetLanguages: ['en'],
      targetLanguageLabels: { en: 'English' },
      limitApplied: 1,
      participants: [
        {
          participantId: 'A',
          displayName: 'A',
          provider: 'qwen',
          providerModelId: 'qwen3.5-plus',
        },
      ],
      translationConcurrencyPerModel: 1,
      vertexProject: 'demo-project',
      vertexRegion: 'us-central1',
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      resume: false,
    });

    writeJsonlRecord(layout.translationJsonlPath, {
      stable_key: `run-context-fingerprint::${CONTEXT_SAMPLE.sampleId}::en::A`,
      source_id: CONTEXT_SAMPLE.sampleId,
      source: CONTEXT_SAMPLE.currentSource.sourceText,
      source_lang: 'Korean',
      target_language: 'en',
      target_language_label: 'English',
      participant_id: 'A',
      participant_model_id: 'qwen3.5-plus',
      translation: 'What time is it there?',
      dataset_kind: 'context',
      context_turn_count: CONTEXT_SAMPLE.contextTurnCount,
      speaker_mode: CONTEXT_SAMPLE.speakerMode,
      context_expectation: CONTEXT_SAMPLE.contextExpectation,
      primary_phenomenon: CONTEXT_SAMPLE.primaryPhenomenon,
      secondary_phenomena: CONTEXT_SAMPLE.secondaryPhenomena,
    });

    writeJsonlRecord(layout.normalizedJudgeJsonlPath, {
      run_id: 'run-context-fingerprint',
      source_id: CONTEXT_SAMPLE.sampleId,
      target_language: 'en',
      participant_id: 'A',
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
      context_turn_count: CONTEXT_SAMPLE.contextTurnCount,
      speaker_mode: CONTEXT_SAMPLE.speakerMode,
      context_expectation: CONTEXT_SAMPLE.contextExpectation,
      primary_phenomenon: CONTEXT_SAMPLE.primaryPhenomenon,
      raw_judge_output: '{"has_no_error":true,"errors":[],"contextBehavior":"used_correctly"}',
      stable_key: `run-context-fingerprint::${CONTEXT_SAMPLE.sampleId}::en::A`,
    });

    const runner = new TestRunner(benchmarkConfig, conditions, null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-context-v1',
      outputDir,
      runId: 'run-context-fingerprint',
      delayMs: 0,
      resume: true,
    });

    await assert.rejects(
      () => runner.run(),
      /manifest dataset fingerprint .* does not match active dataset/i,
    );
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner preserves string context source ids when rebuilding no-judge summaries', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-context-no-judge-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Context no-judge summary test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'context-runtime.json',
      ...CONTEXT_TRACK_FIELDS,
      targetLanguages: ['en'],
      targetLanguageLabels: { en: 'English' },
    };

    const runner = new TestRunner(benchmarkConfig, [
      {
        label: 'A',
        provider: 'qwen',
        model: 'qwen3.5-plus',
        promptFile: 'gemini.md',
        prompt: 'Translate the text.',
        dataFile: 'context-runtime.json',
        testCases: [CONTEXT_SAMPLE],
        client: {
          getModelName: () => 'qwen3.5-plus',
          getProviderName: () => 'qwen',
          getRequestTimeoutMs: () => 30_000,
          translate: async () => ({
            output: 'What time is it there?',
            latencyMs: 1,
            usage: {
              provider: 'qwen',
              model: 'qwen3.5-plus',
              phase: 'translation',
              inputTokens: 10,
              outputTokens: 5,
              latencyMs: 1,
              costStatus: 'estimated',
              computedCostUsd: 0.01,
            },
          }),
        },
      },
    ], null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-context-v1',
      outputDir,
      runId: 'run-context-no-judge',
      delayMs: 0,
      resume: false,
    });

    const summary = await runner.run();

    assert.equal(summary.results.length, 1);
    assert.equal(summary.results[0]?.sourceId, CONTEXT_SAMPLE.sampleId);
    assert.equal(typeof summary.results[0]?.sourceId, 'string');
    assert.equal(summary.results[0]?.id, CONTEXT_SAMPLE.sampleId);
    assert.equal(typeof summary.results[0]?.id, 'string');
    assert.equal(summary.results[0]?.source, CONTEXT_SAMPLE.currentSource.sourceText);
    assert.equal(summary.results[0]?.sourceLang, 'Korean');
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner reconstructs historical retries and failures in resumed run-state', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-resume-state-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Resume run-state test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };

    const participant = {
      participantId: 'A',
      displayName: 'A',
      provider: 'qwen' as const,
      providerModelId: 'qwen3.5-plus',
    };

    const conditions: Condition[] = [
      {
        label: 'A',
        provider: 'qwen',
        model: 'qwen3.5-plus',
        promptFile: 'gemini.md',
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
          translate: async () => {
            throw new Error('translate should not run when resuming artifacts');
          },
        },
      },
    ];

    const layout = createRunLayout(outputDir, {
      manifestVersion: 3,
      runId: 'run-resume-state',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      judgeModelId: 'gemini-2.5-flash',
      promptVersion: 'gemini.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
      limitApplied: 2,
      participants: [participant],
      translationConcurrencyPerModel: 1,
      vertexProject: 'demo-project',
      vertexRegion: 'us-central1',
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      resume: false,
    });

    writeJsonlRecord(layout.translationJsonlPath, {
      stable_key: 'run-resume-state::1::ja::A',
      source_id: '1',
      source: 'Hello',
      source_lang: 'en',
      target_language: 'ja',
      target_language_label: 'Japanese',
      participant_id: 'A',
      participant_model_id: 'qwen3.5-plus',
      translation: 'こんにちは',
    });
    writeJsonlRecord(layout.translationFailuresJsonlPath, {
      recorded_at: '2026-04-18T10:01:00.000Z',
      stable_key: 'run-resume-state::2::ja::A',
      participant_id: 'A',
      participant_model_id: 'qwen3.5-plus',
      provider: 'qwen',
      source_id: '2',
      source_lang: 'en',
      target_language: 'ja',
      final_disposition: 'terminal_deterministic',
      error_class: 'rate_limit',
      attempts_used: 5,
      last_error_summary: '429 rate limit',
    });
    writeRunEvent(layout.translationEventsJsonlPath, {
      scope: 'item',
      timestamp: '2026-04-18T10:00:00.000Z',
      phase: 'translation',
      event_type: 'retry',
      throttle_bucket_key: 'qwen::qwen3.5-plus',
      stable_key: 'run-resume-state::1::ja::A',
      source_id: '1',
      source_preview: 'Hello',
      source_lang: 'en',
      target_language: 'ja',
      participant_id: 'A',
      participant_model_id: 'qwen3.5-plus',
      provider: 'qwen',
      attempt: 1,
      max_attempts: 5,
      error_class: 'rate_limit',
      error_summary: '429 rate limit',
      raw_error_message: 'Authorization: Bearer stale-fixture',
      next_delay_ms: 1000,
    });
    writeRunEvent(layout.translationEventsJsonlPath, {
      scope: 'item',
      timestamp: '2026-04-18T10:01:00.000Z',
      phase: 'translation',
      event_type: 'failure',
      throttle_bucket_key: 'qwen::qwen3.5-plus',
      stable_key: 'run-resume-state::2::ja::A',
      source_id: '2',
      source_preview: 'World',
      source_lang: 'en',
      target_language: 'ja',
      participant_id: 'A',
      participant_model_id: 'qwen3.5-plus',
      provider: 'qwen',
      attempt: 5,
      max_attempts: 5,
      error_class: 'rate_limit',
      error_summary: '429 rate limit',
      raw_error_message: 'token stale-fixture',
    });

    type CapturedRunState = {
      currentPhase: string;
      overall: { retryCount: number; cumulativeRetryCount: number };
      participants: Array<{ participantId: string; retryCount: number }>;
      recentFailures: Array<{ phase: string; stableKey: string | null }>;
      recentRetries: Array<{ phase: string; stableKey: string | null }>;
    };
    let capturedInFlightStateJson: string | null = null;

    const runner = new TestRunner(benchmarkConfig, conditions, {
      preflight: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
      },
      judge: async () => {
        capturedInFlightStateJson = readFileSync(layout.runStatePath, 'utf8');
        return {
          rawText: '{"has_no_error":true,"errors":[]}',
          usage: {
            provider: 'vertex',
            model: 'gemini-2.5-flash',
            phase: 'judge',
            inputTokens: 10,
            outputTokens: 5,
            latencyMs: 1,
            costStatus: 'estimated',
            computedCostUsd: 0.01,
          },
        };
      },
    }, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-resume-state',
      delayMs: 0,
      resume: true,
      judgeModelId: 'gemini-2.5-flash',
      participants: [participant],
    });

    await runner.run();

    const finalRunState = JSON.parse(readFileSync(layout.runStatePath, 'utf8')) as {
      currentPhase: string;
      overall: { retryCount: number; cumulativeRetryCount: number };
      recentFailures: Array<{ phase: string; stableKey: string | null }>;
      recentRetries: Array<{ phase: string; stableKey: string | null }>;
    };
    assert.ok(capturedInFlightStateJson);
    const inFlightState = JSON.parse(capturedInFlightStateJson) as CapturedRunState;

    assert.equal(inFlightState.currentPhase, 'judge');
    assert.equal(inFlightState.overall.retryCount, 0);
    assert.equal(inFlightState.overall.cumulativeRetryCount, 1);
    assert.equal(inFlightState.participants[0]?.retryCount, 1);
    assert.equal(inFlightState.recentRetries[0]?.phase, 'translation');
    assert.equal(inFlightState.recentRetries[0]?.stableKey, 'run-resume-state::1::ja::A');
    assert.equal(inFlightState.recentFailures[0]?.phase, 'translation');
    assert.equal(inFlightState.recentFailures[0]?.stableKey, 'run-resume-state::2::ja::A');
    assert.equal(finalRunState.currentPhase, 'complete');
    assert.equal(finalRunState.overall.cumulativeRetryCount, 1);
    assert.equal(finalRunState.recentRetries[0]?.stableKey, 'run-resume-state::1::ja::A');
    assert.equal(finalRunState.recentFailures[0]?.stableKey, 'run-resume-state::2::ja::A');
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner treats retry-exhausted translation failures as completed on resume', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-resume-retry-exhausted-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Resume retry-exhausted translation failure test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };

    const participant = {
      participantId: 'deepl',
      displayName: 'DeepL',
      provider: 'deepl' as const,
      providerModelId: 'deepl-api',
    };

    const layout = createRunLayout(outputDir, {
      manifestVersion: 3,
      runId: 'run-resume-retry-exhausted',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      judgeModelId: 'gemini-2.5-flash',
      promptVersion: 'gemini.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
      limitApplied: 2,
      participants: [participant],
      translationConcurrencyPerModel: 1,
      vertexProject: 'demo-project',
      vertexRegion: 'us-central1',
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      resume: false,
    });

    writeJsonlRecord(layout.translationJsonlPath, {
      stable_key: 'run-resume-retry-exhausted::1::ja::deepl',
      source_id: '1',
      source: 'Hello',
      source_lang: 'en',
      target_language: 'ja',
      target_language_label: 'Japanese',
      participant_id: 'deepl',
      participant_model_id: 'deepl-api',
      translation: 'こんにちは',
    });
    writeJsonlRecord(layout.translationFailuresJsonlPath, {
      recorded_at: '2026-04-18T10:00:00.000Z',
      stable_key: 'run-resume-retry-exhausted::2::ja::deepl',
      participant_id: 'deepl',
      participant_model_id: 'deepl-api',
      provider: 'deepl',
      source_id: '2',
      source_lang: 'en',
      target_language: 'ja',
      final_disposition: 'retry_exhausted',
      error_class: 'rate_limit',
      attempts_used: 5,
      last_error_summary: '429 rate limit',
    });

    let translateCalls = 0;
    let preflightCalls = 0;
    let judgeCalls = 0;
    const conditions: Condition[] = [
      {
        label: 'deepl',
        provider: 'deepl',
        model: 'deepl-api',
        promptFile: 'gemini.md',
        prompt: 'Translate the text.',
        dataFile: 'sentences.json',
        testCases: [
          { id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] },
          { id: 2, source: 'World', sourceLang: 'en', targetLangs: ['ja'] },
        ],
        client: {
          getModelName: () => 'deepl-api',
          getProviderName: () => 'deepl',
          getRequestTimeoutMs: () => 30_000,
          translate: async () => {
            translateCalls += 1;
            throw {
              errorClass: 'bad_request',
              retryable: false,
              rawMessage: 'translate should not run when resuming retry-exhausted failures',
              cooldownScope: 'none',
              requestTimeoutMs: 30_000,
            };
          },
        },
      },
    ];

    const runner = new TestRunner(benchmarkConfig, conditions, {
      preflight: async () => {
        preflightCalls += 1;
      },
      judge: async () => {
        judgeCalls += 1;
        return {
          rawText: '{"has_no_error":true,"errors":[]}',
          usage: {
            provider: 'vertex',
            model: 'gemini-2.5-flash',
            phase: 'judge',
            inputTokens: 10,
            outputTokens: 5,
            latencyMs: 1,
            costStatus: 'estimated',
            computedCostUsd: 0.01,
          },
        };
      },
    }, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-resume-retry-exhausted',
      delayMs: 0,
      resume: true,
      judgeModelId: 'gemini-2.5-flash',
      participants: [participant],
      translationConcurrencyPerModel: 1,
    });

    await runner.run();

    const failures = readJsonlRecords<{
      stable_key: string;
      final_disposition: string;
    }>(layout.translationFailuresJsonlPath);
    const normalizedRecords = readJsonlRecords<{
      stable_key: string;
      source_id: string;
    }>(layout.normalizedJudgeJsonlPath);
    const finalRunState = JSON.parse(readFileSync(layout.runStatePath, 'utf8')) as {
      currentPhase: string;
      overall: { completed: number; succeeded: number; failed: number };
      participants: Array<{ participantId: string; completed: number; succeeded: number; failed: number }>;
    };
    const runStatus = JSON.parse(readFileSync(join(outputDir, 'run-resume-retry-exhausted', 'reports', 'run-status.json'), 'utf8')) as {
      benchmarkValid: boolean;
      totalExpected: number;
      totalNormalized: number;
      translationFailureHistoricalCount?: number;
      translationFailureUnresolvedCount?: number;
    };

    assert.equal(translateCalls, 0);
    assert.equal(preflightCalls, 1);
    assert.equal(judgeCalls, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stable_key, 'run-resume-retry-exhausted::2::ja::deepl');
    assert.equal(failures[0]?.final_disposition, 'retry_exhausted');
    assert.equal(normalizedRecords.length, 1);
    assert.equal(normalizedRecords[0]?.stable_key, 'run-resume-retry-exhausted::1::ja::deepl');
    assert.equal(normalizedRecords[0]?.source_id, '1');
    assert.equal(finalRunState.currentPhase, 'complete');
    assert.equal(finalRunState.overall.completed, 3);
    assert.equal(finalRunState.overall.succeeded, 2);
    assert.equal(finalRunState.overall.failed, 1);
    assert.equal(finalRunState.participants[0]?.participantId, 'deepl');
    assert.equal(finalRunState.participants[0]?.completed, 3);
    assert.equal(finalRunState.participants[0]?.succeeded, 2);
    assert.equal(finalRunState.participants[0]?.failed, 1);
    assert.equal(runStatus.totalExpected, 2);
    assert.equal(runStatus.totalNormalized, 1);
    assert.equal(runStatus.translationFailureHistoricalCount, 1);
    assert.equal(runStatus.translationFailureUnresolvedCount, 1);
    assert.equal(runStatus.benchmarkValid, false);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner seeds resumed translation phase retryCount from persisted translation retry events', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-resume-translation-retries-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Resume translation retry-count test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };

    const participant = {
      participantId: 'A',
      displayName: 'A',
      provider: 'qwen' as const,
      providerModelId: 'qwen3.5-plus',
    };

    const layout = createRunLayout(outputDir, {
      manifestVersion: 3,
      runId: 'run-resume-translation-retries',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      judgeModelId: null,
      promptVersion: 'gemini.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
      limitApplied: 2,
      participants: [participant],
      translationConcurrencyPerModel: 1,
      vertexProject: 'demo-project',
      vertexRegion: 'us-central1',
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      resume: false,
    });

    writeJsonlRecord(layout.translationJsonlPath, {
      stable_key: 'run-resume-translation-retries::1::ja::A',
      source_id: '1',
      source: 'Hello',
      source_lang: 'en',
      target_language: 'ja',
      target_language_label: 'Japanese',
      participant_id: 'A',
      participant_model_id: 'qwen3.5-plus',
      translation: 'こんにちは',
    });
    writeRunEvent(layout.translationEventsJsonlPath, {
      scope: 'item',
      timestamp: '2026-04-18T10:00:00.000Z',
      phase: 'translation',
      event_type: 'retry',
      throttle_bucket_key: 'qwen::qwen3.5-plus',
      stable_key: 'run-resume-translation-retries::1::ja::A',
      source_id: '1',
      source_preview: 'Hello',
      source_lang: 'en',
      target_language: 'ja',
      participant_id: 'A',
      participant_model_id: 'qwen3.5-plus',
      provider: 'qwen',
      attempt: 1,
      max_attempts: 5,
      error_class: 'rate_limit',
      error_summary: '429 rate limit',
      raw_error_message: 'Bearer stale-fixture',
      next_delay_ms: 1000,
    });

    let capturedStateJson: string | null = null;
    const conditions: Condition[] = [
      {
        label: 'A',
        provider: 'qwen',
        model: 'qwen3.5-plus',
        promptFile: 'gemini.md',
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
          translate: async () => {
            capturedStateJson = readFileSync(layout.runStatePath, 'utf8');
            return {
              output: '世界',
              latencyMs: 1,
              usage: {
                provider: 'qwen',
                model: 'qwen3.5-plus',
                phase: 'translation',
                inputTokens: 10,
                outputTokens: 5,
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
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-resume-translation-retries',
      delayMs: 0,
      resume: true,
      participants: [participant],
      translationConcurrencyPerModel: 1,
    });

    await runner.run();

    assert.ok(capturedStateJson);
    const runState = JSON.parse(capturedStateJson) as {
      currentPhase: string;
      overall: { retryCount: number; cumulativeRetryCount: number };
      participants: Array<{ participantId: string; retryCount: number }>;
    };

    assert.equal(runState.currentPhase, 'translation');
    assert.equal(runState.overall.retryCount, 1);
    assert.equal(runState.overall.cumulativeRetryCount, 1);
    assert.equal(runState.participants[0]?.participantId, 'A');
    assert.equal(runState.participants[0]?.retryCount, 1);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner seeds resumed judge phase success and failure counts from persisted normalized records by status', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-resume-judge-status-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Resume judge status-count test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };

    const participant = {
      participantId: 'A',
      displayName: 'A',
      provider: 'qwen' as const,
      providerModelId: 'qwen3.5-plus',
    };

    const layout = createRunLayout(outputDir, {
      manifestVersion: 3,
      runId: 'run-resume-judge-status',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      judgeModelId: 'gemini-2.5-flash',
      promptVersion: 'gemini.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
      limitApplied: 3,
      participants: [participant],
      translationConcurrencyPerModel: 1,
      vertexProject: 'demo-project',
      vertexRegion: 'us-central1',
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      resume: false,
    });

    for (const [sourceId, source, translation] of [
      ['1', 'One', '一'],
      ['2', 'Two', '二'],
      ['3', 'Three', '三'],
    ] as const) {
      writeJsonlRecord(layout.translationJsonlPath, {
        stable_key: `run-resume-judge-status::${sourceId}::ja::A`,
        source_id: sourceId,
        source,
        source_lang: 'en',
        target_language: 'ja',
        target_language_label: 'Japanese',
        participant_id: 'A',
        participant_model_id: 'qwen3.5-plus',
        translation,
      });
    }

    writeJsonlRecord(layout.normalizedJudgeJsonlPath, {
      run_id: 'run-resume-judge-status',
      source_id: '1',
      target_language: 'ja',
      participant_id: 'A',
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
      stable_key: 'run-resume-judge-status::1::ja::A',
    });
    writeJsonlRecord(layout.normalizedJudgeJsonlPath, {
      run_id: 'run-resume-judge-status',
      source_id: '2',
      target_language: 'ja',
      participant_id: 'A',
      participant_model_id: 'qwen3.5-plus',
      judge_model_id: 'gemini-2.5-flash',
      status: 'judge_failed',
      errors: [],
      summary: null,
      raw_judge_output: 'bad judge output',
      stable_key: 'run-resume-judge-status::2::ja::A',
    });

    let capturedStateJson: string | null = null;
    const conditions: Condition[] = [
      {
        label: 'A',
        provider: 'qwen',
        model: 'qwen3.5-plus',
        promptFile: 'gemini.md',
        prompt: 'Translate the text.',
        dataFile: 'sentences.json',
        testCases: [
          { id: 1, source: 'One', sourceLang: 'en', targetLangs: ['ja'] },
          { id: 2, source: 'Two', sourceLang: 'en', targetLangs: ['ja'] },
          { id: 3, source: 'Three', sourceLang: 'en', targetLangs: ['ja'] },
        ],
        client: {
          getModelName: () => 'qwen3.5-plus',
          getProviderName: () => 'qwen',
          getRequestTimeoutMs: () => 30_000,
          translate: async () => {
            throw new Error('translate should not run when all translations are already present');
          },
        },
      },
    ];

    const runner = new TestRunner(benchmarkConfig, conditions, {
      preflight: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        capturedStateJson = readFileSync(layout.runStatePath, 'utf8');
      },
      judge: async () => ({
        rawText: '{"has_no_error":true,"errors":[]}',
        usage: {
          provider: 'vertex',
          model: 'gemini-2.5-flash',
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
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-resume-judge-status',
      delayMs: 0,
      resume: true,
      judgeModelId: 'gemini-2.5-flash',
      participants: [participant],
    });

    await runner.run();

    assert.ok(capturedStateJson);
    const runState = JSON.parse(capturedStateJson) as {
      currentPhase: string;
      overall: { completed: number; succeeded: number; failed: number };
      participants: Array<{ participantId: string; completed: number; succeeded: number; failed: number }>;
    };

    assert.equal(runState.currentPhase, 'judge');
    assert.equal(runState.overall.completed, 2);
    assert.equal(runState.overall.succeeded, 1);
    assert.equal(runState.overall.failed, 1);
    assert.equal(runState.participants[0]?.participantId, 'A');
    assert.equal(runState.participants[0]?.completed, 2);
    assert.equal(runState.participants[0]?.succeeded, 1);
    assert.equal(runState.participants[0]?.failed, 1);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner treats translationConcurrency as per-model concurrency and writes cost reports', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-concurrency-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Concurrent runner test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };

    const participants = [
      { participantId: 'qwen-3.5-plus', displayName: 'Qwen 3.5 Plus', provider: 'qwen' as const, providerModelId: 'qwen3.5-plus' },
      { participantId: 'gemini-3-flash', displayName: 'Gemini 3 Flash', provider: 'gemini' as const, providerModelId: 'gemini-3-flash-preview' },
      { participantId: 'gemma-4-26b-openrouter', displayName: 'Gemma 4 26B via OpenRouter', provider: 'openrouter' as const, providerModelId: 'google/gemma-4-26b-a4b-it' },
    ];

    let active = 0;
    let maxActive = 0;
    const conditions: Condition[] = participants.map((participant) => ({
      label: participant.participantId,
      provider: participant.provider,
      model: participant.providerModelId,
      promptFile: 'gemini.md',
      prompt: 'Translate the text.',
      dataFile: 'sentences.json',
      testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
      client: {
        getModelName: () => participant.providerModelId,
        getProviderName: () => participant.provider,
        getRequestTimeoutMs: () => 30_000,
        translate: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return {
            output: `translated-${participant.participantId}`,
            latencyMs: 5,
            usage: {
              provider: participant.provider,
              model: participant.providerModelId,
              phase: 'translation',
              inputTokens: 10,
              outputTokens: 5,
              latencyMs: 5,
              costStatus: 'estimated' as const,
              computedCostUsd: 0.01,
            },
          };
        },
      },
    }));

    const runner = new TestRunner(benchmarkConfig, conditions, null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-concurrency',
      delayMs: 0,
      resume: false,
      translationConcurrency: 2,
    });

    await runner.run();

    const costSummary = JSON.parse(
      readFileSync(join(outputDir, 'run-concurrency', 'reports', 'cost-summary.json'), 'utf8'),
    ) as { overall: { totalCostUsd: number } };

    assert.equal(maxActive, 3);
    assert.equal(costSummary.overall.totalCostUsd, 0.03);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner enforces shared throttle bucket caps while allowing different buckets to run in parallel', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-throttle-buckets-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Throttle bucket concurrency test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };

    const participants = [
      { participantId: 'gemini-a', displayName: 'Gemini A', provider: 'gemini' as const, providerModelId: 'gemini-3-flash-preview' },
      { participantId: 'gemini-b', displayName: 'Gemini B', provider: 'gemini' as const, providerModelId: 'gemini-3-flash-preview' },
      { participantId: 'qwen-c', displayName: 'Qwen C', provider: 'qwen' as const, providerModelId: 'qwen3.5-plus' },
    ];

    let activeOverall = 0;
    let maxActiveOverall = 0;
    const activeByBucket = new Map<string, number>();
    const maxActiveByBucket = new Map<string, number>();

    const conditions: Condition[] = participants.map((participant) => ({
      label: participant.participantId,
      provider: participant.provider,
      model: participant.providerModelId,
      promptFile: 'gemini.md',
      prompt: 'Translate the text.',
      dataFile: 'sentences.json',
      testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
      client: {
        getModelName: () => participant.providerModelId,
        getProviderName: () => participant.provider,
        getRequestTimeoutMs: () => 30_000,
        translate: async () => {
          const bucketKey = `${participant.provider}::${participant.providerModelId}`;
          activeOverall += 1;
          maxActiveOverall = Math.max(maxActiveOverall, activeOverall);

          const bucketActive = (activeByBucket.get(bucketKey) ?? 0) + 1;
          activeByBucket.set(bucketKey, bucketActive);
          maxActiveByBucket.set(bucketKey, Math.max(maxActiveByBucket.get(bucketKey) ?? 0, bucketActive));

          await new Promise((resolve) => setTimeout(resolve, 10));

          activeOverall -= 1;
          activeByBucket.set(bucketKey, bucketActive - 1);

          return {
            output: `translated-${participant.participantId}`,
            latencyMs: 10,
            usage: {
              provider: participant.provider,
              model: participant.providerModelId,
              phase: 'translation' as const,
              inputTokens: 10,
              outputTokens: 5,
              latencyMs: 10,
              costStatus: 'estimated' as const,
              computedCostUsd: 0.01,
            },
          };
        },
      },
    }));

    const runner = new TestRunner(benchmarkConfig, conditions, null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-throttle-buckets',
      delayMs: 0,
      resume: false,
      translationConcurrencyPerModel: 1,
    });

    await runner.run();

    assert.equal(maxActiveOverall, 2);
    assert.equal(maxActiveByBucket.get('gemini::gemini-3-flash-preview'), 1);
    assert.equal(maxActiveByBucket.get('qwen::qwen3.5-plus'), 1);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner round-robins participant queues within a shared throttle bucket on resume', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-round-robin-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Round-robin resume test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };

    const participants = [
      { participantId: 'gemini-a', displayName: 'Gemini A', provider: 'gemini' as const, providerModelId: 'gemini-3-flash-preview' },
      { participantId: 'gemini-b', displayName: 'Gemini B', provider: 'gemini' as const, providerModelId: 'gemini-3-flash-preview' },
    ];
    const sharedTestCases = [
      { id: 1, source: 'one', sourceLang: 'en', targetLangs: ['ja'] },
      { id: 2, source: 'two', sourceLang: 'en', targetLangs: ['ja'] },
      { id: 3, source: 'three', sourceLang: 'en', targetLangs: ['ja'] },
    ];
    const callOrder: string[] = [];

    const conditions: Condition[] = participants.map((participant) => ({
      label: participant.participantId,
      provider: participant.provider,
      model: participant.providerModelId,
      promptFile: 'gemini.md',
      prompt: 'Translate the text.',
      dataFile: 'sentences.json',
      testCases: sharedTestCases,
      client: {
        getModelName: () => participant.providerModelId,
        getProviderName: () => participant.provider,
        getRequestTimeoutMs: () => 30_000,
        translate: async (text) => {
          callOrder.push(`${participant.participantId}:${text}`);
          return {
            output: `${participant.participantId}-${text}`,
            latencyMs: 1,
            usage: {
              provider: participant.provider,
              model: participant.providerModelId,
              phase: 'translation' as const,
              inputTokens: 10,
              outputTokens: 5,
              latencyMs: 1,
              costStatus: 'estimated' as const,
              computedCostUsd: 0.01,
            },
          };
        },
      },
    }));

    const layout = createRunLayout(outputDir, {
      manifestVersion: 3,
      runId: 'run-round-robin',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      judgeModelId: null,
      promptVersion: 'gemini.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
      limitApplied: 3,
      participants,
      translationConcurrencyPerModel: 1,
      vertexProject: null,
      vertexRegion: null,
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      resume: false,
    });

    writeJsonlRecord(layout.translationJsonlPath, {
      stable_key: 'run-round-robin::1::ja::gemini-b',
      source_id: '1',
      source: 'one',
      source_lang: 'en',
      target_language: 'ja',
      target_language_label: 'Japanese',
      participant_id: 'gemini-b',
      participant_model_id: 'gemini-3-flash-preview',
      translation: 'gemini-b-one',
    });
    writeJsonlRecord(layout.translationJsonlPath, {
      stable_key: 'run-round-robin::2::ja::gemini-b',
      source_id: '2',
      source: 'two',
      source_lang: 'en',
      target_language: 'ja',
      target_language_label: 'Japanese',
      participant_id: 'gemini-b',
      participant_model_id: 'gemini-3-flash-preview',
      translation: 'gemini-b-two',
    });

    const runner = new TestRunner(benchmarkConfig, conditions, null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-round-robin',
      delayMs: 0,
      resume: true,
      participants,
      translationConcurrencyPerModel: 1,
    });

    await runner.run();

    assert.deepEqual(
      callOrder.slice(0, 2).map((entry) => entry.split(':')[0]),
      ['gemini-a', 'gemini-b'],
    );
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner persists retry-exhausted translation failures, skips judge, and marks the run invalid', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-translation-failure-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Translation failure persistence test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };

    let translateAttempts = 0;
    let preflightCalls = 0;
    let judgeCalls = 0;
    let fakeNow = 0;
    const runner = new TestRunner(benchmarkConfig, [
      {
        label: 'gemini-3-flash',
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        promptFile: 'gemini.md',
        prompt: 'Translate the text.',
        dataFile: 'sentences.json',
        testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
        client: {
          getModelName: () => 'gemini-3-flash-preview',
          getProviderName: () => 'gemini',
          getRequestTimeoutMs: () => 30_000,
          translate: async () => {
            translateAttempts += 1;
            throw {
              errorClass: 'rate_limit',
              retryable: true,
              rawMessage: `429 rate limit Authorization: Bearer translation-secret-${'x'.repeat(5000)}\nrequest body: {"systemPrompt":"do-not-store-this"}`,
              retryAfterMs: 0,
              cooldownScope: 'throttle_bucket',
              requestTimeoutMs: 30_000,
            };
          },
        },
      },
    ], {
      preflight: async () => {
        preflightCalls += 1;
      },
      judge: async () => {
        judgeCalls += 1;
        return {
          rawText: '{"has_no_error":true,"errors":[]}',
          usage: {
            provider: 'vertex',
            model: 'gemini-2.5-flash',
            phase: 'judge',
            inputTokens: 10,
            outputTokens: 5,
            latencyMs: 1,
            costStatus: 'estimated',
            computedCostUsd: 0.01,
          },
        };
      },
    }, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-translation-failure',
      delayMs: 0,
      resume: false,
      judgeModelId: 'gemini-2.5-flash',
      translationConcurrencyPerModel: 1,
      translationRetryNow: () => fakeNow,
      translationRetrySleep: async (ms) => {
        fakeNow += ms;
      },
      translationRetryRandom: () => 0,
    });

    await runner.run();

    const failures = readJsonlRecords<{
      stable_key: string;
      final_disposition: string;
      attempts_used: number;
      last_error_summary: string;
    }>(join(outputDir, 'run-translation-failure', 'translation-failures.jsonl'));
    const translationEvents = readJsonlRecords<{
      event_type: string;
      raw_error_message: string | null;
    }>(join(outputDir, 'run-translation-failure', 'translation-events.jsonl'));
    const runStatus = JSON.parse(
      readFileSync(join(outputDir, 'run-translation-failure', 'reports', 'run-status.json'), 'utf8'),
    ) as Record<string, unknown>;

    assert.equal(translateAttempts, 5);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.stable_key, 'run-translation-failure::1::ja::gemini-3-flash');
    assert.equal(failures[0]?.final_disposition, 'retry_exhausted');
    assert.equal(failures[0]?.attempts_used, 5);
    assert.match(failures[0]?.last_error_summary ?? '', /Bearer \*\*\*/);
    assert.doesNotMatch(failures[0]?.last_error_summary ?? '', /translation-secret/);
    assert.match(failures[0]?.last_error_summary ?? '', /request body: \[redacted\]/i);
    assert.doesNotMatch(failures[0]?.last_error_summary ?? '', /do-not-store-this/);
    assert.equal(Array.from(failures[0]?.last_error_summary ?? '').length <= 4000, true);
    assert.equal(translationEvents.some((event) => event.event_type === 'failure'), true);
    assert.equal(
      translationEvents.some((event) => (event.raw_error_message ?? '').includes('translation-secret')),
      false,
    );
    assert.equal(preflightCalls, 0);
    assert.equal(judgeCalls, 0);
    assert.equal(runStatus.benchmarkValid, false);
    assert.equal(runStatus.translationFailureHistoricalCount, 1);
    assert.equal(runStatus.translationFailureUnresolvedCount, 1);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner run-status uses manifest truth and separates historical versus unresolved translation failures', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-run-status-counts-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Run-status manifest truth test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };

    const participants = [
      { participantId: 'alias-a', displayName: 'Alias A', provider: 'gemini' as const, providerModelId: 'shared-model' },
      { participantId: 'alias-b', displayName: 'Alias B', provider: 'gemini' as const, providerModelId: 'shared-model' },
    ];

    const conditions: Condition[] = participants.map((participant) => ({
      label: participant.participantId,
      provider: participant.provider,
      model: participant.providerModelId,
      promptFile: 'gemini.md',
      prompt: 'Translate the text.',
      dataFile: 'sentences.json',
      testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
      client: {
        getModelName: () => participant.providerModelId,
        getProviderName: () => participant.provider,
        getRequestTimeoutMs: () => 30_000,
        translate: async () => {
          throw new Error('translate should not be called when reporting from existing artifacts');
        },
      },
    }));

    const layout = createRunLayout(outputDir, {
      manifestVersion: 3,
      runId: 'run-status-counts',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      judgeModelId: 'gemini-3.1-pro-preview',
      promptVersion: 'gemini.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
      limitApplied: 1,
      participants,
      translationConcurrencyPerModel: 1,
      vertexProject: null,
      vertexRegion: null,
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      resume: false,
    });

    writeJsonlRecord(layout.translationJsonlPath, {
      stable_key: 'run-status-counts::1::ja::alias-a',
      source_id: '1',
      source: 'Hello',
      source_lang: 'en',
      target_language: 'ja',
      target_language_label: 'Japanese',
      participant_id: 'alias-a',
      participant_model_id: 'shared-model',
      translation: 'こんにちは',
    });
    writeJsonlRecord(layout.translationFailuresJsonlPath, {
      recorded_at: '2026-04-18T00:00:00.000Z',
      stable_key: 'run-status-counts::1::ja::alias-a',
      participant_id: 'alias-a',
      participant_model_id: 'shared-model',
      provider: 'gemini',
      source_id: '1',
      source_lang: 'en',
      target_language: 'ja',
      final_disposition: 'retry_exhausted',
      error_class: 'rate_limit',
      attempts_used: 5,
      last_error_summary: 'historical failure that was later recovered',
    });
    writeJsonlRecord(layout.translationFailuresJsonlPath, {
      recorded_at: '2026-04-18T00:01:00.000Z',
      stable_key: 'run-status-counts::1::ja::alias-b',
      participant_id: 'alias-b',
      participant_model_id: 'shared-model',
      provider: 'gemini',
      source_id: '1',
      source_lang: 'en',
      target_language: 'ja',
      final_disposition: 'retry_exhausted',
      error_class: 'rate_limit',
      attempts_used: 5,
      last_error_summary: 'unresolved failure',
    });
    writeJsonlRecord(layout.normalizedJudgeJsonlPath, {
      run_id: 'run-status-counts',
      source_id: '1',
      target_language: 'ja',
      participant_id: 'alias-a',
      participant_model_id: 'shared-model',
      judge_model_id: 'gemini-3.1-pro-preview',
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
      stable_key: 'run-status-counts::1::ja::alias-a',
    });

    const runner = new TestRunner(benchmarkConfig, conditions, null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-status-counts',
      delayMs: 0,
      resume: true,
      skipTranslationPhase: true,
      judgeModelId: 'gemini-3.1-pro-preview',
      participants,
    });

    await runner.run();

    const runStatus = JSON.parse(
      readFileSync(join(outputDir, 'run-status-counts', 'reports', 'run-status.json'), 'utf8'),
    ) as {
      benchmarkValid: boolean;
      totalExpected: number;
      totalNormalized: number;
      translationFailureHistoricalCount?: number;
      translationFailureUnresolvedCount?: number;
    };

    assert.equal(runStatus.totalExpected, 2);
    assert.equal(runStatus.totalNormalized, 1);
    assert.equal(runStatus.translationFailureHistoricalCount, 2);
    assert.equal(runStatus.translationFailureUnresolvedCount, 1);
    assert.equal(runStatus.benchmarkValid, false);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner uses the manifest participant snapshot for report order, display names, and failure-rate keys', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-manifest-reporting-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Manifest-backed reporting test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };

    const manifestParticipants = [
      { participantId: 'alias-b', displayName: 'Alias B', provider: 'gemini' as const, providerModelId: 'shared-model' },
      { participantId: 'alias-a', displayName: 'Alias A', provider: 'gemini' as const, providerModelId: 'shared-model' },
    ];
    const conditions: Condition[] = [manifestParticipants[1], manifestParticipants[0]].map((participant) => ({
      label: participant.participantId,
      provider: participant.provider,
      model: participant.providerModelId,
      promptFile: 'gemini.md',
      prompt: 'Translate the text.',
      dataFile: 'sentences.json',
      testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
      client: {
        getModelName: () => participant.providerModelId,
        getProviderName: () => participant.provider,
        getRequestTimeoutMs: () => 30_000,
        translate: async () => {
          throw new Error('translate should not be called when reporting from existing artifacts');
        },
      },
    }));

    const layout = createRunLayout(outputDir, {
      manifestVersion: 3,
      runId: 'run-manifest-reporting',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      judgeModelId: 'gemini-3.1-pro-preview',
      promptVersion: 'gemini.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
      limitApplied: 1,
      participants: manifestParticipants,
      translationConcurrencyPerModel: 1,
      vertexProject: null,
      vertexRegion: null,
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      resume: false,
    });

    for (const participant of manifestParticipants) {
      writeJsonlRecord(layout.translationJsonlPath, {
        stable_key: `run-manifest-reporting::1::ja::${participant.participantId}`,
        source_id: '1',
        source: 'Hello',
        source_lang: 'en',
        target_language: 'ja',
        target_language_label: 'Japanese',
        participant_id: participant.participantId,
        participant_model_id: participant.providerModelId,
        translation: `translated-${participant.participantId}`,
      });
    }

    writeJsonlRecord(layout.normalizedJudgeJsonlPath, {
      run_id: 'run-manifest-reporting',
      source_id: '1',
      target_language: 'ja',
      participant_id: 'alias-a',
      participant_model_id: 'shared-model',
      judge_model_id: 'gemini-3.1-pro-preview',
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
      stable_key: 'run-manifest-reporting::1::ja::alias-a',
    });
    writeJsonlRecord(layout.normalizedJudgeJsonlPath, {
      run_id: 'run-manifest-reporting',
      source_id: '1',
      target_language: 'ja',
      participant_id: 'alias-b',
      participant_model_id: 'shared-model',
      judge_model_id: 'gemini-3.1-pro-preview',
      status: 'judge_failed',
      errors: [],
      summary: null,
      raw_judge_output: 'bad-json',
      stable_key: 'run-manifest-reporting::1::ja::alias-b',
    });

    const runner = new TestRunner(benchmarkConfig, conditions, null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-manifest-reporting',
      delayMs: 0,
      resume: true,
      skipTranslationPhase: true,
      judgeModelId: 'gemini-3.1-pro-preview',
      participants: manifestParticipants,
    });

    await runner.run();

    const leaderboard = JSON.parse(
      readFileSync(join(outputDir, 'run-manifest-reporting', 'reports', 'leaderboard.by-language.json'), 'utf8'),
    ) as {
      ja: {
        leaderboard: Array<{ participant_id: string; participant_display_name?: string }>;
      };
    };
    const runStatus = JSON.parse(
      readFileSync(join(outputDir, 'run-manifest-reporting', 'reports', 'run-status.json'), 'utf8'),
    ) as {
      judgeFailureRatesByParticipantLanguage?: Record<string, { ok: number; failed: number }>;
    };

    assert.deepEqual(
      leaderboard.ja.leaderboard.map((row) => row.participant_id),
      ['alias-b', 'alias-a'],
    );
    assert.deepEqual(
      leaderboard.ja.leaderboard.map((row) => row.participant_display_name),
      ['Alias B', 'Alias A'],
    );
    assert.deepEqual(
      Object.keys(runStatus.judgeFailureRatesByParticipantLanguage ?? {}).sort(),
      ['alias-a::ja', 'alias-b::ja'],
    );
    assert.deepEqual(runStatus.judgeFailureRatesByParticipantLanguage?.['alias-a::ja'], { ok: 1, failed: 0 });
    assert.deepEqual(runStatus.judgeFailureRatesByParticipantLanguage?.['alias-b::ja'], { ok: 0, failed: 1 });
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner writes translation and judge observability artifacts plus run-state snapshots', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-observability-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Observability runner test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };

    let fakeNow = 0;
    let translationCalls = 0;
    let judgeCalls = 0;
    const sourceText = `${'😀'.repeat(120)}🙂trailing`;
    const participant = {
      participantId: 'gemini-3-flash',
      displayName: 'Gemini 3 Flash',
      provider: 'gemini' as const,
      providerModelId: 'gemini-3-flash-preview',
    };

    const runner = new TestRunner(benchmarkConfig, [
      {
        label: participant.participantId,
        provider: participant.provider,
        model: participant.providerModelId,
        promptFile: 'gemini.md',
        prompt: 'Translate the text.',
        dataFile: 'sentences.json',
        testCases: [{ id: 1, source: sourceText, sourceLang: 'en', targetLangs: ['ja'] }],
        client: {
          getModelName: () => participant.providerModelId,
          getProviderName: () => participant.provider,
          getRequestTimeoutMs: () => 30_000,
          translate: async () => {
            translationCalls += 1;

            if (translationCalls === 1) {
              throw {
                errorClass: 'rate_limit',
                retryable: true,
                rawMessage: 'Authorization: Bearer translation-fixture',
                retryAfterMs: 0,
                cooldownScope: 'throttle_bucket',
                requestTimeoutMs: 30_000,
              };
            }

            return {
              output: 'こんにちは',
              latencyMs: 5,
              usage: {
                provider: participant.provider,
                model: participant.providerModelId,
                phase: 'translation' as const,
                inputTokens: 10,
                outputTokens: 5,
                latencyMs: 5,
                costStatus: 'estimated' as const,
                computedCostUsd: 0.01,
              },
            };
          },
        },
      },
    ], {
      preflight: async () => {},
      judge: async () => {
        judgeCalls += 1;

        if (judgeCalls === 1) {
          throw {
            errorClass: 'rate_limit',
            retryable: true,
            rawMessage: 'authorization: Bearer judge-fixture',
            retryAfterMs: 15_000,
            cooldownScope: 'throttle_bucket',
            requestTimeoutMs: 90_000,
          };
        }

        return {
          rawText: '{"has_no_error":true,"errors":[]}',
          usage: {
            provider: 'vertex',
            model: 'gemini-2.5-flash',
            phase: 'judge',
            inputTokens: 10,
            outputTokens: 5,
            latencyMs: 2,
            costStatus: 'estimated',
            computedCostUsd: 0.01,
          },
        };
      },
    }, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-observability',
      delayMs: 0,
      resume: false,
      judgeModelId: 'gemini-2.5-flash',
      participants: [participant],
      translationConcurrencyPerModel: 1,
      translationRetryNow: () => fakeNow,
      translationRetrySleep: async (ms) => {
        fakeNow += ms;
      },
      translationRetryRandom: () => 0,
    });

    await runner.run();

    const translationEvents = readJsonlRecords<Array<Record<string, unknown>> extends infer _T ? Record<string, unknown> : never>(
      join(outputDir, 'run-observability', 'translation-events.jsonl'),
    );
    const judgeEvents = readJsonlRecords<Array<Record<string, unknown>> extends infer _T ? Record<string, unknown> : never>(
      join(outputDir, 'run-observability', 'judge-events.jsonl'),
    );
    const runState = JSON.parse(
      readFileSync(join(outputDir, 'run-observability', 'run-state.json'), 'utf8'),
    ) as {
      currentPhase: string;
      overall: {
        completed: number;
        succeeded: number;
        failed: number;
        retryCount: number;
        cumulativeRetryCount: number;
      };
      participants: Array<{
        participantId: string;
        completed: number;
        succeeded: number;
        failed: number;
        retryCount: number;
        inflight: number;
        remaining: number;
      }>;
      throttleBuckets: Array<{ throttleBucketKey: string }>;
      recentRetries: Array<{ phase: string; rawErrorMessage: string | null }>;
    };

    const translationRetry = translationEvents.find((event) => event.event_type === 'retry');
    const judgeRetry = judgeEvents.find((event) => event.event_type === 'retry');

    assert.equal(translationCalls, 2);
    assert.equal(judgeCalls, 2);
    assert.equal(translationRetry?.scope, 'item');
    assert.equal(translationRetry?.phase, 'translation');
    assert.equal(translationRetry?.throttle_bucket_key, 'gemini::gemini-3-flash-preview');
    assert.equal(translationRetry?.participant_id, 'gemini-3-flash');
    assert.equal(translationRetry?.source_id, '1');
    assert.equal(Array.from(String(translationRetry?.source_preview ?? '')).length, 120);
    assert.match(String(translationRetry?.raw_error_message ?? ''), /Bearer \*\*\*/);
    assert.doesNotMatch(String(translationRetry?.raw_error_message ?? ''), /translation-fixture/);
    assert.equal(judgeRetry?.phase, 'judge');
    assert.equal(judgeRetry?.participant_id, 'gemini-3-flash');
    assert.match(String(judgeRetry?.raw_error_message ?? ''), /Bearer \*\*\*/);
    assert.doesNotMatch(String(judgeRetry?.raw_error_message ?? ''), /judge-fixture/);
    assert.equal(runState.currentPhase, 'complete');
    assert.equal(runState.overall.completed, 2);
    assert.equal(runState.overall.succeeded, 2);
    assert.equal(runState.overall.failed, 0);
    assert.equal(runState.overall.retryCount, 2);
    assert.equal(runState.overall.cumulativeRetryCount, 2);
    assert.equal(runState.participants[0]?.participantId, 'gemini-3-flash');
    assert.equal(runState.participants[0]?.completed, 2);
    assert.equal(runState.participants[0]?.succeeded, 2);
    assert.equal(runState.participants[0]?.failed, 0);
    assert.equal(runState.participants[0]?.retryCount, 2);
    assert.equal(runState.participants[0]?.inflight, 0);
    assert.equal(runState.participants[0]?.remaining, 0);
    assert.equal(
      runState.throttleBuckets.some((bucket) => bucket.throttleBucketKey === 'gemini::gemini-3-flash-preview'),
      true,
    );
    assert.equal(runState.recentRetries.some((event) => event.phase === 'translation'), true);
    assert.equal(runState.recentRetries.some((event) => (event.rawErrorMessage ?? '').includes('translation-fixture')), false);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner uses translation artifact count for totalExpected on rejudge-like runs', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-rejudge-expected-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1-pilot',
      description: 'Rejudge expected-count test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['en', 'ja'],
      targetLanguageLabels: { en: 'English', ja: 'Japanese' },
    };

    const participants = [
      { participantId: 'qwen-3.5-plus', displayName: 'Qwen 3.5 Plus', provider: 'qwen' as const, providerModelId: 'qwen3.5-plus' },
      { participantId: 'gemini-3-flash', displayName: 'Gemini 3 Flash', provider: 'gemini' as const, providerModelId: 'gemini-3-flash-preview' },
    ];

    const conditions: Condition[] = participants.map((participant) => ({
      label: participant.participantId,
      provider: participant.provider,
      model: participant.providerModelId,
      promptFile: 'gemini.md',
      prompt: 'Translate the text.',
      dataFile: 'sentences.json',
      testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
      client: {
        getModelName: () => participant.providerModelId,
        getProviderName: () => participant.provider,
        getRequestTimeoutMs: () => 30_000,
        translate: async () => ({
          output: 'unused',
          latencyMs: 0,
          usage: {
            provider: participant.provider,
            model: participant.providerModelId,
            phase: 'translation' as const,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            costStatus: 'estimated' as const,
            computedCostUsd: 0,
          },
        }),
      },
    }));

    const layout = createRunLayout(outputDir, {
      manifestVersion: 3,
      runId: 'run-rejudge-expected',
      benchmarkId: 'gemba-mqm-v1-pilot',
      datasetVersion: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      datasetFingerprintSha256: DATASET_FINGERPRINT,
      judgeModelId: 'gemini-3.1-pro-preview',
      promptVersion: 'gemini.md',
      promptFingerprintSha256: PROMPT_FINGERPRINT,
      judgePromptVersion: 'gemba-mqm-v1',
      targetLanguages: ['en', 'ja'],
      targetLanguageLabels: { en: 'English', ja: 'Japanese' },
      limitApplied: 1,
      participants,
      translationConcurrencyPerModel: 1,
      vertexProject: 'demo-project',
      vertexRegion: 'us-central1',
      vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      resume: false,
      rejudgeFromRunId: 'run-source',
      reusedTranslations: true,
    });

    writeJsonlRecord(layout.translationJsonlPath, {
      stable_key: 'run-rejudge-expected::1::en::qwen-3.5-plus',
      source_id: '1',
      source: 'Hello',
      source_lang: 'en',
      target_language: 'en',
      target_language_label: 'English',
      participant_id: 'qwen-3.5-plus',
      participant_model_id: 'qwen3.5-plus',
      translation: 'Hello',
    });
    writeJsonlRecord(layout.normalizedJudgeJsonlPath, {
      run_id: 'run-rejudge-expected',
      source_id: '1',
      target_language: 'en',
      participant_id: 'qwen-3.5-plus',
      participant_model_id: 'qwen3.5-plus',
      judge_model_id: 'gemini-3.1-pro-preview',
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
      stable_key: 'run-rejudge-expected::1::en::qwen-3.5-plus',
    });

    const runner = new TestRunner(benchmarkConfig, conditions, null, {
      benchmarkId: 'gemba-mqm-v1-pilot',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-rejudge-expected',
      delayMs: 0,
      resume: true,
      skipTranslationPhase: true,
      judgeModelId: 'gemini-3.1-pro-preview',
      participants,
    });

    await runner.run();

    const runStatus = JSON.parse(
      readFileSync(join(outputDir, 'run-rejudge-expected', 'reports', 'run-status.json'), 'utf8'),
    ) as { totalExpected: number; totalNormalized: number; benchmarkValid: boolean };

    assert.equal(runStatus.totalExpected, 1);
    assert.equal(runStatus.totalNormalized, 1);
    assert.equal(runStatus.benchmarkValid, true);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner uses benchmark target language labels for translation prompts and codes for artifacts', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-target-langs-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'pilot-ja-only',
      pilotOf: 'gemba-mqm-v1',
      description: 'Pilot benchmark config.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: {
        ja: 'Japanese',
      },
    };

    const translatedTargetNames: string[] = [];
    const conditions: Condition[] = [
      {
        label: 'A',
        provider: 'qwen',
        model: 'qwen3.5-plus',
        promptFile: 'gemini.md',
        prompt: 'Translate the text.',
        dataFile: 'sentences.json',
        testCases: [
          {
            id: 1,
            source: 'Hello',
            sourceLang: 'en',
            targetLangs: ['en'],
          },
        ],
        client: {
          getModelName: () => 'qwen3.5-plus',
          getProviderName: () => 'qwen',
          getRequestTimeoutMs: () => 30_000,
          translate: async (_text, _prompt, _sourceLang, targetLang) => {
            translatedTargetNames.push(targetLang);
            return {
              output: `translated-${targetLang}`,
              latencyMs: 12,
              usage: {
                provider: 'qwen',
                model: 'qwen3.5-plus',
                phase: 'translation' as const,
                inputTokens: 10,
                outputTokens: 5,
                latencyMs: 12,
                costStatus: 'estimated' as const,
                computedCostUsd: 0.01,
              },
            };
          },
        },
      },
    ];

    const runner = new TestRunner(benchmarkConfig, conditions, null, {
      benchmarkId: 'pilot-ja-only',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-target-langs',
      delayMs: 0,
      resume: false,
    });

    const summary = await runner.run();
    const translationRecords = readJsonlRecords<{
      target_language: string;
      target_language_label: string;
    }>(join(outputDir, 'run-target-langs', 'translations.jsonl'));
    const runStatus = JSON.parse(
      readFileSync(join(outputDir, 'run-target-langs', 'reports', 'run-status.json'), 'utf8'),
    ) as { totalExpected: number };

    assert.deepEqual(translatedTargetNames, ['Japanese']);
    assert.deepEqual(summary.targetLangs, ['ja']);
    assert.equal(summary.totalTranslations, 1);
    assert.equal(translationRecords.length, 1);
    assert.equal(translationRecords[0]?.target_language, 'ja');
    assert.equal(translationRecords[0]?.target_language_label, 'Japanese');
    assert.equal(runStatus.totalExpected, 1);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner persists direct condition prompt metadata and rejects changed fingerprints on resume', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-direct-prompt-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Direct mixed prompt metadata test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };
    const buildCondition = (promptFingerprintSha256: string): Condition => ({
      label: 'deepseek-v4-flash-nocontext-baseline',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      promptFile: 'simple-translation.md',
      promptFingerprintSha256,
      prompt: 'Translate the text.',
      dataFile: 'sentences.json',
      testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
      client: {
        getModelName: () => 'deepseek-v4-flash',
        getProviderName: () => 'deepseek',
        getRequestTimeoutMs: () => 30_000,
        translate: async () => ({
          output: 'こんにちは',
          latencyMs: 1,
          usage: {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            phase: 'translation',
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
            costStatus: 'estimated',
            computedCostUsd: 0.01,
          },
        }),
      },
    });

    const firstRunner = new TestRunner(benchmarkConfig, [buildCondition('c'.repeat(64))], null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-direct-prompt',
      delayMs: 0,
      resume: false,
    });
    await firstRunner.run();

    const manifest = JSON.parse(readFileSync(join(outputDir, 'run-direct-prompt', 'manifest.json'), 'utf8')) as {
      participants: Array<{ promptFile?: string; promptFingerprintSha256?: string }>;
    };
    assert.equal(manifest.participants[0]?.promptFile, 'simple-translation.md');
    assert.equal(manifest.participants[0]?.promptFingerprintSha256, 'c'.repeat(64));

    const resumedRunner = new TestRunner(benchmarkConfig, [buildCondition('d'.repeat(64))], null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-direct-prompt',
      delayMs: 0,
      resume: true,
      skipTranslationPhase: true,
    });

    await assert.rejects(
      () => resumedRunner.run(),
      /existing manifest does not match the requested resume configuration/i,
    );
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner merges direct condition prompt metadata into provided participant snapshots', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-direct-participants-prompt-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Direct participant prompt metadata test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };
    const condition: Condition = {
      label: 'deepseek-v4-flash-nocontext-baseline',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      promptFile: 'simple-translation.md',
      promptFingerprintSha256: 'c'.repeat(64),
      prompt: 'Translate the text.',
      dataFile: 'sentences.json',
      testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
      client: {
        getModelName: () => 'deepseek-v4-flash',
        getProviderName: () => 'deepseek',
        getRequestTimeoutMs: () => 30_000,
        translate: async () => ({
          output: 'こんにちは',
          latencyMs: 1,
          usage: {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            phase: 'translation',
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
            costStatus: 'estimated',
            computedCostUsd: 0.01,
          },
        }),
      },
    };
    const runner = new TestRunner(benchmarkConfig, [condition], null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-direct-participants-prompt',
      delayMs: 0,
      resume: false,
      participants: [
        {
          participantId: 'deepseek-v4-flash-nocontext-baseline',
          displayName: 'DeepSeek V4 Flash (No context baseline)',
          provider: 'deepseek',
          providerModelId: 'deepseek-v4-flash',
        },
      ],
    });

    await runner.run();

    const manifest = JSON.parse(readFileSync(join(outputDir, 'run-direct-participants-prompt', 'manifest.json'), 'utf8')) as {
      participants: Array<{ displayName?: string; promptFile?: string; promptFingerprintSha256?: string }>;
    };
    assert.equal(manifest.participants[0]?.displayName, 'DeepSeek V4 Flash (No context baseline)');
    assert.equal(manifest.participants[0]?.promptFile, 'simple-translation.md');
    assert.equal(manifest.participants[0]?.promptFingerprintSha256, 'c'.repeat(64));
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner supports direct mixed shared and override prompt metadata without participants', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-direct-mixed-prompt-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Direct mixed shared and override prompt metadata test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };
    const makeCondition = (
      label: string,
      promptFile: string,
      promptFingerprintSha256: string,
    ): Condition => ({
      label,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      promptFile,
      promptFingerprintSha256,
      prompt: 'Translate the text.',
      dataFile: 'sentences.json',
      testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
      client: {
        getModelName: () => 'deepseek-v4-flash',
        getProviderName: () => 'deepseek',
        getRequestTimeoutMs: () => 30_000,
        translate: async () => ({
          output: 'こんにちは',
          latencyMs: 1,
          usage: {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            phase: 'translation',
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
            costStatus: 'estimated',
            computedCostUsd: 0.01,
          },
        }),
      },
    });
    const runner = new TestRunner(benchmarkConfig, [
      makeCondition('deepseek-v4-flash', 'gemini.md', 'b'.repeat(64)),
      makeCondition('deepseek-v4-flash-nocontext-baseline', 'simple-translation.md', 'c'.repeat(64)),
    ], null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-direct-mixed-prompt',
      delayMs: 0,
      resume: false,
    });

    await runner.run();

    const manifest = JSON.parse(readFileSync(join(outputDir, 'run-direct-mixed-prompt', 'manifest.json'), 'utf8')) as {
      participants: Array<{ participantId: string; promptFile?: string; promptFingerprintSha256?: string }>;
    };
    assert.deepEqual(manifest.participants.map((participant) => participant.participantId), [
      'deepseek-v4-flash',
      'deepseek-v4-flash-nocontext-baseline',
    ]);
    assert.equal(manifest.participants[0]?.promptFile, undefined);
    assert.equal(manifest.participants[0]?.promptFingerprintSha256, undefined);
    assert.equal(manifest.participants[1]?.promptFile, 'simple-translation.md');
    assert.equal(manifest.participants[1]?.promptFingerprintSha256, 'c'.repeat(64));
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner rejects direct override prompt conditions without fingerprints', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-direct-missing-prompt-fingerprint-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'gemba-mqm-v1',
      description: 'Direct missing override prompt fingerprint test.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['ja'],
      targetLanguageLabels: { ja: 'Japanese' },
    };
    const makeCondition = (): Condition => ({
      label: 'deepseek-v4-flash-nocontext-baseline',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      promptFile: 'simple-translation.md',
      prompt: 'Translate the text.',
      dataFile: 'sentences.json',
      testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
      client: {
        getModelName: () => 'deepseek-v4-flash',
        getProviderName: () => 'deepseek',
        getRequestTimeoutMs: () => 30_000,
        translate: async () => ({
          output: 'こんにちは',
          latencyMs: 1,
          usage: {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            phase: 'translation',
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
            costStatus: 'estimated',
            computedCostUsd: 0.01,
          },
        }),
      },
    });

    const runnerWithoutParticipants = new TestRunner(benchmarkConfig, [makeCondition()], null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-direct-missing-prompt-fingerprint-a',
      delayMs: 0,
      resume: false,
    });
    await assert.rejects(
      () => runnerWithoutParticipants.run(),
      /promptFingerprintSha256/i,
    );

    const runnerWithParticipants = new TestRunner(benchmarkConfig, [makeCondition()], null, {
      benchmarkId: 'gemba-mqm-v1',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-direct-missing-prompt-fingerprint-b',
      delayMs: 0,
      resume: false,
      participants: [
        {
          participantId: 'deepseek-v4-flash-nocontext-baseline',
          displayName: 'DeepSeek V4 Flash (No context baseline)',
          provider: 'deepseek',
          providerModelId: 'deepseek-v4-flash',
        },
      ],
    });
    await assert.rejects(
      () => runnerWithParticipants.run(),
      /promptFingerprintSha256/i,
    );
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('TestRunner treats limit 0 as explicit zero samples and marks run invalid', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'runner-zero-limit-'));

  try {
    setDefaultFingerprints();

    const benchmarkConfig: BenchmarkConfig = {
      benchmarkId: 'pilot-zero-limit',
      pilotOf: 'gemba-mqm-v1',
      description: 'Pilot benchmark config.',
      sharedPromptFile: 'gemini.md',
      dataFile: 'sentences.json',
      ...SENTENCE_TRACK_FIELDS,
      targetLanguages: ['en'],
      targetLanguageLabels: {
        en: 'English',
      },
    };

    let translateCalls = 0;
    const conditions: Condition[] = [
      {
        label: 'A',
        provider: 'qwen',
        model: 'qwen3.5-plus',
        promptFile: 'gemini.md',
        prompt: 'Translate the text.',
        dataFile: 'sentences.json',
        testCases: [
          {
            id: 1,
            source: 'Hello',
            sourceLang: 'en',
            targetLangs: ['en'],
          },
        ],
        client: {
          getModelName: () => 'qwen3.5-plus',
          getProviderName: () => 'qwen',
          getRequestTimeoutMs: () => 30_000,
          translate: async () => {
            translateCalls += 1;
            return {
              output: 'Hello',
              latencyMs: 5,
              usage: {
                provider: 'qwen',
                model: 'qwen3.5-plus',
                phase: 'translation' as const,
                inputTokens: 10,
                outputTokens: 5,
                latencyMs: 5,
                costStatus: 'estimated' as const,
                computedCostUsd: 0.01,
              },
            };
          },
        },
      },
    ];

    const runner = new TestRunner(benchmarkConfig, conditions, null, {
      benchmarkId: 'pilot-zero-limit',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      outputDir,
      runId: 'run-zero-limit',
      delayMs: 0,
      limit: 0,
      resume: false,
    });

    const summary = await runner.run();
    const runStatus = JSON.parse(
      readFileSync(join(outputDir, 'run-zero-limit', 'reports', 'run-status.json'), 'utf8'),
    ) as { benchmarkValid: boolean; totalExpected: number; totalNormalized: number };

    assert.equal(translateCalls, 0);
    assert.equal(summary.totalSentences, 0);
    assert.equal(summary.totalTranslations, 0);
    assert.equal(runStatus.totalExpected, 0);
    assert.equal(runStatus.totalNormalized, 0);
    assert.equal(runStatus.benchmarkValid, false);
  } finally {
    clearRunManifestFingerprintDefaults();
    rmSync(outputDir, { recursive: true, force: true });
  }
});
