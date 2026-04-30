#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Command } from 'commander';
import { config } from 'dotenv';

import { loadBenchmarkConfig, type BenchmarkConfig } from './benchmark-config.js';
import { isContextRuntimeSample, loadContextRuntimeDataset } from './context-dataset.js';
import { prepareForkRun } from './fork-run.js';
import { GeminiCliGembaJudge } from './gemini-cli-judge.js';
import type { BenchmarkTestCase, Condition, SentenceTestCase } from './llm-client.js';
import {
  loadParticipantRegistry,
  resolveSelectedParticipants,
  type ParticipantDefinition,
} from './participant-registry.js';
import { createClient, type CreateClientOptions } from './provider-factory.js';
import { prepareRejudgeRun } from './rejudge.js';
import {
  clearRunManifestFingerprintDefaults,
  computeFileSha256,
  loadRunManifest,
  setRunManifestFingerprintDefaults,
  type JudgeBackend,
} from './run-artifacts.js';
import type { TestSummary } from './runner.js';
import { TestRunner } from './runner.js';
import { VertexGembaJudge, resolveVertexJudgeConfig } from './vertex-judge.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultParticipantRegistryPath = path.resolve(projectRoot, 'data/participants/registry.json');

config({ path: path.resolve(projectRoot, '.env') });

type Environment = Record<string, string | undefined>;
type ClientFactory = (provider: ParticipantDefinition['provider'], model: string, env: Environment, options?: CreateClientOptions) => ReturnType<typeof createClient>;

export function buildConditionsFromParticipants(params: {
  benchmarkConfig: Pick<BenchmarkConfig, 'sharedPromptFile' | 'dataFile'>;
  sharedPrompt: string;
  testCases: BenchmarkTestCase[];
  env: Environment;
  participants: ParticipantDefinition[];
  clientFactory?: ClientFactory;
}): Condition[] {
  const clientFactory = params.clientFactory ?? createClient;

  return params.participants.map((participant) => {
    const promptFile = participant.promptFile ?? params.benchmarkConfig.sharedPromptFile;
    const prompt = participant.promptFile
      ? readPromptOverride(participant.promptFile)
      : params.sharedPrompt;

    return {
      label: participant.participantId,
      provider: participant.provider,
      model: participant.providerModelId,
      promptFile,
      promptFingerprintSha256: computeFileSha256(promptFile),
      prompt,
      dataFile: params.benchmarkConfig.dataFile,
      testCases: params.testCases,
      client: clientFactory(participant.provider, participant.providerModelId, params.env, {
        messageLayout: participant.messageLayout,
      }),
    };
  });
}

function readPromptOverride(promptFile: string): string {
  if (!existsSync(promptFile)) {
    throw new Error(`Participant prompt file not found: ${promptFile}`);
  }

  const prompt = readFileSync(promptFile, 'utf8').trim();

  if (prompt.length === 0) {
    throw new Error(`Participant prompt file is empty: ${promptFile}`);
  }

  return prompt;
}

export function buildConditionsFromParticipantRegistry(params: {
  benchmarkConfig: Pick<BenchmarkConfig, 'sharedPromptFile' | 'dataFile'>;
  sharedPrompt: string;
  testCases: BenchmarkTestCase[];
  env: Environment;
  participantRegistryPath?: string;
  participantIds: string[];
  clientFactory?: ClientFactory;
}): Condition[] {
  const registry = loadParticipantRegistry(params.participantRegistryPath ?? defaultParticipantRegistryPath);
  const participants = resolveSelectedParticipants(registry, params.participantIds);

  return buildConditionsFromParticipants({
    benchmarkConfig: params.benchmarkConfig,
    sharedPrompt: params.sharedPrompt,
    testCases: params.testCases,
    env: params.env,
    participants,
    clientFactory: params.clientFactory,
  });
}

export function loadBenchmarkTestCases(benchmarkConfig: BenchmarkConfig): BenchmarkTestCase[] {
  return benchmarkConfig.datasetKind === 'context'
    ? loadContextRuntimeDataset(benchmarkConfig.dataFile)
    : JSON.parse(readFileSync(benchmarkConfig.dataFile, 'utf8')) as SentenceTestCase[];
}

