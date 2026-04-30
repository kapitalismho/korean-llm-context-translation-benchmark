export const MQM_ERROR_CLASSES = [
  'accuracy/addition',
  'accuracy/mistranslation',
  'accuracy/omission',
  'accuracy/untranslated text',
  'fluency/character encoding',
  'fluency/grammar',
  'fluency/inconsistency',
  'fluency/punctuation',
  'fluency/register',
  'fluency/spelling',
  'style/awkward',
  'terminology/inappropriate for context',
  'terminology/inconsistent use',
  'non-translation',
  'other',
] as const;

export const CONTEXT_BEHAVIORS = [
  'used_correctly',
  'missed_required_context',
  'ignored_irrelevant_context',
  'misused_context',
  'unclear',
] as const;

export type MqmErrorClass = (typeof MQM_ERROR_CLASSES)[number];
export type ContextBehavior = (typeof CONTEXT_BEHAVIORS)[number];
export type JudgeSeverity = 'minor' | 'major' | 'critical';
export type JudgeStatus = 'ok' | 'judge_failed';
export type TargetLanguageCode = 'en' | 'ja' | 'zh-Hans';

export interface NormalizedJudgeError {
  severity: JudgeSeverity;
  class: MqmErrorClass;
  target_span_text: string | null;
  source_span_text: string | null;
  explanation?: string;
}

export interface NormalizedJudgeSummary {
  has_no_error: boolean;
  critical_count: number;
  major_count: number;
  minor_count: number;
  total_penalty: number;
}

export interface NormalizedJudgeRecord {
  run_id: string;
  source_id: string;
  target_language: TargetLanguageCode;
  participant_id: string;
  participant_model_id: string;
  judge_model_id: string;
  status: JudgeStatus;
  errors: NormalizedJudgeError[];
  summary: NormalizedJudgeSummary | null;
  raw_judge_output: string;
  stable_key: string;
  context_behavior?: ContextBehavior;
  context_turn_count?: 1 | 2 | 3;
  speaker_mode?: 'single' | 'dyadic';
  context_expectation?: 'use' | 'ignore';
  primary_phenomenon?: string;
}

type SeverityCarrier = {
  severity: JudgeSeverity;
};

export function computePenalty(items: ReadonlyArray<SeverityCarrier> = []): number {
  let total = 0;

  for (const item of items) {
    switch (item.severity) {
      case 'critical':
        total += 25;
        break;
      case 'major':
        total += 5;
        break;
      case 'minor':
        total += 1;
        break;
    }
  }

  return total;
}

export function countBySeverity(items: ReadonlyArray<SeverityCarrier> = []): Record<JudgeSeverity, number> {
  const counts: Record<JudgeSeverity, number> = {
    critical: 0,
    major: 0,
    minor: 0,
  };

  for (const item of items) {
    counts[item.severity] += 1;
  }

  return counts;
}

export function buildStableKey(
  runId: string,
  sourceId: string | number,
  targetLanguage: TargetLanguageCode,
  participantId: string,
): string {
  return `${runId}::${sourceId}::${targetLanguage}::${participantId}`;
}
