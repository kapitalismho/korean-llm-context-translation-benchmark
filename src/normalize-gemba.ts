import {
  CONTEXT_BEHAVIORS,
  MQM_ERROR_CLASSES,
  buildStableKey,
  computePenalty,
  countBySeverity,
} from './benchmark-types.js';
import type {
  ContextBehavior,
  NormalizedJudgeError,
  NormalizedJudgeRecord,
  TargetLanguageCode,
} from './benchmark-types.js';

type ContextMetadata = Partial<Pick<NormalizedJudgeRecord,
  'context_turn_count'
  | 'speaker_mode'
  | 'context_expectation'
  | 'primary_phenomenon'
>>;

interface NormalizeBaseInput {
  runId: string;
  sourceId: string;
  targetLanguage: TargetLanguageCode;
  participantId: string;
  participantModelId: string;
  judgeModelId: string;
  contextMetadata?: ContextMetadata;
}

interface ParsedJudgeResponse {
  has_no_error: boolean;
  errors: NormalizedJudgeError[];
  contextBehavior?: ContextBehavior;
}

const VALID_SEVERITIES = new Set<NormalizedJudgeError['severity']>([
  'minor',
  'major',
  'critical',
]);

const VALID_ERROR_CLASSES = new Set(MQM_ERROR_CLASSES);

const VALID_CONTEXT_BEHAVIORS = new Set<ContextBehavior>(CONTEXT_BEHAVIORS);

const VALID_CONTEXT_TURN_COUNTS = new Set<NonNullable<NormalizedJudgeRecord['context_turn_count']>>([1, 2, 3]);

const VALID_SPEAKER_MODES = new Set<NonNullable<NormalizedJudgeRecord['speaker_mode']>>([
  'single',
  'dyadic',
]);

const VALID_CONTEXT_EXPECTATIONS = new Set<NonNullable<NormalizedJudgeRecord['context_expectation']>>([
  'use',
  'ignore',
]);

const ALLOWED_ERROR_KEYS = new Set<keyof NormalizedJudgeError>([
  'severity',
  'class',
  'target_span_text',
  'source_span_text',
  'explanation',
]);