interface CliOptions {
  benchmarkConfig: string;
  participantRegistry?: string;
  participants?: string;
  judgeBackend?: string;
  judgeModel?: string;
  geminiCliBin?: string;
  runId?: string;
  output: string;
  limit?: string;
  delay: string;
  translationConcurrency?: string;
  translationConcurrencyPerModel?: string;
  judgeConcurrency?: string;
  forkFromRun?: string;
  rejudgeFromRun?: string;
  resume?: boolean;
  judge?: boolean;
}

function parseCsvOption(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function assertUniqueParticipantIds(participantIds: string[]): void {
  const seen = new Set<string>();

  for (const participantId of participantIds) {
    if (seen.has(participantId)) {
      throw new Error(`Duplicate participant id in --participants: ${participantId}`);
    }

    seen.add(participantId);
  }
}

export function buildProgram(): Command {
  return new Command()
    .name('korean-llm-context-translation-benchmark')
    .description('Translation benchmark harness with GEMBA-MQM judge backends')
    .version('3.0.0')
    .option('--benchmark-config <path>', 'Benchmark config JSON path', 'data/benchmarks/gemba-mqm-v1.json')
    .option('--participant-registry <path>', 'Participant registry JSON path')
    .option('--participants <ids>', 'Comma-separated participant ids for fresh runs')
    .option('--judge-backend <backend>', 'Judge backend: vertex or gemini-cli', 'vertex')
    .option('--judge-model <model>', 'Gemini model used for judging')
    .option('--gemini-cli-bin <path>', 'Gemini CLI binary for --judge-backend gemini-cli')
    .option('--run-id <id>', 'Stable run id for resumable artifacts')
    .option('--output <path>', 'Output root directory', 'output')
    .option('--limit <n>', 'Limit number of source sentences')
    .option('--delay <ms>', 'Delay between translation API calls', '0')
    .option('--translation-concurrency <n>', 'Deprecated alias for --translation-concurrency-per-model')
    .option('--translation-concurrency-per-model <n>', 'Max concurrent translation API calls per provider model')
    .option('--judge-concurrency <n>', 'Max concurrent judge API calls', '1')
    .option('--fork-from-run <runId>', 'Create a new run that reuses successful translations from an existing run')
    .option('--rejudge-from-run <runId>', 'Reuse translations from an existing run and execute judge only')
    .option('--resume', 'Resume from existing artifacts')
    .option('--no-judge', 'Skip the judge phase');
}

function getBenchmarkTestCaseId(testCase: BenchmarkTestCase): string {
  return isContextRuntimeSample(testCase) ? testCase.sampleId : String(testCase.id);
}

function parsePositiveIntegerOption(
  value: string | undefined,
  flag: '--limit' | '--translation-concurrency' | '--translation-concurrency-per-model' | '--judge-concurrency',
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} must be a positive integer`);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} must be a positive integer`);
  }

  return parsed;
}

function parseJudgeBackendOption(value: string | undefined): JudgeBackend {
  const backend = value ?? 'vertex';

  if (backend !== 'vertex' && backend !== 'gemini-cli') {
    throw new Error('--judge-backend must be vertex or gemini-cli');
  }

  return backend;
}

function parseOptionalNonBlankString(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value.trim().length === 0) {
    throw new Error(`${flag} must not be blank`);
  }

  return value;
}

function parseNonNegativeIntegerOption(
  value: string | undefined,
  flag: '--delay',
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a non-negative integer`);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} must be a non-negative integer`);
  }

  return parsed;
}

