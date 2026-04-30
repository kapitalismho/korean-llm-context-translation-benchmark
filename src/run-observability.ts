import * as fs from 'node:fs';

import type { BenchmarkPhase } from './run-metrics.js';
import { writeJsonlRecord } from './run-artifacts.js';

const MAX_SOURCE_PREVIEW_CODE_POINTS = 120;
const MAX_PERSISTED_ERROR_CODE_POINTS = 4_000;

type NullableString = string | null;

export type RunEventScope = 'item' | 'participant' | 'throttle_bucket' | 'phase';

export interface RunEventRecord {
  scope: RunEventScope;
  timestamp: string;
  phase: BenchmarkPhase;
  event_type: string;
  throttle_bucket_key: NullableString;
  stable_key: NullableString;
  source_id: NullableString;
  source_preview: NullableString;
  source_lang: NullableString;
  target_language: NullableString;
  participant_id: NullableString;
  participant_model_id: NullableString;
  provider: NullableString;
  attempt: number | null;
  max_attempts: number | null;
  latency_ms: number | null;
  error_class: NullableString;
  error_summary: NullableString;
  raw_error_message: NullableString;
  next_delay_ms: number | null;
}

export interface RunStateParticipantSnapshot {
  participantId: string;
  completed: number;
  succeeded: number;
  failed: number;
  retryCount: number;
  inflight: number;
  remaining: number;
}

export interface RunStateThrottleBucketSnapshot {
  throttleBucketKey: string;
  participantIds: string[];
  inflight: number;
  queued: number;
  cooldownUntil: string | null;
}

export interface RunStateInflightItem {
  phase: BenchmarkPhase;
  stableKey: string;
  throttleBucketKey: string | null;
  participantId: string | null;
  participantModelId: string | null;
  provider: string | null;
  sourceId: string | null;
  sourcePreview: string | null;
  sourceLang: string | null;
  targetLanguage: string | null;
  attempt: number;
  startedAt: string;
  requestTimeoutMs: number | null;
}

export interface RunStateEventSummary {
  phase: BenchmarkPhase;
  eventType: string;
  timestamp: string;
  throttleBucketKey: string | null;
  stableKey: string | null;
  sourceId: string | null;
  sourcePreview: string | null;
  sourceLang: string | null;
  targetLanguage: string | null;
  participantId: string | null;
  participantModelId: string | null;
  provider: string | null;
  attempt: number | null;
  maxAttempts: number | null;
  latencyMs: number | null;
  errorClass: string | null;
  errorSummary: string | null;
  rawErrorMessage: string | null;
  nextDelayMs: number | null;
}

export interface RunStateSnapshot {
  currentPhase: BenchmarkPhase | 'complete';
  updatedAt: string;
  overall: {
    completed: number;
    succeeded: number;
    failed: number;
    retryCount: number;
    cumulativeRetryCount: number;
  };
  participants: RunStateParticipantSnapshot[];
  throttleBuckets: RunStateThrottleBucketSnapshot[];
  inflightItems: RunStateInflightItem[];
  recentFailures: RunStateEventSummary[];
  recentRetries: RunStateEventSummary[];
}

function truncateCodePoints(value: string, maxCodePoints: number): string {
  return Array.from(value).slice(0, maxCodePoints).join('');
}

function toNullableString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return String(value);
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function skipWhitespace(value: string, startIndex: number): number {
  let index = startIndex;

  while (index < value.length && /\s/.test(value[index] ?? '')) {
    index += 1;
  }

  return index;
}

function scanQuotedStringEnd(value: string, startIndex: number): number {
  let index = startIndex + 1;

  while (index < value.length) {
    const character = value[index];

    if (character === '\\') {
      index += 2;
      continue;
    }

    if (character === '"') {
      return index + 1;
    }

    index += 1;
  }

  return value.length;
}

function scanBalancedStructureEnd(value: string, startIndex: number): number {
  const stack: string[] = [value[startIndex] ?? ''];
  let index = startIndex + 1;

  while (index < value.length && stack.length > 0) {
    const character = value[index];

    if (character === '"') {
      index = scanQuotedStringEnd(value, index);
      continue;
    }

    if (character === '{' || character === '[') {
      stack.push(character);
      index += 1;
      continue;
    }

    if (character === '}' || character === ']') {
      stack.pop();
      index += 1;
      continue;
    }

    index += 1;
  }

  return index;
}

function scanInlineValueEnd(value: string, startIndex: number): number {
  let index = startIndex;

  while (index < value.length) {
    const character = value[index];

    if (character === '\r' || character === '\n' || character === ',' || character === '}' || character === ']') {
      break;
    }

    index += 1;
  }

  return index;
}

