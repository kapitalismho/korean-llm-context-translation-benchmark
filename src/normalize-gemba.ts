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

const SEVERITY_SECTION_PATTERN = /^(critical|major|minor)\s*:\s*$/i;
const CONTEXT_BEHAVIOR_LINE_PATTERN = /^contextBehavior\s*[=:]\s*(.+)$/i;
const NO_ERROR_LINE_PATTERN = /^no-error\s*$/i;
const SPAN_PATTERN = /"([^"]+)"/;
// Anchored error-line shape: <MQM class> - "<span>" with nothing after the
// closing quote. The class field is validated separately against the frozen
// inventory (including multiword classes like "accuracy/untranslated text").
const ERROR_LINE_PATTERN = /^[\w/ -]+\s*-\s*"[^"]+"\s*$/i;

function isValidAnchoredErrorLine(line: string): boolean {
  return ERROR_LINE_PATTERN.test(line) && extractClassField(line) !== null;
}

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

function isWordChar(character: string): boolean {
  return /[a-z0-9]/.test(character);
}

function matchMqmErrorClass(line: string): NormalizedJudgeError['class'] | null {
  const lower = line.toLowerCase();
  const sortedClasses = [...VALID_ERROR_CLASSES].sort((a, b) => b.length - a.length);

  for (const errorClass of sortedClasses) {
    for (const form of [errorClass, errorClass.replaceAll('/', '-')]) {
      let index = lower.indexOf(form);
      while (index !== -1) {
        const before = index === 0 ? '' : lower[index - 1];
        const after = index + form.length >= lower.length ? '' : lower[index + form.length];
        if (!isWordChar(before) && !isWordChar(after)) {
          return errorClass;
        }
        index = lower.indexOf(form, index + 1);
      }
    }
  }

  return null;
}

function parseMqmTextErrorLine(line: string, severity: NormalizedJudgeError['severity']): NormalizedJudgeError {
  // Prefer the strict class field (text before the first ` - "` separator) so a
  // class name inside the quoted span cannot hijack the parsed class; fall back
  // to the legacy whole-line search for historical leniency.
  const errorClass = extractClassField(line) ?? matchMqmErrorClass(line);
  if (errorClass === null) {
    throw new TypeError(`Invalid judge response payload: no MQM class found in error line: ${line}`);
  }

  const spanMatch = line.match(SPAN_PATTERN);

  return {
    severity,
    class: errorClass,
    target_span_text: spanMatch === null ? null : spanMatch[1],
    source_span_text: null,
  };
}

/**
 * Extract the MQM class field (everything before the first ` - "` separator)
 * and validate it exactly against the frozen inventory (slash and hyphenated
 * forms). Returns null when the line has no separator or the field is not a
 * known class.
 */
function extractClassField(line: string): NormalizedJudgeError['class'] | null {
  const separatorIndex = line.indexOf(' - "');
  if (separatorIndex === -1) {
    return null;
  }

  const classCandidate = line.slice(0, separatorIndex).trim().toLowerCase();

  for (const errorClass of VALID_ERROR_CLASSES) {
    if (classCandidate === errorClass || classCandidate === errorClass.replaceAll('/', '-')) {
      return errorClass;
    }
  }

  return null;
}

/**
 * Parses the GEMBA-MQM text annotation format:
 *
 *   Critical:
 *   no-error
 *   Major:
 *   accuracy/mistranslation - "writing"
 *   Minor:
 *   no-error
 *   contextBehavior: missed_required_context
 *
 * Lines before the first severity heading are ignored (tolerates preamble prose),
 * error lines inside a severity section must contain a known MQM class.
 */
export function parseMqmTextJudgeResponse(rawText: string): ParsedJudgeResponse {
  const errors: NormalizedJudgeError[] = [];
  let currentSeverity: NormalizedJudgeError['severity'] | null = null;
  let contextBehavior: ContextBehavior | undefined;
  let sawSeveritySection = false;

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith('```')) {
      continue;
    }

    const behaviorMatch = line.match(CONTEXT_BEHAVIOR_LINE_PATTERN);
    if (behaviorMatch) {
      if (contextBehavior !== undefined) {
        throw new TypeError('Invalid judge response payload: duplicate contextBehavior line');
      }

      const value = behaviorMatch[1].trim().toLowerCase();
      if (!VALID_CONTEXT_BEHAVIORS.has(value as ContextBehavior)) {
        throw new TypeError('Invalid judge response payload: contextBehavior is invalid');
      }

      contextBehavior = value as ContextBehavior;
      continue;
    }

    const sectionMatch = line.match(SEVERITY_SECTION_PATTERN);
    if (sectionMatch) {
      currentSeverity = sectionMatch[1].toLowerCase() as NormalizedJudgeError['severity'];
      sawSeveritySection = true;
      continue;
    }

    if (NO_ERROR_LINE_PATTERN.test(line)) {
      continue;
    }

    if (currentSeverity === null) {
      // Preamble prose before the first severity heading.
      continue;
    }

    errors.push(parseMqmTextErrorLine(line, currentSeverity));
  }

  if (!sawSeveritySection && errors.length === 0 && contextBehavior === undefined) {
    throw new TypeError('Invalid judge response payload: no severity sections found');
  }

  return {
    has_no_error: errors.length === 0,
    errors,
    ...(contextBehavior === undefined ? {} : { contextBehavior }),
  };
}

