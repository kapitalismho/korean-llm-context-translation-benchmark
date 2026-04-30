import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildStableKey, type NormalizedJudgeRecord, type TargetLanguageCode } from './benchmark-types.js';
import type { ParticipantDefinition } from './participant-registry.js';
import {
  createRunLayout,
  computeFileSha256,
  getUnresolvedTranslationFailureRecords,
  loadRunManifest,
  readJsonlRecords,
  writeJsonlRecord,
  type JudgeBackend,
  type TranslationFailureArtifactRecord,
} from './run-artifacts.js';
import { rewriteTranslationRecordForRun } from './rejudge.js';
import type { CallUsageMetrics } from './run-metrics.js';
import type { TranslationArtifactRecord } from './runner.js';

type TranslationMetricsRecord = CallUsageMetrics & { stable_key: string };
type JudgeRawArtifactRecord = {
  stable_key: string;
  source_id: string;
  target_language: TargetLanguageCode;
  participant_id: string;
  participant_model_id: string;
  raw_judge_output: string;
};
type JudgeMetricsRecord = CallUsageMetrics & { stable_key: string };

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExactParticipantSnapshotMatch(
  selectedParticipant: ParticipantDefinition,
  sourceParticipant: ParticipantDefinition,
): void {
  if (!sameJsonValue(selectedParticipant, sourceParticipant)) {
    throw new Error(`Selected participant ${selectedParticipant.participantId} does not match the source manifest snapshot`);
  }
}

function attachPromptFingerprint(participant: ParticipantDefinition): ParticipantDefinition {
  if (!participant.promptFile) {
    return participant;
  }

  if (!fs.existsSync(participant.promptFile)) {
    throw new Error(`Participant prompt file not found: ${participant.promptFile}`);
  }

  if (fs.readFileSync(participant.promptFile, 'utf8').trim().length === 0) {
    throw new Error(`Participant prompt file is empty: ${participant.promptFile}`);
  }

  return {
    ...participant,
    promptFingerprintSha256: computeFileSha256(participant.promptFile),
  };
}

function buildReusedStableKey(record: Pick<TranslationArtifactRecord, 'source_id' | 'target_language' | 'participant_id'>, newRunId: string): string {
  return buildStableKey(newRunId, record.source_id, record.target_language, record.participant_id);
}

function rewriteJudgeRecordForRun(
  record: NormalizedJudgeRecord,
  newRunId: string,
  newStableKey: string,
): NormalizedJudgeRecord {
  return {
    ...record,
    run_id: newRunId,
    stable_key: newStableKey,
  };
}