function scanStructuredValueEnd(value: string, startIndex: number): number {
  const index = skipWhitespace(value, startIndex);
  const firstCharacter = value[index];

  if (firstCharacter === undefined) {
    return value.length;
  }

  if (firstCharacter === '"') {
    return scanQuotedStringEnd(value, index);
  }

  if (firstCharacter === '{' || firstCharacter === '[') {
    return scanBalancedStructureEnd(value, index);
  }

  return scanInlineValueEnd(value, index);
}

function redactJsonLikePayloadValues(message: string): string {
  const pattern = /"(systemPrompt|systemInstruction|requestBody|requestPayload|requestJson)"\s*:\s*/gi;
  let result = '';
  let cursor = 0;
  let match = pattern.exec(message);

  while (match) {
    const key = match[1] ?? '';
    const valueStart = pattern.lastIndex;
    const valueEnd = scanStructuredValueEnd(message, valueStart);

    result += message.slice(cursor, match.index);
    result += `"${key}":"[redacted]"`;
    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
    match = pattern.exec(message);
  }

  result += message.slice(cursor);
  return result;
}

function redactNamedPayloadSections(message: string): string {
  const pattern = /(request(?:[-_ ]?(?:body|payload|json))|system(?:[-_ ]?(?:prompt|instruction)))\s*:\s*/gi;
  let result = '';
  let cursor = 0;
  let match = pattern.exec(message);

  while (match) {
    const normalizedLabel = match[1]?.toLowerCase().startsWith('system')
      ? 'system prompt'
      : 'request body';
    const valueStart = pattern.lastIndex;
    const structuredValueStart = skipWhitespace(message, valueStart);
    const firstCharacter = message[structuredValueStart];
    const valueEnd = firstCharacter === '{' || firstCharacter === '[' || firstCharacter === '"'
      ? scanStructuredValueEnd(message, valueStart)
      : message.length;

    result += message.slice(cursor, match.index);
    result += `${normalizedLabel}: [redacted]`;
    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
    match = pattern.exec(message);
  }

  result += message.slice(cursor);
  return result;
}