/**
 * Strict completeness gate for live judge backends (OpenRouter batch, Gemini CLI):
 * the annotation must contain all three severity sections (Critical/Major/Minor)
 * and end with a single valid contextBehavior line. Preamble prose and markdown
 * fences are tolerated; anything else (for example a bare `contextBehavior:`
 * line without severity sections) is rejected so malformed output cannot reach
 * the normalizer as a no-error success.
 */
export function isCompleteMqmTextAnnotation(rawText: string): boolean {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('```'));

  const seenSeverities = new Set<string>();
  let behaviorValue: string | undefined;
  let currentSeverity: string | null = null;
  let currentSeverityHasContent = false;

  const finishSection = (): boolean => {
    if (currentSeverity === null) {
      return true;
    }

    // Each severity section must contain either `no-error` or at least one
    // valid error line (the frozen annotation contract).
    return currentSeverityHasContent;
  };

  for (const line of lines) {
    const sectionMatch = line.match(SEVERITY_SECTION_PATTERN);
    if (sectionMatch) {
      if (!finishSection()) {
        return false;
      }

      currentSeverity = sectionMatch[1].toLowerCase();
      seenSeverities.add(currentSeverity);
      currentSeverityHasContent = false;
      continue;
    }

    const behaviorMatch = line.match(CONTEXT_BEHAVIOR_LINE_PATTERN);
    if (behaviorMatch) {
      if (behaviorValue !== undefined) {
        return false; // duplicate contextBehavior line
      }

      const value = behaviorMatch[1].trim().toLowerCase();
      if (!VALID_CONTEXT_BEHAVIORS.has(value as ContextBehavior)) {
        return false;
      }

      behaviorValue = value;
      continue;
    }

    if (currentSeverity !== null && NO_ERROR_LINE_PATTERN.test(line)) {
      currentSeverityHasContent = true;
      continue;
    }

    // Inside a severity section every other line must be an error line in the
    // frozen grammar: <MQM class> - "<span>". The class field (everything
    // before the ` - "` separator) must be an exact inventory class; a bare
    // class (no span), trailing prose, or prose that merely mentions a class
    // is not a valid annotation line.
    if (currentSeverity !== null) {
      if (!isValidAnchoredErrorLine(line)) {
        return false;
      }

      currentSeverityHasContent = true;
    }
  }

  if (behaviorValue === undefined) {
    return false;
  }

  if (!finishSection()) {
    return false;
  }

  // The contextBehavior line must be the final non-blank line of the annotation.
  const lastLine = lines.at(-1) ?? '';
  const lastBehaviorMatch = lastLine.match(CONTEXT_BEHAVIOR_LINE_PATTERN);
  if (!lastBehaviorMatch) {
    return false;
  }

  return seenSeverities.has('critical')
    && seenSeverities.has('major')
    && seenSeverities.has('minor');
}

function parseJudgeResponseText(rawJudgeOutput: string): ParsedJudgeResponse {
  const trimmed = rawJudgeOutput.trim();

  if (trimmed.startsWith('{')) {
    try {
      // Legacy JSON payloads (historical artifacts) remain accepted.
      return JSON.parse(trimmed) as unknown as ParsedJudgeResponse;
    } catch {
      // Not legacy JSON; fall through to the MQM text parser.
    }
  }

  return parseMqmTextJudgeResponse(rawJudgeOutput);
}

export function normalizeJudgeResponse(
  input: NormalizeBaseInput & { rawJudgeOutput: string },
): NormalizedJudgeRecord {
  const parsed = parseJudgeResponseText(input.rawJudgeOutput);

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
    raw_judge_output: input.rawJudgeOutput,
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
