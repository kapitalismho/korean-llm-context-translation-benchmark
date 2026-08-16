import * as fs from 'node:fs';

import type { NormalizedJudgeRecord, TargetLanguageCode } from './benchmark-types.js';
import { normalizeJudgeResponse } from './normalize-gemba.js';
import { readJsonlRecords } from './run-artifacts.js';
import type { RunLayout } from './run-artifacts.js';

interface JudgeFailureArtifactRecord {
  stable_key: string;
  source_id: string;
  target_language: TargetLanguageCode;
  participant_id: string;
  participant_model_id: string;
  error: string;
  raw_judge_output: string;
}

interface RepairJudgeFailuresOptions {
  backupLabel?: string;
}

export interface RepairJudgeFailuresResult {
  repairedCount: number;
  remainingFailureCount: number;
  backupPaths: {
    normalizedJudgePath: string;
    failurePath: string;
  } | null;
}

function rewriteJsonlFile(filePath: string, records: readonly Record<string, unknown>[]): void {
  const content = records.map((record) => JSON.stringify(record)).join('\n');
  fs.writeFileSync(filePath, content.length === 0 ? '' : `${content}\n`);
}

function buildBackupLabel(label?: string): string {
  if (label && label.trim().length > 0) {
    return label.trim();
  }

  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function repairJudgeFailures(
  layout: Pick<RunLayout, 'normalizedJudgeJsonlPath' | 'failuresJsonlPath'>,
  options: RepairJudgeFailuresOptions = {},
): RepairJudgeFailuresResult {
  const normalizedRecords = readJsonlRecords<NormalizedJudgeRecord>(layout.normalizedJudgeJsonlPath);
  const failureRecords = readJsonlRecords<JudgeFailureArtifactRecord>(layout.failuresJsonlPath);
  const repairedStableKeys = new Set<string>();

  const rewrittenNormalizedRecords = normalizedRecords.map((record) => {
    if (record.status !== 'judge_failed') {
      return record;
    }

    try {
      const repairedRecord = normalizeJudgeResponse({
        rawJudgeOutput: record.raw_judge_output,
        runId: record.run_id,
        sourceId: record.source_id,
        targetLanguage: record.target_language,
        participantId: record.participant_id,
        participantModelId: record.participant_model_id,
        judgeModelId: record.judge_model_id,
        contextMetadata: {
          context_turn_count: record.context_turn_count,
          speaker_mode: record.speaker_mode,
          context_expectation: record.context_expectation,
          primary_phenomenon: record.primary_phenomenon,
        },
      });

      repairedStableKeys.add(record.stable_key);
      return repairedRecord;
    } catch {
      return record;
    }
  });

  const rewrittenFailureRecords = failureRecords.filter(
    (record) => !repairedStableKeys.has(record.stable_key),
  );
  const remainingJudgeFailedStableKeys = new Set(
    rewrittenNormalizedRecords
      .filter((record) => record.status === 'judge_failed')
      .map((record) => record.stable_key),
  );
  const prunedFailureRecords = rewrittenFailureRecords.filter(
    (record) => remainingJudgeFailedStableKeys.has(record.stable_key),
  );

  if (repairedStableKeys.size === 0) {
    return {
      repairedCount: 0,
      remainingFailureCount: remainingJudgeFailedStableKeys.size,
      backupPaths: null,
    };
  }

  const backupLabel = buildBackupLabel(options.backupLabel);
  const backupPaths = {
    normalizedJudgePath: `${layout.normalizedJudgeJsonlPath}.${backupLabel}.bak`,
    failurePath: `${layout.failuresJsonlPath}.${backupLabel}.bak`,
  };

  if (fs.existsSync(layout.normalizedJudgeJsonlPath)) {
    fs.copyFileSync(layout.normalizedJudgeJsonlPath, backupPaths.normalizedJudgePath);
  } else {
    fs.writeFileSync(backupPaths.normalizedJudgePath, '');
  }

  if (fs.existsSync(layout.failuresJsonlPath)) {
    fs.copyFileSync(layout.failuresJsonlPath, backupPaths.failurePath);
  } else {
    fs.writeFileSync(backupPaths.failurePath, '');
  }

  rewriteJsonlFile(
    layout.normalizedJudgeJsonlPath,
    rewrittenNormalizedRecords as unknown as Record<string, unknown>[],
  );
  rewriteJsonlFile(
    layout.failuresJsonlPath,
    prunedFailureRecords as unknown as Record<string, unknown>[],
  );

  return {
    repairedCount: repairedStableKeys.size,
    remainingFailureCount: remainingJudgeFailedStableKeys.size,
    backupPaths,
  };
}
