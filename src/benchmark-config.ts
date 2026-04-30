import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TargetLanguageCode } from './benchmark-types.js';

type RawBenchmarkConfig = {
  benchmarkId?: unknown;
  pilotOf?: unknown;
  description?: unknown;
  sharedPromptFile?: unknown;
  dataFile?: unknown;
  targetLanguages?: unknown;
  targetLanguageLabels?: unknown;
  datasetKind?: unknown;
  judgePromptSetId?: unknown;
};

export interface BenchmarkConfig {
  benchmarkId: string;
  pilotOf?: string;
  description: string;
  sharedPromptFile: string;
  dataFile: string;
  targetLanguages: TargetLanguageCode[];
  targetLanguageLabels: Partial<Record<TargetLanguageCode, string>>;
  datasetKind: 'sentence' | 'context';
  judgePromptSetId: string;
}

function requireDatasetKind(value: unknown): BenchmarkConfig['datasetKind'] {
  if (value !== 'sentence' && value !== 'context') {
    throw new Error('Benchmark config datasetKind must be "sentence" or "context".');
  }

  return value;
}

export function loadBenchmarkConfig(urlOrPath: URL | string): BenchmarkConfig {
  const configPath = toConfigPath(urlOrPath);
  const configDir = dirname(configPath);
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as RawBenchmarkConfig;
  const benchmarkId = requireString(raw.benchmarkId, 'benchmarkId');
  const pilotOf = raw.pilotOf === undefined ? undefined : requireString(raw.pilotOf, 'pilotOf');
  const description = requireString(raw.description, 'description');
  const sharedPromptFile = requireString(raw.sharedPromptFile, 'sharedPromptFile');
  const dataFile = requireString(raw.dataFile, 'dataFile');
  const targetLanguages = requireTargetLanguages(raw.targetLanguages);
  const targetLanguageLabels = requireTargetLanguageLabels(raw.targetLanguageLabels);
  const datasetKind = raw.datasetKind === undefined ? 'sentence' : requireDatasetKind(raw.datasetKind);
  const judgePromptSetId = raw.judgePromptSetId === undefined
    ? datasetKind === 'context'
      ? 'gemba-mqm-context-v1'
      : 'gemba-mqm-v1'
    : requireNonBlankString(raw.judgePromptSetId, 'judgePromptSetId');

  if (pilotOf !== undefined && targetLanguages.length !== 1) {
    throw new Error('Pilot benchmark config must target exactly one language.');
  }

  return {
    benchmarkId,
    pilotOf,
    description,
    sharedPromptFile: resolve(configDir, sharedPromptFile),
    dataFile: resolve(configDir, dataFile),
    targetLanguages,
    targetLanguageLabels,
    datasetKind,
    judgePromptSetId,
  };
}

function toConfigPath(urlOrPath: URL | string): string {
  if (urlOrPath instanceof URL) {
    return fileURLToPath(urlOrPath);
  }

  return resolve(urlOrPath);
}

function requireTargetLanguages(targetLanguages: RawBenchmarkConfig['targetLanguages']): TargetLanguageCode[] {
  if (!Array.isArray(targetLanguages) || targetLanguages.length === 0) {
    throw new Error('Benchmark config must define at least one target language.');
  }

  return targetLanguages.map((targetLanguage) => {
    if (!isTargetLanguageCode(targetLanguage)) {
      throw new Error(`Unsupported target language: ${String(targetLanguage)}`);
    }

    return targetLanguage;
  });
}

function requireTargetLanguageLabels(value: RawBenchmarkConfig['targetLanguageLabels']): Partial<Record<TargetLanguageCode, string>> {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new Error('Benchmark config targetLanguageLabels must be an object.');
  }

  const labels: Partial<Record<TargetLanguageCode, string>> = {};

  for (const [key, label] of Object.entries(value)) {
    if (!isTargetLanguageCode(key)) {
      throw new Error(`Unsupported target language label key: ${key}`);
    }

    labels[key] = requireString(label, `targetLanguageLabels.${key}`);
  }

  return labels;
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Benchmark config must define ${fieldName}.`);
  }

  return value;
}

function requireNonBlankString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Benchmark config must define ${fieldName}.`);
  }

  return value;
}

function isTargetLanguageCode(value: unknown): value is TargetLanguageCode {
  return value === 'en' || value === 'ja' || value === 'zh-Hans';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
