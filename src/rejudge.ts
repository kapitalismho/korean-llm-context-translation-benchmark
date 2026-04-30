import * as path from 'node:path';

import type { TargetLanguageCode } from './benchmark-types.js';
import { buildStableKey } from './benchmark-types.js';
import {
  createRunLayout,
  getUnresolvedTranslationFailureRecords,
  loadRunManifest,
  readJsonlRecords,
  type JudgeBackend,
  type TranslationFailureArtifactRecord,
  writeJsonlRecord,
} from './run-artifacts.js';
import type { TranslationArtifactRecord } from './runner.js';

export interface ReusedTranslationArtifactRecord extends TranslationArtifactRecord {
  source_run_id: string;
  source_stable_key: string;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getExpectedSourceTranslationCount(input: {
  limitApplied: number;
  targetLanguages: TargetLanguageCode[];
  participants: Array<{ participantId: string }>;
}): number {
  return input.limitApplied * input.targetLanguages.length * input.participants.length;
}

export function rewriteTranslationRecordForRun(
  record: TranslationArtifactRecord,
  newRunId: string,
  sourceRunId: string,
): ReusedTranslationArtifactRecord {
  return {
    ...record,
    stable_key: buildStableKey(newRunId, record.source_id, record.target_language, record.participant_id),
    source_run_id: sourceRunId,
    source_stable_key: record.stable_key,
  };
}

export function prepareRejudgeRun(input: {
  outputDir: string;
  sourceRunId: string;
  newRunId: string;
  benchmarkId: string;
  datasetVersion: string;
  datasetKind: 'sentence' | 'context';
  judgePromptSetId: string;
  datasetFingerprintSha256: string;
  targetLanguages: TargetLanguageCode[];
  targetLanguageLabels: Partial<Record<TargetLanguageCode, string>>;
  judgePromptVersion: string;
  judgeModelId: string;
  judgeBackend?: JudgeBackend;
  geminiCliBin?: string;
  vertexProject: string | null;
  vertexRegion: string | null;
  vendoredGembaCommit: string;
}) {
  const sourceManifest = loadRunManifest(input.outputDir, input.sourceRunId, 'rejudge');

  if (sourceManifest.benchmarkId !== input.benchmarkId) {
    throw new Error('Source run benchmarkId does not match the requested rejudge configuration');
  }

  if (sourceManifest.datasetVersion !== input.datasetVersion) {
    throw new Error('Source run datasetVersion does not match the requested rejudge configuration');
  }

  if (sourceManifest.datasetKind !== input.datasetKind) {
    throw new Error('Source run datasetKind does not match the requested rejudge configuration');
  }

  if (sourceManifest.judgePromptSetId !== input.judgePromptSetId) {
    throw new Error('Source run judgePromptSetId does not match the requested rejudge configuration');
  }

  if (sourceManifest.datasetFingerprintSha256 !== input.datasetFingerprintSha256) {
    throw new Error('Source run dataset fingerprint does not match the requested rejudge configuration');
  }

  if (!sameJsonValue(sourceManifest.targetLanguages, input.targetLanguages)) {
    throw new Error('Source run targetLanguages do not match the requested rejudge configuration');
  }

  if (!sameJsonValue(sourceManifest.targetLanguageLabels, input.targetLanguageLabels)) {
    throw new Error('Source run targetLanguageLabels do not match the requested rejudge configuration');
  }

  const sourceRunDir = path.join(input.outputDir, input.sourceRunId);
  const sourceTranslations = readJsonlRecords<TranslationArtifactRecord>(path.join(sourceRunDir, 'translations.jsonl'));
  const sourceTranslationFailures = readJsonlRecords<TranslationFailureArtifactRecord>(
    path.join(sourceRunDir, 'translation-failures.jsonl'),
  );
  const unresolvedTranslationFailures = getUnresolvedTranslationFailureRecords(
    sourceTranslations,
    sourceTranslationFailures,
  );

  if (unresolvedTranslationFailures.length > 0) {
    throw new Error('Cannot rejudge because the source run still has unresolved translation failures');
  }

  const sourceTranslationStableKeys = new Set(sourceTranslations.map((record) => record.stable_key));
  const expectedTranslationCount = getExpectedSourceTranslationCount({
    limitApplied: sourceManifest.limitApplied,
    targetLanguages: sourceManifest.targetLanguages,
    participants: sourceManifest.participants,
  });

  if (sourceTranslationStableKeys.size !== expectedTranslationCount) {
    // Rejudge admission still comes from source-run translation coverage truth, not from the current registry.
    throw new Error('Cannot rejudge because the source run translation success coverage does not match the expected translation count');
  }

  const layout = createRunLayout(input.outputDir, {
    manifestVersion: 3,
    runId: input.newRunId,
    benchmarkId: sourceManifest.benchmarkId,
    datasetVersion: sourceManifest.datasetVersion,
    datasetKind: sourceManifest.datasetKind,
    datasetFingerprintSha256: sourceManifest.datasetFingerprintSha256,
    promptVersion: sourceManifest.promptVersion,
    promptFingerprintSha256: sourceManifest.promptFingerprintSha256,
    judgePromptVersion: input.judgePromptVersion,
    judgePromptSetId: sourceManifest.judgePromptSetId,
    judgeBackend: input.judgeBackend ?? 'vertex',
    judgeModelId: input.judgeModelId,
    targetLanguages: sourceManifest.targetLanguages,
    targetLanguageLabels: sourceManifest.targetLanguageLabels,
    limitApplied: sourceManifest.limitApplied,
    participants: sourceManifest.participants,
    translationConcurrencyPerModel: sourceManifest.translationConcurrencyPerModel,
    vertexProject: input.vertexProject,
    vertexRegion: input.vertexRegion,
    geminiCliBin: input.geminiCliBin,
    vendoredGembaCommit: input.vendoredGembaCommit,
    resume: false,
    rejudgeFromRunId: input.sourceRunId,
    reusedTranslations: true,
  });

  for (const record of sourceTranslations) {
    writeJsonlRecord(
      layout.translationJsonlPath,
      rewriteTranslationRecordForRun(record, input.newRunId, input.sourceRunId) as unknown as Record<string, unknown>,
    );
  }

  return {
    runId: input.newRunId,
    judgeModelId: input.judgeModelId,
    translationCount: sourceTranslations.length,
    participants: sourceManifest.participants,
    limitApplied: sourceManifest.limitApplied,
    datasetFingerprintSha256: sourceManifest.datasetFingerprintSha256,
    promptFingerprintSha256: sourceManifest.promptFingerprintSha256,
    layout,
  };
}
