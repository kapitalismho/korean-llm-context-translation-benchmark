import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { loadBenchmarkConfig } from '../src/benchmark-config.js';
import type { BenchmarkConfig } from '../src/benchmark-config.js';
import { GeminiCliGembaJudge } from '../src/gemini-cli-judge.js';
import { assertValidCliOptions, buildConditionsFromParticipantRegistry, buildProgram, createJudgeClient, estimateJudgeRequests, finalizeCliRun, main } from '../src/index.js';
import { computeFileSha256 } from '../src/run-artifacts.js';
import { VertexGembaJudge } from '../src/vertex-judge.js';
import * as indexModule from '../src/index.js';

const SENTENCE_TRACK_FIELDS = {
  datasetKind: 'sentence',
  judgePromptSetId: 'gemba-mqm-v1',
} as const;

function withTempRegistry(registry: unknown, run: (registryPath: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'index-cli-registry-'));
  const registryPath = join(tempDir, 'registry.json');

  try {
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    run(registryPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('buildConditionsFromParticipantRegistry preserves explicit participant selection order', () => {
  const benchmarkConfig: BenchmarkConfig = {
    benchmarkId: 'gemba-mqm-v1',
    description: 'Registry-backed benchmark.',
    sharedPromptFile: 'data/prompts/gemini.md',
    dataFile: 'data/sentences.json',
    ...SENTENCE_TRACK_FIELDS,
    targetLanguages: ['ja'],
    targetLanguageLabels: { ja: 'Japanese' },
  };

  withTempRegistry([
    {
      participantId: 'alias-one',
      displayName: 'Alias One',
      provider: 'gemini',
      providerModelId: 'shared-model',
    },
    {
      participantId: 'alias-two',
      displayName: 'Alias Two',
      provider: 'gemini',
      providerModelId: 'shared-model',
    },
    {
      participantId: 'qwen-3.6-plus',
      displayName: 'Qwen 3.6 Plus',
      provider: 'qwen',
      providerModelId: 'qwen3.6-plus',
    },
  ], (registryPath) => {
    const conditions = buildConditionsFromParticipantRegistry({
      benchmarkConfig,
      sharedPrompt: 'Translate the text.',
      testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
      env: {},
      participantRegistryPath: registryPath,
      participantIds: ['alias-two', 'qwen-3.6-plus', 'alias-one'],
      clientFactory: (provider, model) => ({
        getModelName: () => model,
        getProviderName: () => provider,
        getRequestTimeoutMs: () => 30_000,
        translate: async () => ({
          output: 'unused',
          latencyMs: 0,
          usage: {
            provider,
            model,
            phase: 'translation',
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            costStatus: 'estimated',
            computedCostUsd: 0,
          },
        }),
      }),
    });

    assert.deepEqual(conditions.map((condition) => condition.label), [
      'alias-two',
      'qwen-3.6-plus',
      'alias-one',
    ]);
    assert.deepEqual(conditions.map((condition) => condition.model), [
      'shared-model',
      'qwen3.6-plus',
      'shared-model',
    ]);
  });
});

test('buildConditionsFromParticipantRegistry forwards participant message layout to the client factory', () => {
  const benchmarkConfig: BenchmarkConfig = {
    benchmarkId: 'gemba-mqm-v1',
    description: 'Registry-backed benchmark.',
    sharedPromptFile: 'data/prompts/gemini.md',
    dataFile: 'data/sentences.json',
    ...SENTENCE_TRACK_FIELDS,
    targetLanguages: ['ja'],
    targetLanguageLabels: { ja: 'Japanese' },
  };

  withTempRegistry([
    {
      participantId: 'default-openrouter',
      displayName: 'Default OpenRouter',
      provider: 'openrouter',
      providerModelId: 'google/gemma-4-26b-a4b-it',
    },
    {
      participantId: 'system-context-openrouter',
      displayName: 'System Context OpenRouter',
      provider: 'openrouter',
      providerModelId: 'deepseek/deepseek-v4-flash',
      messageLayout: 'system-context',
    },
  ], (registryPath) => {
    const receivedLayouts: Array<string | undefined> = [];
    const conditions = buildConditionsFromParticipantRegistry({
      benchmarkConfig,
      sharedPrompt: 'Translate the text.',
      testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
      env: {},
      participantRegistryPath: registryPath,
      participantIds: ['system-context-openrouter', 'default-openrouter'],
      clientFactory: (provider, model, _env, options) => {
        receivedLayouts.push(options?.messageLayout);
        return {
          getModelName: () => model,
          getProviderName: () => provider,
          getRequestTimeoutMs: () => 30_000,
          translate: async () => ({
            output: 'unused',
            latencyMs: 0,
            usage: {
              provider,
              model,
              phase: 'translation',
              inputTokens: 0,
              outputTokens: 0,
              latencyMs: 0,
              costStatus: 'estimated',
              computedCostUsd: 0,
            },
          }),
        };
      },
    });

    assert.deepEqual(conditions.map((condition) => condition.label), [
      'system-context-openrouter',
      'default-openrouter',
    ]);
    assert.deepEqual(receivedLayouts, ['system-context', undefined]);
  });
});

test('buildConditionsFromParticipantRegistry uses participant promptFile overrides when present', () => {
  const benchmarkConfig: BenchmarkConfig = {
    benchmarkId: 'gemba-mqm-v1',
    description: 'Registry-backed benchmark.',
    sharedPromptFile: 'data/prompts/gemini-context-rework.md',
    dataFile: 'data/sentences.json',
    ...SENTENCE_TRACK_FIELDS,
    targetLanguages: ['ja'],
    targetLanguageLabels: { ja: 'Japanese' },
  };

  withTempRegistry([
    {
      participantId: 'context-model',
      displayName: 'Context Model',
      provider: 'gemini',
      providerModelId: 'gemini-3-flash-preview',
    },
    {
      participantId: 'baseline-model',
      displayName: 'Baseline Model',
      provider: 'deepseek',
      providerModelId: 'deepseek-v4-flash',
      promptFile: './prompts/simple.md',
    },
  ], (registryPath) => {
    const promptFile = join(dirname(registryPath), 'prompts', 'simple.md');
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, 'Translate ${sourceName} into ${targetName}.');

    const conditions = buildConditionsFromParticipantRegistry({
      benchmarkConfig,
      sharedPrompt: 'Context-aware prompt ${sourceName} ${targetName}.',
      testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
      env: {},
      participantRegistryPath: registryPath,
      participantIds: ['context-model', 'baseline-model'],
      clientFactory: (provider, model) => ({
        getModelName: () => model,
        getProviderName: () => provider,
        getRequestTimeoutMs: () => 30_000,
        translate: async () => ({
          output: 'unused',
          latencyMs: 0,
          usage: {
            provider,
            model,
            phase: 'translation',
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
            costStatus: 'estimated',
            computedCostUsd: 0,
          },
        }),
      }),
    });

    assert.equal(conditions[0].prompt, 'Context-aware prompt ${sourceName} ${targetName}.');
    assert.equal(conditions[0].promptFile, 'data/prompts/gemini-context-rework.md');
    assert.equal(conditions[0].promptFingerprintSha256, computeFileSha256('data/prompts/gemini-context-rework.md'));
    assert.equal(conditions[1].prompt, 'Translate ${sourceName} into ${targetName}.');
    assert.equal(conditions[1].promptFile, promptFile);
    assert.equal(conditions[1].promptFingerprintSha256, computeFileSha256(promptFile));
  });
});

test('buildConditionsFromParticipantRegistry reports missing participant promptFile clearly', () => {
  const benchmarkConfig: BenchmarkConfig = {
    benchmarkId: 'gemba-mqm-v1',
    description: 'Registry-backed benchmark.',
    sharedPromptFile: 'data/prompts/gemini-context-rework.md',
    dataFile: 'data/sentences.json',
    ...SENTENCE_TRACK_FIELDS,
    targetLanguages: ['ja'],
    targetLanguageLabels: { ja: 'Japanese' },
  };

  withTempRegistry([
    {
      participantId: 'context-model',
      displayName: 'Context Model',
      provider: 'gemini',
      providerModelId: 'gemini-3-flash-preview',
    },
    {
      participantId: 'baseline-model',
      displayName: 'Baseline Model',
      provider: 'deepseek',
      providerModelId: 'deepseek-v4-flash',
      promptFile: './prompts/missing.md',
    },
  ], (registryPath) => {
    assert.throws(
      () => buildConditionsFromParticipantRegistry({
        benchmarkConfig,
        sharedPrompt: 'Context-aware prompt.',
        testCases: [{ id: 1, source: 'Hello', sourceLang: 'en', targetLangs: ['ja'] }],
        env: {},
        participantRegistryPath: registryPath,
        participantIds: ['baseline-model'],
        clientFactory: (provider, model) => ({
          getModelName: () => model,
          getProviderName: () => provider,
          getRequestTimeoutMs: () => 30_000,
          translate: async () => ({
            output: 'unused',
            latencyMs: 0,
            usage: {
              provider,
              model,
              phase: 'translation',
              inputTokens: 0,
              outputTokens: 0,
              latencyMs: 0,
              costStatus: 'estimated',
              computedCostUsd: 0,
            },
          }),
        }),
      }),
      /participant prompt file not found/i,
    );
  });
});

test('buildProgram exposes benchmark config and judge options', () => {
  const program = buildProgram();
  const optionFlags = program.options.map((option) => option.long);

  assert.equal(program.name(), 'korean-llm-context-translation-benchmark');
  assert.ok(optionFlags.includes('--benchmark-config'));
  assert.ok(optionFlags.includes('--judge-model'));
  assert.ok(optionFlags.includes('--judge-backend'));
  assert.ok(optionFlags.includes('--gemini-cli-bin'));
  assert.ok(optionFlags.includes('--participants'));
  assert.ok(optionFlags.includes('--participant-registry'));
  assert.ok(optionFlags.includes('--fork-from-run'));
  assert.ok(optionFlags.includes('--rejudge-from-run'));
  assert.ok(optionFlags.includes('--translation-concurrency'));
  assert.ok(optionFlags.includes('--translation-concurrency-per-model'));
  assert.ok(optionFlags.includes('--judge-concurrency'));
  assert.ok(optionFlags.includes('--resume'));
  assert.ok(!optionFlags.includes('--condition'));
  assert.ok(!optionFlags.includes('--no-interactive'));
});

test('assertValidCliOptions parses Gemini CLI judge backend options', () => {
  const parsed = assertValidCliOptions({
    delay: '0',
    participants: 'qwen-3.5-plus',
    judgeBackend: 'gemini-cli',
    geminiCliBin: '/usr/local/bin/gemini',
  });

  assert.equal(parsed.judgeBackend, 'gemini-cli');
  assert.equal(parsed.geminiCliBin, '/usr/local/bin/gemini');
});

test('assertValidCliOptions rejects unsupported judge backends', () => {
  assert.throws(
    () => assertValidCliOptions({
      delay: '0',
      participants: 'qwen-3.5-plus',
      judgeBackend: 'antigravity',
    }),
    /--judge-backend must be vertex or gemini-cli/i,
  );
});

test('createJudgeClient constructs the Gemini CLI judge backend', () => {
  const judge = createJudgeClient({
    judgeBackend: 'gemini-cli',
    judgeModel: 'gemini-3.1-pro-preview',
    geminiCliBin: '/usr/local/bin/gemini',
    env: {},
  });

  assert.ok(judge instanceof GeminiCliGembaJudge);
});

test('createJudgeClient uses GEMINI_CLI_BIN when no explicit Gemini CLI binary is provided', () => {
  const judge = createJudgeClient({
    judgeBackend: 'gemini-cli',
    judgeModel: 'gemini-3.1-pro-preview',
    env: {
      GEMINI_CLI_BIN: 'fixture-bin/gemini',
    },
  }) as GeminiCliGembaJudge;

  assert.equal(judge['cliBin'], 'fixture-bin/gemini');
});

test('assertValidCliOptions requires participants on fresh runs', () => {
  assert.throws(
    () => assertValidCliOptions({ delay: '0', participants: undefined }),
    /--participants is required for fresh runs/i,
  );
});

test('assertValidCliOptions rejects participants during resume', () => {
  assert.throws(
    () => assertValidCliOptions({
      delay: '0',
      resume: true,
      runId: 'run-001',
      participants: 'qwen-3.6-plus,gemini-3-flash',
    }),
    /--participants is not allowed with --resume/i,
  );
});

test('assertValidCliOptions rejects participants during rejudge', () => {
  assert.throws(
    () => assertValidCliOptions({
      delay: '0',
      rejudgeFromRun: 'run-001',
      judgeModel: 'gemini-2.5-flash',
      participants: 'qwen-3.6-plus,gemini-3-flash',
    }),
    /--participants is not allowed with --rejudge-from-run/i,
  );
});

test('assertValidCliOptions allows participants and participant registry during fork mode', () => {
  const parsed = assertValidCliOptions({
    delay: '0',
    forkFromRun: 'run-001',
    participants: 'qwen-3.6-plus,gemini-3-flash',
    participantRegistry: 'custom-registry.json',
  });

  assert.deepEqual(parsed.participantIds, ['qwen-3.6-plus', 'gemini-3-flash']);
  assert.equal(parsed.participantRegistryPath, 'custom-registry.json');
});

test('assertValidCliOptions rejects duplicate participant ids on fresh runs', () => {
  assert.throws(
    () => assertValidCliOptions({
      delay: '0',
      participants: 'qwen-3.6-plus,gemini-3-flash,qwen-3.6-plus',
    }),
    /duplicate participant id.*qwen-3\.6-plus/i,
  );
});

test('assertValidCliOptions rejects participant registry during resume', () => {
  assert.throws(
    () => assertValidCliOptions({
      delay: '0',
      resume: true,
      runId: 'run-001',
      participantRegistry: 'custom-registry.json',
    }),
    /--participant-registry is not allowed with --resume/i,
  );
});

test('assertValidCliOptions rejects participant registry during rejudge', () => {
  assert.throws(
    () => assertValidCliOptions({
      delay: '0',
      rejudgeFromRun: 'run-001',
      judgeModel: 'gemini-2.5-flash',
      participantRegistry: 'custom-registry.json',
    }),
    /--participant-registry is not allowed with --rejudge-from-run/i,
  );
});

test('assertValidCliOptions rejects fork with resume', () => {
  assert.throws(
    () => assertValidCliOptions({
      delay: '0',
      resume: true,
      runId: 'run-001',
      forkFromRun: 'run-source',
    }),
    /--resume and --fork-from-run cannot be used together/i,
  );
});

test('assertValidCliOptions rejects fork with rejudge', () => {
  assert.throws(
    () => assertValidCliOptions({
      delay: '0',
      forkFromRun: 'run-source',
      rejudgeFromRun: 'run-old',
      judgeModel: 'gemini-2.5-flash',
      participants: 'qwen-3.6-plus,gemini-3-flash',
    }),
    /--fork-from-run and --rejudge-from-run cannot be used together/i,
  );
});

test('assertValidCliOptions rejects limit during resume', () => {
  assert.throws(
    () => assertValidCliOptions({
      delay: '0',
      resume: true,
      runId: 'run-001',
      limit: '5',
    }),
    /--limit is not allowed with --resume/i,
  );
});

test('assertValidCliOptions rejects limit during rejudge', () => {
  assert.throws(
    () => assertValidCliOptions({
      delay: '0',
      rejudgeFromRun: 'run-001',
      judgeModel: 'gemini-2.5-flash',
      limit: '5',
    }),
    /--limit is not allowed with --rejudge-from-run/i,
  );
});

test('assertValidCliOptions rejects rejudge without a judge model', () => {
  assert.throws(
    () => assertValidCliOptions({ rejudgeFromRun: 'run-old', judgeModel: undefined, delay: '0' }),
    /--rejudge-from-run requires --judge-model/,
  );
});

test('assertValidCliOptions rejects rejudge with no-judge', () => {
  assert.throws(
    () => assertValidCliOptions({
      rejudgeFromRun: 'run-old',
      judgeModel: 'gemini-2.5-flash',
      judge: false,
      delay: '0',
    }),
    /--rejudge-from-run cannot be used with --no-judge/,
  );
});

test('estimateJudgeRequests uses reused translation count for rejudge runs', () => {
  assert.equal(
    estimateJudgeRequests({
      maxCases: 5,
      participantCount: 7,
      targetLanguageCount: 3,
      reusedTranslationCount: 15,
    }),
    15,
  );
});

test('assertValidCliOptions rejects resume without run id', () => {
  assert.throws(() => assertValidCliOptions({ resume: true, runId: undefined }));
});

test('assertValidCliOptions rejects invalid limit values', () => {
  assert.throws(
    () => assertValidCliOptions({ limit: 'nope', delay: '0', participants: 'qwen-3.6-plus,gemini-3-flash' }),
    /--limit must be a positive integer/,
  );
});

test('assertValidCliOptions rejects zero limit values', () => {
  assert.throws(
    () => assertValidCliOptions({ limit: '0', delay: '0', participants: 'qwen-3.6-plus,gemini-3-flash' }),
    /--limit must be a positive integer/,
  );
});

test('assertValidCliOptions rejects negative delay values', () => {
  assert.throws(
    () => assertValidCliOptions({ delay: '-1', participants: 'qwen-3.6-plus,gemini-3-flash' }),
    /--delay must be a non-negative integer/,
  );
});

test('assertValidCliOptions rejects both translation concurrency flags together', () => {
  assert.throws(
    () => assertValidCliOptions({
      delay: '0',
      participants: 'qwen-3.6-plus,gemini-3-flash',
      translationConcurrency: '2',
      translationConcurrencyPerModel: '3',
    }),
    /use either --translation-concurrency or --translation-concurrency-per-model, not both/i,
  );
});

test('assertValidCliOptions keeps translation concurrency alias as the per-model value', () => {
  const parsed = assertValidCliOptions({
    delay: '0',
    participants: 'qwen-3.6-plus,gemini-3-flash',
    translationConcurrency: '4',
  });

  assert.deepEqual(parsed.participantIds, ['qwen-3.6-plus', 'gemini-3-flash']);
  assert.equal(parsed.translationConcurrencyPerModel, 4);
});

test('finalizeCliRun reports benchmark artifact locations without printing legacy summary', () => {
  const events: string[] = [];
  const runner = {
    printSummary: () => {
      events.push('printSummary');
    },
    saveResults: () => {
      events.push('saveResults');
      return 'unused';
    },
  };

  finalizeCliRun({
    judged: true,
    outputDir: 'fixture-output',
    runId: 'run-123',
    summary: {
      timestamp: '2026-01-01T00:00:00.000Z',
      judgeModel: 'gemini-2.5-flash',
      conditions: [],
      totalSentences: 0,
      totalTranslations: 0,
      targetLangs: [],
      prompts: {},
      results: [],
      summaryByLang: {},
      summaryOverall: { latencies: {}, scores: {} },
    },
    runner,
    log: (message) => {
      events.push(message);
    },
  });

  assert.deepEqual(events, [
    `Benchmark artifacts saved under: ${join('fixture-output', 'run-123')}`,
    `Benchmark reports saved under: ${join('fixture-output', 'run-123', 'reports')}`,
  ]);
});

test('loadBenchmarkTestCases loads context runtime samples when datasetKind is context', () => {
  const config = loadBenchmarkConfig(new URL('../data/benchmarks/gemba-mqm-context-v1.json', import.meta.url));
  const loadBenchmarkTestCases = (indexModule as typeof indexModule & {
    loadBenchmarkTestCases?: (benchmarkConfig: BenchmarkConfig) => Array<Record<string, unknown>>;
  }).loadBenchmarkTestCases;

  assert.equal(config.datasetKind, 'context');
  assert.equal(typeof loadBenchmarkTestCases, 'function');

  const testCases = loadBenchmarkTestCases?.(config) ?? [];

  assert.ok(testCases.length > 0);
  assert.ok('sampleId' in testCases[0]!);
});

test('main passes benchmark judgePromptSetId through rejudge manifest and runner setup', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'index-cli-rejudge-'));
  const outputDir = join(tempDir, 'output');
  const benchmarkDir = join(tempDir, 'benchmark');
  const configPath = join(benchmarkDir, 'benchmark.json');
  const promptPath = join(benchmarkDir, 'prompt.md');
  const datasetPath = join(benchmarkDir, 'sentences.json');
  const sourceRunDir = join(outputDir, 'run-source');
  const originalPreflight = VertexGembaJudge.prototype.preflight;
  const originalJudge = VertexGembaJudge.prototype.judge;
  const originalVertexAi = process.env.GOOGLE_GENAI_USE_VERTEXAI;
  const originalProject = process.env.GOOGLE_CLOUD_PROJECT;
  const originalLocation = process.env.GOOGLE_CLOUD_LOCATION;
  const originalDashscopeApiKey = process.env.DASHSCOPE_API_KEY;
  let preflightCalled = false;

  try {
    mkdirSync(benchmarkDir, { recursive: true });
    mkdirSync(sourceRunDir, { recursive: true });

    writeFileSync(promptPath, 'Translate the text.');
    writeFileSync(datasetPath, JSON.stringify([
      {
        id: 1,
        source: 'Hello',
        sourceLang: 'en',
        targetLangs: ['en'],
      },
    ], null, 2));
    writeFileSync(configPath, JSON.stringify({
      benchmarkId: 'gemba-mqm-v1',
      description: 'CLI rejudge prompt-set passthrough.',
      sharedPromptFile: './prompt.md',
      dataFile: './sentences.json',
      datasetKind: 'sentence',
      judgePromptSetId: 'gemba-mqm-context-v1',
      targetLanguages: ['en'],
      targetLanguageLabels: {
        en: 'English',
      },
    }, null, 2));

    const datasetFingerprintSha256 = computeFileSha256(datasetPath);
    const promptFingerprintSha256 = computeFileSha256(promptPath);

    writeFileSync(join(sourceRunDir, 'manifest.json'), `${JSON.stringify({
      manifestVersion: 3,
      runId: 'run-source',
      benchmarkId: 'gemba-mqm-v1',
      datasetVersion: 'sentences.json',
      datasetKind: 'sentence',
      datasetFingerprintSha256,
      promptVersion: 'source-prompt.md',
      promptFingerprintSha256,
      judgePromptVersion: 'gemba-mqm-context-v1',
      judgePromptSetId: 'gemba-mqm-context-v1',
      judgeModelId: 'gemini-2.5-flash',
      targetLanguages: ['en'],
      targetLanguageLabels: {
        en: 'English',
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
      stable_key: 'run-source::1::en::qwen-3.5-plus',
      source_id: '1',
      source: 'Hello',
      source_lang: 'en',
      target_language: 'en',
      target_language_label: 'English',
      participant_id: 'qwen-3.5-plus',
      participant_model_id: 'qwen3.5-plus',
      translation: 'Hello',
    })}\n`);

    VertexGembaJudge.prototype.preflight = async function patchedPreflight() {
      preflightCalled = true;
      throw new Error('preflight should not run when the configured judge prompt set requires context variables');
    };
    VertexGembaJudge.prototype.judge = async function patchedJudge() {
      throw new Error('judge should not run in this test');
    };

    process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
    process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
    process.env.GOOGLE_CLOUD_LOCATION = 'us-central1';
    process.env.DASHSCOPE_API_KEY = 'fixture-key';

    await assert.rejects(
      () => main([
        'node',
        'korean-llm-context-translation-benchmark',
        '--benchmark-config',
        configPath,
        '--output',
        outputDir,
        '--run-id',
        'run-rejudge',
        '--rejudge-from-run',
        'run-source',
        '--judge-model',
        'gemini-2.5-flash',
        '--delay',
        '0',
      ]),
      /requires non-sentence template variables|contextBlock|currentSource/i,
    );

    assert.equal(preflightCalled, false);

    const manifest = JSON.parse(readFileSync(join(outputDir, 'run-rejudge', 'manifest.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(manifest.judgePromptVersion, 'gemba-mqm-context-v1');
    assert.equal(manifest.judgePromptSetId, 'gemba-mqm-context-v1');
  } finally {
    VertexGembaJudge.prototype.preflight = originalPreflight;
    VertexGembaJudge.prototype.judge = originalJudge;

    if (originalVertexAi === undefined) {
      delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
    } else {
      process.env.GOOGLE_GENAI_USE_VERTEXAI = originalVertexAi;
    }

    if (originalProject === undefined) {
      delete process.env.GOOGLE_CLOUD_PROJECT;
    } else {
      process.env.GOOGLE_CLOUD_PROJECT = originalProject;
    }

    if (originalLocation === undefined) {
      delete process.env.GOOGLE_CLOUD_LOCATION;
    } else {
      process.env.GOOGLE_CLOUD_LOCATION = originalLocation;
    }

    if (originalDashscopeApiKey === undefined) {
      delete process.env.DASHSCOPE_API_KEY;
    } else {
      process.env.DASHSCOPE_API_KEY = originalDashscopeApiKey;
    }

    rmSync(tempDir, { recursive: true, force: true });
  }
});