export function prepareForkRun(input: {
  outputDir: string;
  sourceRunId: string;
  newRunId: string;
  benchmarkId: string;
  datasetVersion: string;
  datasetKind: 'sentence' | 'context';
  datasetFingerprintSha256: string;
  promptVersion: string;
  promptFingerprintSha256: string;
  judgePromptVersion: string;
  judgePromptSetId: string;
  targetLanguages: TargetLanguageCode[];
  targetLanguageLabels: Partial<Record<TargetLanguageCode, string>>;
  judgeModelId: string | null;
  judgeBackend?: JudgeBackend;
  geminiCliBin?: string;
  vertexProject: string | null;
  vertexRegion: string | null;
  vendoredGembaCommit: string;
  translationConcurrencyPerModel: number;
  limitApplied: number;
  allowedSourceIds: string[];
  participants: ParticipantDefinition[];
}) {
  const sourceManifest = loadRunManifest(input.outputDir, input.sourceRunId, 'fork');
  const participants = input.participants.map(attachPromptFingerprint);

  if (sourceManifest.benchmarkId !== input.benchmarkId) {
    throw new Error('Source run benchmarkId does not match the requested fork configuration');
  }

  if (sourceManifest.datasetVersion !== input.datasetVersion) {
    throw new Error('Source run datasetVersion does not match the requested fork configuration');
  }

  if (sourceManifest.datasetKind !== input.datasetKind) {
    throw new Error('Source run datasetKind does not match the requested fork configuration');
  }

  if (sourceManifest.datasetFingerprintSha256 !== input.datasetFingerprintSha256) {
    throw new Error('Source run dataset fingerprint does not match the requested fork configuration');
  }

  if (sourceManifest.promptVersion !== input.promptVersion) {
    throw new Error('Source run promptVersion does not match the requested fork configuration');
  }

  if (sourceManifest.promptFingerprintSha256 !== input.promptFingerprintSha256) {
    throw new Error('Source run prompt fingerprint does not match the requested fork configuration');
  }

  if (sourceManifest.judgePromptVersion !== input.judgePromptVersion) {
    throw new Error('Source run judgePromptVersion does not match the requested fork configuration');
  }

  if (sourceManifest.judgePromptSetId !== input.judgePromptSetId) {
    throw new Error('Source run judgePromptSetId does not match the requested fork configuration');
  }

  if (!sameJsonValue(sourceManifest.targetLanguages, input.targetLanguages)) {
    throw new Error('Source run targetLanguages do not match the requested fork configuration');
  }

  if (!sameJsonValue(sourceManifest.targetLanguageLabels, input.targetLanguageLabels)) {
    throw new Error('Source run targetLanguageLabels do not match the requested fork configuration');
  }

  const sourceParticipantsById = new Map(
    sourceManifest.participants.map((participant) => [participant.participantId, participant]),
  );
  const overlappingParticipantIds = new Set<string>();

  for (const participant of participants) {
    const sourceParticipant = sourceParticipantsById.get(participant.participantId);
    if (!sourceParticipant) {
      continue;
    }

    assertExactParticipantSnapshotMatch(participant, sourceParticipant);
    overlappingParticipantIds.add(participant.participantId);
  }

  const sourceRunDir = path.join(input.outputDir, input.sourceRunId);
  const sourceTranslations = readJsonlRecords<TranslationArtifactRecord>(path.join(sourceRunDir, 'translations.jsonl'));
  const sourceTranslationFailures = readJsonlRecords<TranslationFailureArtifactRecord>(
    path.join(sourceRunDir, 'translation-failures.jsonl'),
  );
  const sourceTranslationMetrics = readJsonlRecords<TranslationMetricsRecord>(
    path.join(sourceRunDir, 'translation-metrics.jsonl'),
  );
  const unresolvedFailureStableKeys = new Set(
    getUnresolvedTranslationFailureRecords(sourceTranslations, sourceTranslationFailures)
      .map((record) => record.stable_key),
  );
  const allowedSourceIds = new Set(input.allowedSourceIds);
  const copiedSourceTranslations = sourceTranslations
    .filter((record) => overlappingParticipantIds.has(record.participant_id))
    .filter((record) => allowedSourceIds.has(record.source_id))
    .filter((record) => !unresolvedFailureStableKeys.has(record.stable_key))
  const reusedStableKeyBySourceStableKey = new Map(
    copiedSourceTranslations.map((record) => [record.stable_key, buildReusedStableKey(record, input.newRunId)]),
  );
  const copiedTranslations = copiedSourceTranslations
    .map((record) => rewriteTranslationRecordForRun(record, input.newRunId, input.sourceRunId));
  const copiedTranslationMetrics = sourceTranslationMetrics
    .filter((record) => reusedStableKeyBySourceStableKey.has(record.stable_key))
    .map((record) => ({
      ...record,
      stable_key: reusedStableKeyBySourceStableKey.get(record.stable_key) ?? record.stable_key,
    }));

  const canReuseJudgeArtifacts = sourceManifest.judgeModelId !== null
    && sourceManifest.judgeModelId === input.judgeModelId
    && sourceManifest.judgeBackend === (input.judgeBackend ?? 'vertex');
  const sourceNormalizedJudges = canReuseJudgeArtifacts
    ? readJsonlRecords<NormalizedJudgeRecord>(path.join(sourceRunDir, 'judge-normalized.jsonl'))
    : [];
  const sourceRawJudges = canReuseJudgeArtifacts
    ? readJsonlRecords<JudgeRawArtifactRecord>(path.join(sourceRunDir, 'judge-raw.jsonl'))
    : [];
  const sourceJudgeMetrics = canReuseJudgeArtifacts
    ? readJsonlRecords<JudgeMetricsRecord>(path.join(sourceRunDir, 'judge-metrics.jsonl'))
    : [];
  const reusedSourceJudgeStableKeys = new Set(
    sourceNormalizedJudges
      .filter((record) => record.status === 'ok')
      .filter((record) => record.judge_model_id === input.judgeModelId)
      .filter((record) => reusedStableKeyBySourceStableKey.has(record.stable_key))
      .map((record) => record.stable_key),
  );
  const copiedNormalizedJudges = sourceNormalizedJudges
    .filter((record) => reusedSourceJudgeStableKeys.has(record.stable_key))
    .map((record) => rewriteJudgeRecordForRun(
      record,
      input.newRunId,
      reusedStableKeyBySourceStableKey.get(record.stable_key) ?? record.stable_key,
    ));
  const copiedRawJudges = sourceRawJudges
    .filter((record) => reusedSourceJudgeStableKeys.has(record.stable_key))
    .map((record) => ({
      ...record,
      stable_key: reusedStableKeyBySourceStableKey.get(record.stable_key) ?? record.stable_key,
    }));
  const copiedJudgeMetrics = sourceJudgeMetrics
    .filter((record) => reusedSourceJudgeStableKeys.has(record.stable_key))
    .map((record) => ({
      ...record,
      stable_key: reusedStableKeyBySourceStableKey.get(record.stable_key) ?? record.stable_key,
    }));

  const layout = createRunLayout(input.outputDir, {
    manifestVersion: 3,
    runId: input.newRunId,
    benchmarkId: input.benchmarkId,
    datasetVersion: input.datasetVersion,
    datasetKind: input.datasetKind,
    datasetFingerprintSha256: input.datasetFingerprintSha256,
    promptVersion: input.promptVersion,
    promptFingerprintSha256: input.promptFingerprintSha256,
    judgePromptVersion: input.judgePromptVersion,
    judgePromptSetId: input.judgePromptSetId,
    judgeBackend: input.judgeBackend ?? 'vertex',
    judgeModelId: input.judgeModelId,
    targetLanguages: input.targetLanguages,
    targetLanguageLabels: input.targetLanguageLabels,
    limitApplied: input.limitApplied,
    participants,
    translationConcurrencyPerModel: input.translationConcurrencyPerModel,
    vertexProject: input.vertexProject,
    vertexRegion: input.vertexRegion,
    geminiCliBin: input.geminiCliBin,
    vendoredGembaCommit: input.vendoredGembaCommit,
    resume: false,
    forkFromRunId: input.sourceRunId,
  });

  for (const record of copiedTranslations) {
    writeJsonlRecord(layout.translationJsonlPath, record as unknown as Record<string, unknown>);
  }

  for (const record of copiedTranslationMetrics) {
    writeJsonlRecord(layout.translationMetricsJsonlPath, record as unknown as Record<string, unknown>);
  }

  for (const record of copiedNormalizedJudges) {
    writeJsonlRecord(layout.normalizedJudgeJsonlPath, record as unknown as Record<string, unknown>);
  }

  for (const record of copiedRawJudges) {
    writeJsonlRecord(layout.rawJudgeJsonlPath, record as unknown as Record<string, unknown>);
  }

  for (const record of copiedJudgeMetrics) {
    writeJsonlRecord(layout.judgeMetricsJsonlPath, record as unknown as Record<string, unknown>);
  }

  return {
    runId: input.newRunId,
    translationCount: copiedTranslations.length,
    participants,
    limitApplied: input.limitApplied,
    layout,
  };
}
