import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TargetLanguageCode } from './benchmark-types.js';
import type { NormalizedClientErrorClass, Provider } from './llm-client.js';
import type { ParticipantDefinition } from './participant-registry.js';

export const RUN_MANIFEST_VERSION = 3;

export type JudgeBackend = 'vertex' | 'gemini-cli' | 'openrouter-batch';

export interface RunLayout {
  runDir: string;
  manifestPath: string;
  translationJsonlPath: string;
  translationFailuresJsonlPath: string;
  translationMetricsJsonlPath: string;
  translationEventsJsonlPath: string;
  rawJudgeJsonlPath: string;
  normalizedJudgeJsonlPath: string;
  judgeMetricsJsonlPath: string;
  judgeEventsJsonlPath: string;
  failuresJsonlPath: string;
  runStatePath: string;
  reportsDir: string;
}

export interface RunManifestV3 {
  manifestVersion: typeof RUN_MANIFEST_VERSION;
  runId: string;
  benchmarkId: string;
  datasetVersion: string;
  datasetKind: 'sentence' | 'context';
  datasetFingerprintSha256: string;
  promptVersion: string;
  promptFingerprintSha256: string;
  judgePromptVersion: string;
  judgePromptSetId: string;
  judgeBackend: JudgeBackend;
  judgeModelId: string | null;
  targetLanguages: TargetLanguageCode[];
  targetLanguageLabels: Partial<Record<TargetLanguageCode, string>>;
  limitApplied: number;
  participants: ParticipantDefinition[];
  translationConcurrencyPerModel: number;
  resume: boolean;
  forkFromRunId?: string;
  rejudgeFromRunId?: string;
  reusedTranslations?: boolean;
  forkPromptMismatchAllowed?: boolean;
  vertexProject?: string | null;
  vertexRegion?: string | null;
  geminiCliBin?: string;
  vendoredGembaCommit?: string;
  openRouterBatchJobIds?: string[];
  openRouterBatchApiBaseUrl?: string;
  openRouterBatchModelId?: string;
}

export interface TranslationFailureArtifactRecord {
  recorded_at: string;
  stable_key: string;
  participant_id: string;
  participant_model_id: string;
  provider: Provider;
  source_id: string;
  source_lang: string;
  target_language: TargetLanguageCode;
  final_disposition: 'retry_exhausted' | 'terminal_deterministic';
  error_class: NormalizedClientErrorClass;
  attempts_used: number;
  last_error_summary: string;
}

export type RunManifestV3Input = Omit<RunManifestV3,
  'manifestVersion'
  | 'datasetFingerprintSha256'
  | 'promptFingerprintSha256'
  | 'datasetKind'
  | 'judgePromptSetId'
  | 'judgeBackend'
> & {
  manifestVersion?: number;
  datasetFingerprintSha256?: string;
  promptFingerprintSha256?: string;
  datasetKind?: RunManifestV3['datasetKind'];
  judgePromptSetId?: string;
  judgeBackend?: JudgeBackend;
};

type ManifestFingerprintDefaults = Partial<Pick<RunManifestV3, 'datasetFingerprintSha256' | 'promptFingerprintSha256'>>;

let manifestFingerprintDefaults: ManifestFingerprintDefaults = {};

function hasExistingRunArtifacts(layout: RunLayout): boolean {
  return fs.existsSync(layout.manifestPath)
    || fs.existsSync(layout.translationJsonlPath)
    || fs.existsSync(layout.translationFailuresJsonlPath)
    || fs.existsSync(layout.translationMetricsJsonlPath)
    || fs.existsSync(layout.translationEventsJsonlPath)
    || fs.existsSync(layout.rawJudgeJsonlPath)
    || fs.existsSync(layout.normalizedJudgeJsonlPath)
    || fs.existsSync(layout.judgeMetricsJsonlPath)
    || fs.existsSync(layout.judgeEventsJsonlPath)
    || fs.existsSync(layout.failuresJsonlPath)
    || fs.existsSync(layout.runStatePath)
    || fs.existsSync(layout.reportsDir);
}

function ensureJsonlFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Run manifest must define ${fieldName} as a non-empty string`);
  }

  return value;
}

function requireDatasetKind(value: unknown, fieldName: string = 'datasetKind'): RunManifestV3['datasetKind'] {
  if (value !== 'sentence' && value !== 'context') {
    throw new Error(`Run manifest must define ${fieldName} as "sentence" or "context"`);
  }

  return value;
}

function requireJudgeBackend(value: unknown, fieldName: string = 'judgeBackend'): JudgeBackend {
  if (value !== 'vertex' && value !== 'gemini-cli' && value !== 'openrouter-batch') {
    throw new Error(`Run manifest must define ${fieldName} as "vertex", "gemini-cli", or "openrouter-batch"`);
  }

  return value;
}

function requireOptionalStringOrNull(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  return requireString(value, fieldName);
}

function requireBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Run manifest must define ${fieldName} as a boolean`);
  }

  return value;
}

function requireNonNegativeInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Run manifest must define ${fieldName} as a non-negative integer`);
  }

  return value;
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Run manifest must define ${fieldName} as a positive integer`);
  }

  return value;
}

function requireTargetLanguages(value: unknown): TargetLanguageCode[] {
  if (!Array.isArray(value)) {
    throw new Error('Run manifest must define targetLanguages as an array');
  }

  return value.map((item, index) => requireString(item, `targetLanguages[${index}]`) as TargetLanguageCode);
}

function requireTargetLanguageLabels(value: unknown): Partial<Record<TargetLanguageCode, string>> {
  if (!isRecord(value)) {
    throw new Error('Run manifest must define targetLanguageLabels as an object');
  }

  const labels: Partial<Record<TargetLanguageCode, string>> = {};

  for (const [key, label] of Object.entries(value)) {
    labels[key as TargetLanguageCode] = requireString(label, `targetLanguageLabels.${key}`);
  }

  return labels;
}

