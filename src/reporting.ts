import {
  CONTEXT_BEHAVIORS,
  type MqmErrorClass,
  type NormalizedJudgeRecord,
  type TargetLanguageCode,
} from './benchmark-types.js';
import type { ParticipantDefinition } from './participant-registry.js';

const BENCHMARK_LANGUAGES: TargetLanguageCode[] = ['en', 'ja', 'zh-Hans'];

interface ReportingParticipantSnapshot {
  participantId: string;
  displayName: string;
}

export interface BenchmarkLeaderboardRow {
  participant_id: string;
  participant_display_name: string;
  mean_penalty: number | null;
  samples: number;
  failed_samples: number;
}

export interface BenchmarkLanguageReport {
  leaderboard: BenchmarkLeaderboardRow[];
  severityBreakdown: Record<string, { critical: number; major: number; minor: number }>;
  errorClassBreakdown: Record<string, Partial<Record<MqmErrorClass, number>>>;
  failures: Array<{
    participant_id: string;
    participant_display_name: string;
    source_id: string;
    stable_key: string;
  }>;
}

export interface BenchmarkReports {
  byLanguage: Record<TargetLanguageCode, BenchmarkLanguageReport>;
  summaryOverallPenalty: Array<{
    participant_id: string;
    participant_display_name: string;
    mean_penalty: number | null;
  }>;
  summaryOverallNormalized: Array<{
    participant_id: string;
    participant_display_name: string;
    normalized_macro_mean_penalty: number | null;
  }>;
  byContextTurnCount: Record<string, BenchmarkLanguageReport['leaderboard']>;
  bySpeakerMode: Record<string, BenchmarkLanguageReport['leaderboard']>;
  byContextTurnCountAndSpeakerMode: Record<string, BenchmarkLanguageReport['leaderboard']>;
  byPrimaryPhenomenon: Record<string, BenchmarkLanguageReport['leaderboard']>;
  byContextExpectation: Record<string, BenchmarkLanguageReport['leaderboard']>;
  contextBehavior: Record<string, Record<string, number>>;
  contextBehaviorRates: Record<string, {
    missed_required_context_rate: number;
    misused_context_rate: number;
  }>;
}

function meanPenaltyForSlice(records: readonly NormalizedJudgeRecord[], participantId: string): number | null {
  const participantRecords = records.filter(
    (record) => record.participant_id === participantId && record.summary !== null,
  );

  if (participantRecords.length === 0) {
    return null;
  }

  return participantRecords.reduce((sum, record) => sum + (record.summary?.total_penalty ?? 0), 0) / participantRecords.length;
}

function buildContextBehaviorRates(
  records: readonly NormalizedJudgeRecord[],
  participantId: string,
): BenchmarkReports['contextBehaviorRates'][string] {
  const participantOk = records.filter(
    (record) => record.participant_id === participantId && record.status === 'ok',
  );
  const useRecords = participantOk.filter((record) => record.context_expectation === 'use');
  const ignoreRecords = participantOk.filter((record) => record.context_expectation === 'ignore');

  return {
    missed_required_context_rate: useRecords.length === 0
      ? 0
      : useRecords.filter((record) => record.context_behavior === 'missed_required_context').length / useRecords.length,
    misused_context_rate: ignoreRecords.length === 0
      ? 0
      : ignoreRecords.filter((record) => record.context_behavior === 'misused_context').length / ignoreRecords.length,
  };
}

function buildSliceLeaderboard(
  records: readonly NormalizedJudgeRecord[],
  participants: readonly ReportingParticipantSnapshot[],
  keySelector: (record: NormalizedJudgeRecord) => string | undefined,
): Record<string, BenchmarkLanguageReport['leaderboard']> {
  const grouped = new Map<string, NormalizedJudgeRecord[]>();

  for (const record of records) {
    const key = keySelector(record);

    if (key === undefined) {
      continue;
    }

    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }

  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
      .map(([key, sliceRecords]) => [
        key,
        participants.map((participant) => ({
          participant_id: participant.participantId,
          participant_display_name: participant.displayName,
          mean_penalty: meanPenaltyForSlice(sliceRecords, participant.participantId),
          samples: sliceRecords.filter(
            (record) => record.participant_id === participant.participantId && record.status === 'ok',
          ).length,
          failed_samples: sliceRecords.filter(
            (record) => record.participant_id === participant.participantId && record.status === 'judge_failed',
          ).length,
        })),
      ]),
  );
}