const REQUIRED_ERROR_KEYS = new Set<keyof NormalizedJudgeError>([
  'severity',
  'class',
  'target_span_text',
  'source_span_text',
]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertStringOrNull(value: unknown, fieldName: string): asserts value is string | null {
  if (!(typeof value === 'string' || value === null)) {
    throw new TypeError(`Invalid judge response payload: ${fieldName} must be a string or null`);
  }
}

function assertContextBehavior(value: unknown): asserts value is ContextBehavior {
  if (typeof value !== 'string' || !VALID_CONTEXT_BEHAVIORS.has(value as ContextBehavior)) {
    throw new TypeError('Invalid judge response payload: contextBehavior is invalid');
  }
}

function normalizeContextMetadata(
  contextMetadata: ContextMetadata | undefined,
  options: { tolerateInvalid?: boolean } = {},
): ContextMetadata {
  if (contextMetadata === undefined) {
    return {};
  }

  const normalized: ContextMetadata = {};
  const tolerateInvalid = options.tolerateInvalid ?? false;

  if (contextMetadata.context_turn_count !== undefined) {
    if (!VALID_CONTEXT_TURN_COUNTS.has(contextMetadata.context_turn_count)) {
      if (tolerateInvalid) {
        // Drop malformed persisted metadata in judge_failed fallback paths.
      } else {
        throw new TypeError('Invalid judge response payload: context_turn_count is invalid');
      }
    } else {
      normalized.context_turn_count = contextMetadata.context_turn_count;
    }
  }

  if (contextMetadata.speaker_mode !== undefined) {
    if (!VALID_SPEAKER_MODES.has(contextMetadata.speaker_mode)) {
      if (tolerateInvalid) {
        // Drop malformed persisted metadata in judge_failed fallback paths.
      } else {
        throw new TypeError('Invalid judge response payload: speaker_mode is invalid');
      }
    } else {
      normalized.speaker_mode = contextMetadata.speaker_mode;
    }
  }

  if (contextMetadata.context_expectation !== undefined) {
    if (!VALID_CONTEXT_EXPECTATIONS.has(contextMetadata.context_expectation)) {
      if (tolerateInvalid) {
        // Drop malformed persisted metadata in judge_failed fallback paths.
      } else {
        throw new TypeError('Invalid judge response payload: context_expectation is invalid');
      }
    } else {
      normalized.context_expectation = contextMetadata.context_expectation;
    }
  }

  if (contextMetadata.primary_phenomenon !== undefined) {
    if (typeof contextMetadata.primary_phenomenon !== 'string' || contextMetadata.primary_phenomenon.trim().length === 0) {
      if (tolerateInvalid) {
        // Drop malformed persisted metadata in judge_failed fallback paths.
      } else {
        throw new TypeError('Invalid judge response payload: primary_phenomenon is invalid');
      }
    } else {
      normalized.primary_phenomenon = contextMetadata.primary_phenomenon;
    }
  }

  return normalized;
}

function normalizeStrictContextMetadata(contextMetadata: ContextMetadata | undefined): ContextMetadata {
  return normalizeContextMetadata(contextMetadata);
}

function normalizeFailureContextMetadata(contextMetadata: ContextMetadata | undefined): ContextMetadata {
  return normalizeContextMetadata(contextMetadata, { tolerateInvalid: true });
}

function validateContextBehavior(
  contextBehavior: ContextBehavior | undefined,
  contextMetadata: ContextMetadata,
): void {
  if (contextMetadata.context_expectation === undefined) {
    return;
  }

  if (contextBehavior === undefined) {
    throw new TypeError('Invalid judge response payload: contextBehavior is required when context_expectation metadata is present');
  }
}

function assertNormalizedJudgeError(value: unknown, index: number): asserts value is NormalizedJudgeError {
  if (!isObjectRecord(value)) {
    throw new TypeError(`Invalid judge response payload: errors[${index}] must be an object`);
  }

  const errorKeys = Object.keys(value);

  if (errorKeys.some((key) => !ALLOWED_ERROR_KEYS.has(key as keyof NormalizedJudgeError))) {
    throw new TypeError(`Invalid judge response payload: errors[${index}] has unexpected keys`);
  }

  for (const requiredKey of REQUIRED_ERROR_KEYS) {
    if (!(requiredKey in value)) {
      throw new TypeError(`Invalid judge response payload: errors[${index}].${requiredKey} is required`);
    }
  }

  const severity = value.severity;
  const errorClass = value.class;
  const targetSpanText = value.target_span_text;
  const sourceSpanText = value.source_span_text;
  const explanation = value.explanation;

  if (typeof severity !== 'string' || !VALID_SEVERITIES.has(severity as NormalizedJudgeError['severity'])) {
    throw new TypeError(`Invalid judge response payload: errors[${index}].severity is invalid`);
  }

  if (typeof errorClass !== 'string' || !VALID_ERROR_CLASSES.has(errorClass as NormalizedJudgeError['class'])) {
    throw new TypeError(`Invalid judge response payload: errors[${index}].class is invalid`);
  }

  assertStringOrNull(targetSpanText, `errors[${index}].target_span_text`);
  assertStringOrNull(sourceSpanText, `errors[${index}].source_span_text`);

  if (explanation !== undefined && typeof explanation !== 'string') {
    throw new TypeError(`Invalid judge response payload: errors[${index}].explanation must be a string`);
  }
}

function assertParsedJudgeResponse(
  value: unknown,
): asserts value is ParsedJudgeResponse {
  if (!isObjectRecord(value)) {
    throw new TypeError('Invalid judge response payload: top-level value must be an object');
  }

  if (typeof value.has_no_error !== 'boolean') {
    throw new TypeError('Invalid judge response payload: has_no_error must be a boolean');
  }

  if (!Array.isArray(value.errors)) {
    throw new TypeError('Invalid judge response payload: errors must be an array');
  }

  if (value.has_no_error && value.errors.length > 0) {
    throw new TypeError('Invalid judge response payload: has_no_error cannot be true when errors is non-empty');
  }

  if (!value.has_no_error && value.errors.length === 0) {
    throw new TypeError('Invalid judge response payload: has_no_error cannot be false when errors is empty');
  }

  value.errors.forEach((error, index) => {
    assertNormalizedJudgeError(error, index);
  });

  if (value.contextBehavior !== undefined) {
    assertContextBehavior(value.contextBehavior);
  }
}

export function normalizeJudgeResponse(
  input: NormalizeBaseInput & { rawJsonText: string },
): NormalizedJudgeRecord {
  const parsed: unknown = JSON.parse(input.rawJsonText);

  assertParsedJudgeResponse(parsed);

  const contextMetadata = normalizeStrictContextMetadata(input.contextMetadata);

  validateContextBehavior(parsed.contextBehavior, contextMetadata);

  const errors = parsed.has_no_error ? [] : parsed.errors;
  const counts = countBySeverity(errors);

  return {
    run_id: input.runId,
    source_id: input.sourceId,
    target_language: input.targetLanguage,
    participant_id: input.participantId,
    participant_model_id: input.participantModelId,
    judge_model_id: input.judgeModelId,
    status: 'ok',
    errors,
    summary: {
      has_no_error: parsed.has_no_error,
      critical_count: counts.critical,
      major_count: counts.major,
      minor_count: counts.minor,
      total_penalty: computePenalty(errors),
    },
    raw_judge_output: input.rawJsonText,
    stable_key: buildStableKey(
      input.runId,
      input.sourceId,
      input.targetLanguage,
      input.participantId,
    ),
    ...(parsed.contextBehavior === undefined ? {} : { context_behavior: parsed.contextBehavior }),
    ...contextMetadata,
  };
}

export function normalizeJudgeFailure(
  input: NormalizeBaseInput & { rawJudgeOutput: string },
): NormalizedJudgeRecord {
  const contextMetadata = normalizeFailureContextMetadata(input.contextMetadata);

  return {
    run_id: input.runId,
    source_id: input.sourceId,
    target_language: input.targetLanguage,
    participant_id: input.participantId,
    participant_model_id: input.participantModelId,
    judge_model_id: input.judgeModelId,
    status: 'judge_failed',
    errors: [],
    summary: null,
    raw_judge_output: input.rawJudgeOutput,
    stable_key: buildStableKey(
      input.runId,
      input.sourceId,
      input.targetLanguage,
      input.participantId,
    ),
    ...contextMetadata,
  };
}