function requireParticipants(value: unknown): ParticipantDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error('Run manifest must define participants as an array');
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Run manifest participants[${index}] must be an object`);
    }

    const promptFile = item.promptFile === undefined
      ? undefined
      : requireString(item.promptFile, `participants[${index}].promptFile`);
    const promptFingerprintSha256 = requireOptionalSha256Fingerprint(
      item.promptFingerprintSha256,
      `participants[${index}].promptFingerprintSha256`,
    );
    const messageLayout = requireOptionalMessageLayout(item.messageLayout, `participants[${index}].messageLayout`);
    const llamaCppServerUrl = requireOptionalString(item.llamaCppServerUrl, `participants[${index}].llamaCppServerUrl`);
    const llamaCppMode = requireOptionalLlamaCppMode(item.llamaCppMode, `participants[${index}].llamaCppMode`);
    if (promptFile !== undefined && promptFingerprintSha256 === undefined) {
      throw new Error(`Run manifest must define participants[${index}].promptFingerprintSha256 when participants[${index}].promptFile is present`);
    }
    if (promptFile === undefined && promptFingerprintSha256 !== undefined) {
      throw new Error(`Run manifest must define participants[${index}].promptFile when participants[${index}].promptFingerprintSha256 is present`);
    }

    const provider = requireString(item.provider, `participants[${index}].provider`) as ParticipantDefinition['provider'];
    if (provider === 'llamacpp' && llamaCppServerUrl === undefined) {
      throw new Error(`Run manifest must define participants[${index}].llamaCppServerUrl when provider is llamacpp`);
    }

    return {
      participantId: requireString(item.participantId, `participants[${index}].participantId`),
      displayName: requireString(item.displayName, `participants[${index}].displayName`),
      provider,
      providerModelId: requireString(item.providerModelId, `participants[${index}].providerModelId`),
      ...(messageLayout ? { messageLayout } : {}),
      ...(promptFile ? { promptFile } : {}),
      ...(promptFingerprintSha256 ? { promptFingerprintSha256 } : {}),
      ...(llamaCppServerUrl ? { llamaCppServerUrl } : {}),
      ...(llamaCppMode ? { llamaCppMode } : {}),
    };
  });
}

function requireOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireString(value, fieldName);
}

function requireOptionalLlamaCppMode(value: unknown, fieldName: string): ParticipantDefinition['llamaCppMode'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const mode = requireString(value, fieldName);
  if (mode !== 'chat' && mode !== 'completion') {
    throw new Error(`Run manifest must define ${fieldName} as "chat" or "completion" when provided`);
  }

  return mode;
}

function requireOptionalMessageLayout(value: unknown, fieldName: string): ParticipantDefinition['messageLayout'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const messageLayout = requireString(value, fieldName);
  if (messageLayout !== 'system-context') {
    throw new Error(`Run manifest must define ${fieldName} as "system-context" when provided`);
  }

  return messageLayout;
}

function requireSha256Fingerprint(
  value: unknown,
  fieldName: string,
  fallbackValue?: string,
): string {
  const resolvedValue = value ?? fallbackValue;

  if (typeof resolvedValue !== 'string' || !/^[a-f0-9]{64}$/i.test(resolvedValue)) {
    throw new Error(`Run manifest must define ${fieldName} as a 64-character SHA-256 hex string`);
  }

  return resolvedValue.toLowerCase();
}

function requireOptionalSha256Fingerprint(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireSha256Fingerprint(value, fieldName);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRejudgeResumeManifest(manifest: RunManifestV3): boolean {
  return manifest.reusedTranslations === true || manifest.rejudgeFromRunId !== undefined;
}

function extractFingerprintDefaults(manifest: unknown): ManifestFingerprintDefaults {
  if (!isRecord(manifest)) {
    return {};
  }

  return {
    datasetFingerprintSha256:
      typeof manifest.datasetFingerprintSha256 === 'string' ? manifest.datasetFingerprintSha256 : undefined,
    promptFingerprintSha256:
      typeof manifest.promptFingerprintSha256 === 'string' ? manifest.promptFingerprintSha256 : undefined,
  };
}

/**
 * Resume compatibility for participants: the requested (subset) participants
 * must each EXACTLY match their manifest snapshot. The manifest may contain
 * more participants than the requested subset — that is how sequential
 * one-model-at-a-time passes resume without touching other rows.
 */
function participantsCompatibleForResume(existing: RunManifestV3, manifest: RunManifestV3): boolean {
  const existingById = new Map(existing.participants.map((participant) => [participant.participantId, participant]));

  return manifest.participants.every((participant) => {
    const existingParticipant = existingById.get(participant.participantId);
    return existingParticipant !== undefined && sameJsonValue(existingParticipant, participant);
  });
}

function isCompatibleResumeManifest(existing: RunManifestV3, manifest: RunManifestV3): boolean {
  const judgeModelCompatible = existing.judgeModelId === manifest.judgeModelId
    || existing.judgeModelId === null
    || manifest.judgeModelId === null;

  const baseCompatible = existing.benchmarkId === manifest.benchmarkId
    && existing.datasetVersion === manifest.datasetVersion
    && existing.datasetKind === manifest.datasetKind
    && existing.datasetFingerprintSha256 === manifest.datasetFingerprintSha256
    && existing.judgePromptVersion === manifest.judgePromptVersion
    && existing.judgePromptSetId === manifest.judgePromptSetId
    && existing.judgeBackend === manifest.judgeBackend
    && judgeModelCompatible
    && sameJsonValue(existing.targetLanguages, manifest.targetLanguages)
    && sameJsonValue(existing.targetLanguageLabels, manifest.targetLanguageLabels)
    && existing.limitApplied === manifest.limitApplied
    && participantsCompatibleForResume(existing, manifest)
    && sameJsonValue(existing.forkFromRunId, manifest.forkFromRunId);

  if (isRejudgeResumeManifest(existing)) {
    return baseCompatible;
  }

  return baseCompatible
    && existing.promptVersion === manifest.promptVersion
    && existing.promptFingerprintSha256 === manifest.promptFingerprintSha256
    && sameJsonValue(existing.rejudgeFromRunId, manifest.rejudgeFromRunId)
    && sameJsonValue(existing.reusedTranslations ?? false, manifest.reusedTranslations ?? false);
}

export function computeFileSha256(filePath: string): string {
  return createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

export function setRunManifestFingerprintDefaults(defaults: ManifestFingerprintDefaults): void {
  manifestFingerprintDefaults = {
    ...manifestFingerprintDefaults,
    ...defaults,
  };
}

export function clearRunManifestFingerprintDefaults(): void {
  manifestFingerprintDefaults = {};
}

export function parseRunManifestV3(
  manifest: unknown,
  continuationMode?: 'resume' | 'rejudge' | 'fork',
  fingerprintDefaults: ManifestFingerprintDefaults = {},
): RunManifestV3 {
  if (!isRecord(manifest)) {
    throw new Error('Run manifest must be an object');
  }

  if (manifest.manifestVersion !== RUN_MANIFEST_VERSION) {
    if (continuationMode) {
      const versionDescription = typeof manifest.manifestVersion === 'number'
        ? `v${manifest.manifestVersion}`
        : 'an unversioned manifest';

      if (typeof manifest.manifestVersion !== 'number' || manifest.manifestVersion < RUN_MANIFEST_VERSION) {
        throw new Error(
          `Pre-v${RUN_MANIFEST_VERSION} runs are unsupported for ${continuationMode} because ${versionDescription} predates required content fingerprints`,
        );
      }

      throw new Error(
        `Run manifest version ${String(manifest.manifestVersion)} is unsupported for ${continuationMode}; expected v${RUN_MANIFEST_VERSION}`,
      );
    }

    throw new Error(`Run manifest must define manifestVersion: ${RUN_MANIFEST_VERSION}`);
  }

  if (!Array.isArray(manifest.participants)) {
    if (continuationMode) {
      throw new Error(`Pre-v${RUN_MANIFEST_VERSION} runs are unsupported for ${continuationMode} because the manifest participant snapshot is missing`);
    }

    throw new Error('Run manifest must define a participant snapshot');
  }

  const judgeModelId = requireOptionalStringOrNull(manifest.judgeModelId, 'judgeModelId');
  const vertexProject = requireOptionalStringOrNull(manifest.vertexProject, 'vertexProject');
  const vertexRegion = requireOptionalStringOrNull(manifest.vertexRegion, 'vertexRegion');
  const geminiCliBin = requireOptionalStringOrNull(manifest.geminiCliBin, 'geminiCliBin');
  const vendoredGembaCommit = requireOptionalStringOrNull(manifest.vendoredGembaCommit, 'vendoredGembaCommit');
  const openRouterBatchJobIds = requireOptionalStringArray(manifest.openRouterBatchJobIds, 'openRouterBatchJobIds');
  const openRouterBatchApiBaseUrl = requireOptionalStringOrNull(manifest.openRouterBatchApiBaseUrl, 'openRouterBatchApiBaseUrl');
  const openRouterBatchModelId = requireOptionalStringOrNull(manifest.openRouterBatchModelId, 'openRouterBatchModelId');
  const forkFromRunId = requireOptionalStringOrNull(manifest.forkFromRunId, 'forkFromRunId');
  const rejudgeFromRunId = requireOptionalStringOrNull(manifest.rejudgeFromRunId, 'rejudgeFromRunId');
  const judgePromptVersion = requireString(manifest.judgePromptVersion, 'judgePromptVersion');
  const datasetKind = manifest.datasetKind === undefined ? 'sentence' : requireDatasetKind(manifest.datasetKind);
  const judgePromptSetId = manifest.judgePromptSetId === undefined
    ? judgePromptVersion
    : requireString(manifest.judgePromptSetId, 'judgePromptSetId');
  const judgeBackend = manifest.judgeBackend === undefined ? 'vertex' : requireJudgeBackend(manifest.judgeBackend);
  const reusedTranslations = manifest.reusedTranslations === undefined
    ? undefined
    : requireBoolean(manifest.reusedTranslations, 'reusedTranslations');
  const forkPromptMismatchAllowed = manifest.forkPromptMismatchAllowed === undefined
    ? undefined
    : requireBoolean(manifest.forkPromptMismatchAllowed, 'forkPromptMismatchAllowed');

  return {
    manifestVersion: RUN_MANIFEST_VERSION,
    runId: requireString(manifest.runId, 'runId'),
    benchmarkId: requireString(manifest.benchmarkId, 'benchmarkId'),
    datasetVersion: requireString(manifest.datasetVersion, 'datasetVersion'),
    datasetKind,
    datasetFingerprintSha256: requireSha256Fingerprint(
      manifest.datasetFingerprintSha256,
      'datasetFingerprintSha256',
      fingerprintDefaults.datasetFingerprintSha256,
    ),
    promptVersion: requireString(manifest.promptVersion, 'promptVersion'),
    promptFingerprintSha256: requireSha256Fingerprint(
      manifest.promptFingerprintSha256,
      'promptFingerprintSha256',
      fingerprintDefaults.promptFingerprintSha256,
    ),
    judgePromptVersion,
    judgePromptSetId,
    judgeBackend,
    judgeModelId: judgeModelId ?? null,
    targetLanguages: requireTargetLanguages(manifest.targetLanguages),
    targetLanguageLabels: requireTargetLanguageLabels(manifest.targetLanguageLabels),
    limitApplied: requireNonNegativeInteger(manifest.limitApplied, 'limitApplied'),
    participants: requireParticipants(manifest.participants),
    translationConcurrencyPerModel: requirePositiveInteger(
      manifest.translationConcurrencyPerModel,
      'translationConcurrencyPerModel',
    ),
    resume: requireBoolean(manifest.resume, 'resume'),
    forkFromRunId: forkFromRunId === null ? undefined : forkFromRunId,
    rejudgeFromRunId: rejudgeFromRunId === null ? undefined : rejudgeFromRunId,
    reusedTranslations,
    ...(forkPromptMismatchAllowed === undefined ? {} : { forkPromptMismatchAllowed }),
    vertexProject: vertexProject === undefined ? undefined : vertexProject,
    vertexRegion: vertexRegion === undefined ? undefined : vertexRegion,
    geminiCliBin: geminiCliBin === null || geminiCliBin === undefined ? undefined : geminiCliBin,
    vendoredGembaCommit: vendoredGembaCommit === null || vendoredGembaCommit === undefined
      ? undefined
      : vendoredGembaCommit,
    ...(openRouterBatchJobIds ? { openRouterBatchJobIds } : {}),
    ...(openRouterBatchApiBaseUrl === undefined || openRouterBatchApiBaseUrl === null
      ? {}
      : { openRouterBatchApiBaseUrl }),
    ...(openRouterBatchModelId === undefined || openRouterBatchModelId === null
      ? {}
      : { openRouterBatchModelId }),
  };
}

function requireOptionalStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Run manifest must define ${fieldName} as an array of strings when provided`);
  }

  return value.map((item, index) => requireString(item, `${fieldName}[${index}]`));
}