function buildContextBehaviorCounts(
  records: readonly NormalizedJudgeRecord[],
  participants: readonly ReportingParticipantSnapshot[],
): BenchmarkReports['contextBehavior'] {
  return Object.fromEntries(
    participants.map((participant) => {
      const participantRecords = records.filter((record) => record.participant_id === participant.participantId);

      return [
        participant.participantId,
        Object.fromEntries(
          CONTEXT_BEHAVIORS.map((behavior) => [
            behavior,
            participantRecords.filter((record) => record.context_behavior === behavior).length,
          ]),
        ),
      ];
    }),
  );
}

function buildLanguageReports(
  records: readonly NormalizedJudgeRecord[],
  participants: readonly ReportingParticipantSnapshot[],
  targetLanguages: readonly TargetLanguageCode[],
): Record<TargetLanguageCode, BenchmarkLanguageReport> {
  return Object.fromEntries(
    targetLanguages.map((language) => {
      const recordsForLanguage = records.filter((record) => record.target_language === language);
      const okRecords = recordsForLanguage.filter(
        (record) => record.status === 'ok' && record.summary !== null,
      );
      const failedRecords = recordsForLanguage.filter((record) => record.status === 'judge_failed');

      const leaderboard = participants.map((participant) => ({
        participant_id: participant.participantId,
        participant_display_name: participant.displayName,
        mean_penalty: meanPenaltyForSlice(okRecords, participant.participantId),
        samples: okRecords.filter((record) => record.participant_id === participant.participantId).length,
        failed_samples: failedRecords.filter((record) => record.participant_id === participant.participantId).length,
      }));

      const severityBreakdown = Object.fromEntries(
        participants.map((participant) => {
          const participantOk = okRecords.filter((record) => record.participant_id === participant.participantId);

          return [participant.participantId, {
            critical: participantOk.reduce((sum, record) => sum + (record.summary?.critical_count ?? 0), 0),
            major: participantOk.reduce((sum, record) => sum + (record.summary?.major_count ?? 0), 0),
            minor: participantOk.reduce((sum, record) => sum + (record.summary?.minor_count ?? 0), 0),
          }];
        }),
      ) as BenchmarkLanguageReport['severityBreakdown'];

      const errorClassBreakdown = Object.fromEntries(
        participants.map((participant) => {
          const counts = new Map<MqmErrorClass, number>();

          okRecords
            .filter((record) => record.participant_id === participant.participantId)
            .flatMap((record) => record.errors)
            .forEach((error) => {
              counts.set(error.class, (counts.get(error.class) ?? 0) + 1);
            });

          return [participant.participantId, Object.fromEntries(counts)];
        }),
      ) as BenchmarkLanguageReport['errorClassBreakdown'];

      const participantDisplayNameById = new Map(
        participants.map((participant) => [participant.participantId, participant.displayName]),
      );

      const failures = failedRecords.map((record) => ({
        participant_id: record.participant_id,
        participant_display_name: participantDisplayNameById.get(record.participant_id) ?? record.participant_id,
        source_id: record.source_id,
        stable_key: record.stable_key,
      }));

      return [language, { leaderboard, severityBreakdown, errorClassBreakdown, failures }];
    }),
  ) as Record<TargetLanguageCode, BenchmarkLanguageReport>;
}