export function redactErrorMessage(message: string): string {
  return redactJsonLikePayloadValues(message)
    .replace(/"((?:x[-_]?api[-_]?key)|(?:api[-_]?key)|(?:xApiKey)|(?:apiKey))"\s*:\s*"(?:\\.|[^"\\])*"/gi, '"$1":"***"')
    .replace(/"authorization"\s*:\s*"(?:\\.|[^"\\])*"/gi, '"authorization":"***"')
    .replace(/\bauthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'authorization: Bearer ***')
    .replace(/\b[Bb]earer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer ***')
    .replace(/\bauthorization\s*:\s*([^\r\n]+)/gi, (_match, value: string) => {
      return value.trim().toLowerCase() === 'bearer ***'
        ? 'authorization: Bearer ***'
        : 'authorization: ***';
    })
    .replace(/\b(x-api-key|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/gi, '$1: ***');
}

export function sanitizePersistedErrorText(message: string): string {
  return truncateCodePoints(
    redactErrorMessage(redactNamedPayloadSections(message)),
    MAX_PERSISTED_ERROR_CODE_POINTS,
  );
}

export function truncatePreview(source: string): string {
  return truncateCodePoints(source, MAX_SOURCE_PREVIEW_CODE_POINTS);
}

export function sanitizeRunEvent(event: Record<string, unknown>): RunEventRecord {
  const scope = (event.scope ?? 'phase') as RunEventScope;
  const isItemScope = scope === 'item';
  const isParticipantScope = scope === 'participant';
  const sourcePreview = event.source_preview ?? event.sourcePreview ?? event.source;

  return {
    scope,
    timestamp: String(event.timestamp ?? new Date().toISOString()),
    phase: String(event.phase ?? 'translation') as BenchmarkPhase,
    event_type: String(event.event_type ?? 'unknown'),
    throttle_bucket_key: scope === 'phase' ? null : toNullableString(event.throttle_bucket_key),
    stable_key: isItemScope ? toNullableString(event.stable_key) : null,
    source_id: isItemScope ? toNullableString(event.source_id) : null,
    source_preview: isItemScope && sourcePreview !== undefined && sourcePreview !== null
      ? truncatePreview(String(sourcePreview))
      : null,
    source_lang: isItemScope ? toNullableString(event.source_lang) : null,
    target_language: isItemScope ? toNullableString(event.target_language) : null,
    participant_id: isItemScope || isParticipantScope ? toNullableString(event.participant_id) : null,
    participant_model_id: isItemScope || isParticipantScope ? toNullableString(event.participant_model_id) : null,
    provider: isItemScope || isParticipantScope ? toNullableString(event.provider) : null,
    attempt: toNullableNumber(event.attempt),
    max_attempts: toNullableNumber(event.max_attempts),
    latency_ms: toNullableNumber(event.latency_ms),
    error_class: toNullableString(event.error_class),
    error_summary: event.error_summary === undefined || event.error_summary === null
      ? null
      : sanitizePersistedErrorText(String(event.error_summary)),
    raw_error_message: event.raw_error_message === undefined || event.raw_error_message === null
      ? null
      : sanitizePersistedErrorText(String(event.raw_error_message)),
    next_delay_ms: toNullableNumber(event.next_delay_ms),
  };
}

export function writeRunEvent(filePath: string, event: Record<string, unknown>): RunEventRecord {
  const record = sanitizeRunEvent(event);
  writeJsonlRecord(filePath, record as unknown as Record<string, unknown>);
  return record;
}

export function toRunStateEventSummary(record: RunEventRecord): RunStateEventSummary {
  return {
    phase: record.phase,
    eventType: record.event_type,
    timestamp: record.timestamp,
    throttleBucketKey: record.throttle_bucket_key,
    stableKey: record.stable_key,
    sourceId: record.source_id,
    sourcePreview: record.source_preview,
    sourceLang: record.source_lang,
    targetLanguage: record.target_language,
    participantId: record.participant_id,
    participantModelId: record.participant_model_id,
    provider: record.provider,
    attempt: record.attempt,
    maxAttempts: record.max_attempts,
    latencyMs: record.latency_ms,
    errorClass: record.error_class,
    errorSummary: record.error_summary,
    rawErrorMessage: record.raw_error_message,
    nextDelayMs: record.next_delay_ms,
  };
}

export function renderRunEvent(record: RunEventRecord): string {
  const parts = [`${record.phase} ${record.event_type}`];

  if (record.throttle_bucket_key !== null) {
    parts.push(`bucket ${record.throttle_bucket_key}`);
  }

  if (record.participant_id !== null) {
    parts.push(`participant ${record.participant_id}`);
  }

  if (record.provider !== null || record.participant_model_id !== null) {
    parts.push(`provider ${record.provider ?? '-'}${record.participant_model_id ? `/${record.participant_model_id}` : ''}`);
  }

  if (record.source_id !== null) {
    parts.push(`source ${record.source_id}`);
  }

  if (record.source_lang !== null) {
    parts.push(`source_lang ${record.source_lang}`);
  }

  if (record.target_language !== null) {
    parts.push(`target ${record.target_language}`);
  }

  if (record.stable_key !== null) {
    parts.push(`stable ${record.stable_key}`);
  }

  if (record.attempt !== null && record.max_attempts !== null) {
    parts.push(`attempt ${record.attempt}/${record.max_attempts}`);
  }

  if (record.error_class !== null) {
    parts.push(`class ${record.error_class}`);
  }

  if (record.next_delay_ms !== null) {
    parts.push(`next ${record.next_delay_ms}ms`);
  }

  return parts.join(' | ');
}

export function writeRunStateSnapshot(filePath: string, snapshot: RunStateSnapshot): void {
  fs.writeFileSync(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function createCoalescedRunStateWriter(input: {
  filePath: string;
  now?: () => number;
  writeSnapshot?: (filePath: string, snapshot: RunStateSnapshot) => void;
}) {
  const now = input.now ?? Date.now;
  const writeSnapshot = input.writeSnapshot ?? writeRunStateSnapshot;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let pendingSnapshot: RunStateSnapshot | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const commit = (snapshot: RunStateSnapshot) => {
    writeSnapshot(input.filePath, snapshot);
    lastWriteAt = now();
  };

  const clearFlushTimer = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const scheduleFlush = () => {
    if (flushTimer !== null) {
      return;
    }

    const delayMs = Math.max(0, 1_000 - (now() - lastWriteAt));
    flushTimer = setTimeout(() => {
      flushTimer = null;

      if (pendingSnapshot !== null) {
        const snapshot = pendingSnapshot;
        pendingSnapshot = null;
        commit(snapshot);
      }
    }, delayMs);
    (flushTimer as { unref?: () => void }).unref?.();
  };

  return {
    update(snapshot: RunStateSnapshot) {
      pendingSnapshot = snapshot;

      if (!Number.isFinite(lastWriteAt) || now() - lastWriteAt >= 1_000) {
        clearFlushTimer();
        const nextSnapshot = pendingSnapshot;
        pendingSnapshot = null;

        if (nextSnapshot !== null) {
          commit(nextSnapshot);
        }

        return;
      }

      scheduleFlush();
    },
    flush() {
      clearFlushTimer();

      if (pendingSnapshot !== null) {
        const snapshot = pendingSnapshot;
        pendingSnapshot = null;
        commit(snapshot);
      }
    },
  };
}