export function assertValidCliOptions(options: {
  resume?: boolean;
  runId?: string;
  limit?: string;
  delay?: string;
  judgeModel?: string;
  judgeBackend?: string;
  geminiCliBin?: string;
  judge?: boolean;
  participants?: string;
  participantRegistry?: string;
  translationConcurrency?: string;
  translationConcurrencyPerModel?: string;
  judgeConcurrency?: string;
  forkFromRun?: string;
  rejudgeFromRun?: string;
}): {
  limit?: number;
  delayMs: number;
  participantIds: string[];
  participantRegistryPath?: string;
  judgeBackend: JudgeBackend;
  geminiCliBin?: string;
  translationConcurrencyPerModel: number;
  judgeConcurrency: number;
} {
  if (options.resume && options.rejudgeFromRun) {
    throw new Error('--resume and --rejudge-from-run cannot be used together');
  }

  if (options.resume && options.forkFromRun) {
    throw new Error('--resume and --fork-from-run cannot be used together');
  }

  if (options.rejudgeFromRun && options.forkFromRun) {
    throw new Error('--fork-from-run and --rejudge-from-run cannot be used together');
  }

  if (options.resume && !options.runId) {
    throw new Error('--resume requires --run-id so the existing manifest can be validated');
  }

  if (options.rejudgeFromRun && !options.judgeModel) {
    throw new Error('--rejudge-from-run requires --judge-model');
  }

  if (options.rejudgeFromRun && options.judge === false) {
    throw new Error('--rejudge-from-run cannot be used with --no-judge');
  }

  if (!options.resume && !options.rejudgeFromRun && parseCsvOption(options.participants).length === 0) {
    throw new Error('--participants is required for fresh runs');
  }

  if (options.resume && options.participants) {
    throw new Error('--participants is not allowed with --resume');
  }

  if (options.rejudgeFromRun && options.participants) {
    throw new Error('--participants is not allowed with --rejudge-from-run');
  }

  if (options.resume && options.participantRegistry) {
    throw new Error('--participant-registry is not allowed with --resume');
  }

  if (options.rejudgeFromRun && options.participantRegistry) {
    throw new Error('--participant-registry is not allowed with --rejudge-from-run');
  }

  if (options.resume && options.limit !== undefined) {
    throw new Error('--limit is not allowed with --resume');
  }

  if (options.rejudgeFromRun && options.limit !== undefined) {
    throw new Error('--limit is not allowed with --rejudge-from-run');
  }

  if (options.translationConcurrency && options.translationConcurrencyPerModel) {
    throw new Error('Use either --translation-concurrency or --translation-concurrency-per-model, not both');
  }

  const translationConcurrencyValue = options.translationConcurrencyPerModel ?? options.translationConcurrency;
  const translationConcurrencyFlag = options.translationConcurrencyPerModel !== undefined
    ? '--translation-concurrency-per-model'
    : '--translation-concurrency';
  const participantIds = parseCsvOption(options.participants);

  assertUniqueParticipantIds(participantIds);

  return {
    limit: parsePositiveIntegerOption(options.limit, '--limit'),
    delayMs: parseNonNegativeIntegerOption(options.delay ?? '0', '--delay') ?? 0,
    participantIds,
    participantRegistryPath: options.participantRegistry,
    judgeBackend: parseJudgeBackendOption(options.judgeBackend),
    geminiCliBin: parseOptionalNonBlankString(options.geminiCliBin, '--gemini-cli-bin'),
    translationConcurrencyPerModel:
      parsePositiveIntegerOption(translationConcurrencyValue, translationConcurrencyFlag) ?? 1,
    judgeConcurrency: parsePositiveIntegerOption(options.judgeConcurrency ?? '1', '--judge-concurrency') ?? 1,
  };
}

export function createJudgeClient(params: {
  judgeBackend: JudgeBackend;
  judgeModel?: string;
  geminiCliBin?: string;
  env: Environment;
}): VertexGembaJudge | GeminiCliGembaJudge | null {
  if (!params.judgeModel) {
    return null;
  }

  if (params.judgeBackend === 'gemini-cli') {
    return new GeminiCliGembaJudge({
      model: params.judgeModel,
      cliBin: params.geminiCliBin ?? params.env.GEMINI_CLI_BIN,
    });
  }

  return new VertexGembaJudge(resolveVertexJudgeConfig(params.env, params.judgeModel));
}