/**
 * Patch the persisted run manifest (used for batch job identity updates).
 * Written atomically (temp file + rename) so a crash cannot leave a truncated
 * manifest that would break resume.
 */
export function updateRunManifest(layout: RunLayout, patch: Partial<RunManifestV3>): void {
  const existing = JSON.parse(fs.readFileSync(layout.manifestPath, 'utf8')) as Record<string, unknown>;
  const nextContent = `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`;
  const tmpPath = `${layout.manifestPath}.tmp`;
  fs.writeFileSync(tmpPath, nextContent);
  fs.renameSync(tmpPath, layout.manifestPath);
}

export function loadRunManifest(
  outputRoot: string,
  runId: string,
  continuationMode: 'resume' | 'rejudge' | 'fork',
): RunManifestV3 {
  const manifestPath = path.join(outputRoot, runId, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    if (continuationMode === 'resume') {
      throw new Error('Cannot resume because the requested run manifest does not exist');
    }

    if (continuationMode === 'fork') {
      throw new Error('Cannot fork because the source run manifest does not exist');
    }

    throw new Error('Cannot rejudge because the source run manifest does not exist');
  }

  return parseRunManifestV3(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), continuationMode);
}

export function createRunLayout(outputRoot: string, manifest: RunManifestV3Input): RunLayout {
  const rawRunId = typeof manifest.runId === 'string' ? manifest.runId : String(manifest.runId ?? '');
  const runDir = path.join(outputRoot, rawRunId);
  const reportsDir = path.join(runDir, 'reports');

  const layout: RunLayout = {
    runDir,
    manifestPath: path.join(runDir, 'manifest.json'),
    translationJsonlPath: path.join(runDir, 'translations.jsonl'),
    translationFailuresJsonlPath: path.join(runDir, 'translation-failures.jsonl'),
    translationMetricsJsonlPath: path.join(runDir, 'translation-metrics.jsonl'),
    translationEventsJsonlPath: path.join(runDir, 'translation-events.jsonl'),
    rawJudgeJsonlPath: path.join(runDir, 'judge-raw.jsonl'),
    normalizedJudgeJsonlPath: path.join(runDir, 'judge-normalized.jsonl'),
    judgeMetricsJsonlPath: path.join(runDir, 'judge-metrics.jsonl'),
    judgeEventsJsonlPath: path.join(runDir, 'judge-events.jsonl'),
    failuresJsonlPath: path.join(runDir, 'judge-failures.jsonl'),
    runStatePath: path.join(runDir, 'run-state.json'),
    reportsDir,
  };

  const existingManifestRaw = fs.existsSync(layout.manifestPath)
    ? JSON.parse(fs.readFileSync(layout.manifestPath, 'utf8'))
    : undefined;
  const fallbackFingerprints = {
    ...extractFingerprintDefaults(existingManifestRaw),
    ...manifestFingerprintDefaults,
  };
  const normalizedManifest = parseRunManifestV3(
    {
      ...manifest,
      manifestVersion: RUN_MANIFEST_VERSION,
    },
    undefined,
    fallbackFingerprints,
  );

  if (!normalizedManifest.resume && hasExistingRunArtifacts(layout)) {
    throw new Error('Cannot start a fresh run because artifacts already exist for this runId');
  }

  fs.mkdirSync(reportsDir, { recursive: true });

  const manifestExists = existingManifestRaw !== undefined;

  if (normalizedManifest.resume && !manifestExists) {
    throw new Error('Cannot resume because the requested run manifest does not exist');
  }

  if (normalizedManifest.resume && manifestExists) {
    const existing = parseRunManifestV3(existingManifestRaw, 'resume');

    if (!isCompatibleResumeManifest(existing, normalizedManifest)) {
      throw new Error('Existing manifest does not match the requested resume configuration');
    }
  } else {
    fs.writeFileSync(layout.manifestPath, `${JSON.stringify(normalizedManifest, null, 2)}\n`);
  }

  ensureJsonlFile(layout.translationJsonlPath);
  ensureJsonlFile(layout.translationFailuresJsonlPath);
  ensureJsonlFile(layout.translationMetricsJsonlPath);
  ensureJsonlFile(layout.translationEventsJsonlPath);
  ensureJsonlFile(layout.rawJudgeJsonlPath);
  ensureJsonlFile(layout.normalizedJudgeJsonlPath);
  ensureJsonlFile(layout.judgeMetricsJsonlPath);
  ensureJsonlFile(layout.judgeEventsJsonlPath);
  ensureJsonlFile(layout.failuresJsonlPath);

  return layout;
}