function buildNormalizedOverallSummary(
  byLanguage: Record<TargetLanguageCode, BenchmarkLanguageReport>,
  participants: readonly ReportingParticipantSnapshot[],
): BenchmarkReports['summaryOverallNormalized'] {
  const normalizedScoresByParticipant = new Map<string, number[]>(
    participants.map((participant) => [participant.participantId, []]),
  );

  for (const languageReport of Object.values(byLanguage)) {
    const nonNullRows = languageReport.leaderboard.filter((row) => row.mean_penalty !== null);

    if (nonNullRows.length === 0) {
      continue;
    }

    const penalties = nonNullRows.map((row) => row.mean_penalty as number);
    const minPenalty = Math.min(...penalties);
    const maxPenalty = Math.max(...penalties);

    for (const row of nonNullRows) {
      const normalizedScore = maxPenalty === minPenalty
        ? 0
        : ((row.mean_penalty as number) - minPenalty) / (maxPenalty - minPenalty);

      normalizedScoresByParticipant.get(row.participant_id)?.push(normalizedScore);
    }
  }

  return participants.map((participant) => {
    const normalizedPenalties = normalizedScoresByParticipant.get(participant.participantId) ?? [];

    return {
      participant_id: participant.participantId,
      participant_display_name: participant.displayName,
      normalized_macro_mean_penalty: normalizedPenalties.length === 0
        ? null
        : normalizedPenalties.reduce((sum, value) => sum + value, 0) / normalizedPenalties.length,
    };
  });
}

export function buildBenchmarkReports(
  records: NormalizedJudgeRecord[],
  participants: readonly string[] | readonly ParticipantDefinition[],
  targetLanguages: TargetLanguageCode[] = BENCHMARK_LANGUAGES,
): BenchmarkReports {
  const participantSnapshots = normalizeReportingParticipants(participants);
  const byLanguage = buildLanguageReports(records, participantSnapshots, targetLanguages);
  const okRecords = records.filter((record) => record.status === 'ok');
  const summaryOverallPenalty = participantSnapshots.map((participant) => ({
    participant_id: participant.participantId,
    participant_display_name: participant.displayName,
    mean_penalty: meanPenaltyForSlice(okRecords, participant.participantId),
  }));
  const summaryOverallNormalized = buildNormalizedOverallSummary(byLanguage, participantSnapshots);
  const byContextTurnCount = buildSliceLeaderboard(
    records,
    participantSnapshots,
    (record) => record.context_turn_count === undefined ? undefined : String(record.context_turn_count),
  );
  const bySpeakerMode = buildSliceLeaderboard(records, participantSnapshots, (record) => record.speaker_mode);
  const byContextTurnCountAndSpeakerMode = buildSliceLeaderboard(
    records,
    participantSnapshots,
    (record) => (
      record.context_turn_count !== undefined && record.speaker_mode !== undefined
        ? `${record.context_turn_count}::${record.speaker_mode}`
        : undefined
    ),
  );
  const byPrimaryPhenomenon = buildSliceLeaderboard(
    records,
    participantSnapshots,
    (record) => record.primary_phenomenon,
  );
  const byContextExpectation = buildSliceLeaderboard(
    records,
    participantSnapshots,
    (record) => record.context_expectation,
  );
  const contextBehavior = buildContextBehaviorCounts(records, participantSnapshots);
  const contextBehaviorRates = Object.fromEntries(
    participantSnapshots.map((participant) => [
      participant.participantId,
      buildContextBehaviorRates(records, participant.participantId),
    ]),
  );

  return {
    byLanguage,
    summaryOverallPenalty,
    summaryOverallNormalized,
    byContextTurnCount,
    bySpeakerMode,
    byContextTurnCountAndSpeakerMode,
    byPrimaryPhenomenon,
    byContextExpectation,
    contextBehavior,
    contextBehaviorRates,
  };
}

function normalizeReportingParticipants(
  participants: readonly string[] | readonly ParticipantDefinition[],
): ReportingParticipantSnapshot[] {
  return participants.map((participant) => {
    if (typeof participant === 'string') {
      return {
        participantId: participant,
        displayName: participant,
      };
    }

    return {
      participantId: participant.participantId,
      displayName: participant.displayName,
    };
  });
}