export function finalizeCliRun(params: {
  judged: boolean;
  outputDir: string;
  runId: string;
  summary: TestSummary;
  runner: Pick<TestRunner, 'printSummary' | 'saveResults'>;
  log?: (message: string) => void;
}): void {
  const log = params.log ?? console.log;

  if (params.judged) {
    const runDir = path.join(params.outputDir, params.runId);

    log(`Benchmark artifacts saved under: ${runDir}`);
    log(`Benchmark reports saved under: ${path.join(runDir, 'reports')}`);
    return;
  }

  params.runner.printSummary(params.summary);
  const resultPath = params.runner.saveResults(params.summary, params.outputDir);
  log(`💾 Results saved to: ${resultPath}`);
}

export function estimateJudgeRequests(input: {
  maxCases: number;
  participantCount: number;
  targetLanguageCount: number;
  reusedTranslationCount?: number;
}): number {
  if (input.reusedTranslationCount !== undefined) {
    return input.reusedTranslationCount;
  }

  return input.maxCases * input.participantCount * input.targetLanguageCount;
}

export async function main(argv = process.argv): Promise<void> {
  clearRunManifestFingerprintDefaults();

  try {
    const program = buildProgram();
    program.parse(argv);

    const options = program.opts<CliOptions>();
    const validatedOptions = assertValidCliOptions(options);

    const benchmarkConfig = loadBenchmarkConfig(path.resolve(projectRoot, options.benchmarkConfig));
    const sharedPrompt = readFileSync(benchmarkConfig.sharedPromptFile, 'utf8').trim();
    const testCases = loadBenchmarkTestCases(benchmarkConfig);
    const datasetFingerprintSha256 = computeFileSha256(benchmarkConfig.dataFile);
    const promptFingerprintSha256 = computeFileSha256(benchmarkConfig.sharedPromptFile);
    setRunManifestFingerprintDefaults({
      datasetFingerprintSha256,
      promptFingerprintSha256,
    });

    const outputDir = path.resolve(projectRoot, options.output);
    const runId = options.runId ?? `run-${Date.now()}`;
    let effectiveRunId = runId;
    let forkFromRunId: string | undefined;
    let skipTranslationPhase = false;
    let reusedTranslationCount: number | undefined;
    let participants: ParticipantDefinition[];
    let limitApplied = validatedOptions.limit !== undefined
      ? Math.min(validatedOptions.limit, testCases.length)
      : testCases.length;

    if (options.rejudgeFromRun) {
      const rejudgeRun = prepareRejudgeRun({
        outputDir,
        sourceRunId: options.rejudgeFromRun,
        newRunId: runId,
        benchmarkId: benchmarkConfig.benchmarkId,
        datasetVersion: path.basename(benchmarkConfig.dataFile),
        datasetKind: benchmarkConfig.datasetKind,
        judgePromptSetId: benchmarkConfig.judgePromptSetId,
        datasetFingerprintSha256,
        targetLanguages: benchmarkConfig.targetLanguages,
        targetLanguageLabels: benchmarkConfig.targetLanguageLabels,
        judgePromptVersion: benchmarkConfig.judgePromptSetId,
        judgeModelId: options.judgeModel ?? 'gemini-3.1-pro-preview',
        judgeBackend: validatedOptions.judgeBackend,
        geminiCliBin: validatedOptions.geminiCliBin ?? process.env.GEMINI_CLI_BIN,
        vertexProject: process.env.GOOGLE_CLOUD_PROJECT ?? null,
        vertexRegion: process.env.GOOGLE_CLOUD_LOCATION ?? null,
        vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      });
      effectiveRunId = rejudgeRun.runId;
      skipTranslationPhase = true;
      reusedTranslationCount = rejudgeRun.translationCount;
      participants = rejudgeRun.participants;
      limitApplied = rejudgeRun.limitApplied;
    } else if (options.resume) {
      const existingManifest = loadRunManifest(outputDir, runId, 'resume');
      participants = existingManifest.participants;
      limitApplied = existingManifest.limitApplied;
      forkFromRunId = existingManifest.forkFromRunId;
    } else {
      const registry = loadParticipantRegistry(
        path.resolve(projectRoot, validatedOptions.participantRegistryPath ?? defaultParticipantRegistryPath),
      );
      participants = resolveSelectedParticipants(registry, validatedOptions.participantIds);

      if (options.forkFromRun) {
        const forkRun = prepareForkRun({
          outputDir,
          sourceRunId: options.forkFromRun,
          newRunId: runId,
          benchmarkId: benchmarkConfig.benchmarkId,
          datasetVersion: path.basename(benchmarkConfig.dataFile),
          datasetKind: benchmarkConfig.datasetKind,
          datasetFingerprintSha256,
          promptVersion: path.basename(benchmarkConfig.sharedPromptFile),
          promptFingerprintSha256,
          judgePromptVersion: benchmarkConfig.judgePromptSetId,
          judgePromptSetId: benchmarkConfig.judgePromptSetId,
          targetLanguages: benchmarkConfig.targetLanguages,
          targetLanguageLabels: benchmarkConfig.targetLanguageLabels,
          judgeModelId: options.judgeModel ?? null,
          judgeBackend: validatedOptions.judgeBackend,
          geminiCliBin: validatedOptions.geminiCliBin ?? process.env.GEMINI_CLI_BIN,
          vertexProject: process.env.GOOGLE_CLOUD_PROJECT ?? null,
          vertexRegion: process.env.GOOGLE_CLOUD_LOCATION ?? null,
          vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
          translationConcurrencyPerModel: validatedOptions.translationConcurrencyPerModel,
          limitApplied,
          allowedSourceIds: testCases.slice(0, limitApplied).map(getBenchmarkTestCaseId),
          participants,
        });
        effectiveRunId = forkRun.runId;
        forkFromRunId = options.forkFromRun;
        participants = forkRun.participants;
        limitApplied = forkRun.limitApplied;
      }
    }

    const conditions = buildConditionsFromParticipants({
      benchmarkConfig,
      sharedPrompt,
      testCases,
      env: process.env,
      participants,
    });

    const judge = options.judge !== false
      ? createJudgeClient({
        judgeBackend: validatedOptions.judgeBackend,
        judgeModel: options.judgeModel,
        geminiCliBin: validatedOptions.geminiCliBin,
        env: process.env,
      })
      : null;

    const estimatedJudgeRequests = estimateJudgeRequests({
      maxCases: limitApplied,
      participantCount: conditions.length,
      targetLanguageCount: benchmarkConfig.targetLanguages.length,
      reusedTranslationCount,
    });

    console.log(`Estimated judge requests: ${estimatedJudgeRequests}`);

    const runner = new TestRunner(benchmarkConfig, conditions, judge, {
      benchmarkId: benchmarkConfig.benchmarkId,
      promptVersion: path.basename(benchmarkConfig.sharedPromptFile),
      judgePromptVersion: benchmarkConfig.judgePromptSetId,
      outputDir,
      runId: effectiveRunId,
      forkFromRunId,
      delayMs: validatedOptions.delayMs,
      limit: limitApplied,
      limitApplied,
      resume: options.resume === true || options.rejudgeFromRun !== undefined || options.forkFromRun !== undefined,
      judgeModelId: options.judgeModel,
      judgeBackend: validatedOptions.judgeBackend,
      geminiCliBin: validatedOptions.geminiCliBin ?? process.env.GEMINI_CLI_BIN,
      participants,
      translationConcurrency: validatedOptions.translationConcurrencyPerModel,
      translationConcurrencyPerModel: validatedOptions.translationConcurrencyPerModel,
      judgeConcurrency: validatedOptions.judgeConcurrency,
      skipTranslationPhase,
    });

    const summary = await runner.run();
    finalizeCliRun({
      judged: judge !== null,
      outputDir,
      runId: effectiveRunId,
      summary,
      runner,
    });
  } finally {
    clearRunManifestFingerprintDefaults();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