export function writeJsonlRecord(filePath: string, record: Record<string, unknown>): void {
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

export function readJsonlRecords<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');

  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function hasJsonlRecord(filePath: string, stableKey: string): boolean {
  return readJsonlRecords<{ stable_key?: unknown }>(filePath)
    .some((record) => record.stable_key === stableKey);
}

export function getUnresolvedTranslationFailureRecords(
  translations: Array<{ stable_key: string }>,
  failures: TranslationFailureArtifactRecord[],
): TranslationFailureArtifactRecord[] {
  const successfulStableKeys = new Set(translations.map((record) => record.stable_key));
  const latestFailuresByStableKey = new Map<string, TranslationFailureArtifactRecord>();

  for (const failure of failures) {
    const existing = latestFailuresByStableKey.get(failure.stable_key);
    if (!existing || existing.recorded_at <= failure.recorded_at) {
      latestFailuresByStableKey.set(failure.stable_key, failure);
    }
  }

  return Array.from(latestFailuresByStableKey.values())
    .filter((failure) => !successfulStableKeys.has(failure.stable_key))
    .sort((left, right) => {
      if (left.recorded_at === right.recorded_at) {
        return left.stable_key.localeCompare(right.stable_key);
      }

      return left.recorded_at.localeCompare(right.recorded_at);
    });
}
