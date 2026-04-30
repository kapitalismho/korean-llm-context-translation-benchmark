import { readFileSync } from 'node:fs';

import type { BenchmarkTestCase } from './llm-client.js';
import {
  CONTEXT_EXPECTATIONS,
  CONTEXT_TURN_COUNTS,
  PRIMARY_PHENOMENA,
  SECONDARY_PHENOMENA,
  SPEAKER_MODES,
  SPEAKER_ROLES,
  type ContextInternalSample,
  type ContextRuntimeSample,
  type ContextTurn,
  type ContextTurnCount,
  type PrimaryPhenomenon,
  type SecondaryPhenomenon,
  type SpeakerMode,
  type SpeakerRole,
} from './context-benchmark-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasAllowedValue<T extends readonly string[] | readonly number[]>(
  allowedValues: T,
  value: unknown,
): value is T[number] {
  return (allowedValues as readonly unknown[]).includes(value);
}

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${fieldName} is required`);
  }
}

function assertContextTurn(value: unknown, fieldName: string): asserts value is ContextTurn {
  if (!isRecord(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }

  if (!hasAllowedValue(SPEAKER_ROLES, value.speakerRole)) {
    throw new TypeError(`${fieldName}.speakerRole is invalid`);
  }

  if (
    value.relativeTimeLabel !== undefined
    && value.relativeTimeLabel !== null
    && typeof value.relativeTimeLabel !== 'string'
  ) {
    throw new TypeError(`${fieldName}.relativeTimeLabel must be a string, null, or omitted`);
  }

  assertNonEmptyString(value.sourceText, `${fieldName}.sourceText`);
}

function assertUniqueContextSampleIds(samples: readonly ContextRuntimeSample[]): void {
  const seen = new Set<string>();

  for (const sample of samples) {
    if (seen.has(sample.sampleId)) {
      throw new TypeError(`Context runtime dataset contains duplicate sampleId: ${sample.sampleId}`);
    }

    seen.add(sample.sampleId);
  }
}

export function isContextRuntimeSample(value: BenchmarkTestCase): value is ContextRuntimeSample {
  return 'sampleId' in value && 'contextTurnCount' in value && 'contextTurns' in value;
}

export function assertContextRuntimeSample(value: unknown): asserts value is ContextRuntimeSample {
  if (!isRecord(value)) {
    throw new TypeError('Context runtime sample must be an object');
  }

  if (typeof value.sampleId !== 'string') {
    throw new TypeError('sampleId is required');
  }

  if (!hasAllowedValue(CONTEXT_TURN_COUNTS, value.contextTurnCount)) {
    throw new TypeError('contextTurnCount is invalid');
  }

  if (!hasAllowedValue(SPEAKER_MODES, value.speakerMode)) {
    throw new TypeError('speakerMode is invalid');
  }

  if (!hasAllowedValue(CONTEXT_EXPECTATIONS, value.contextExpectation)) {
    throw new TypeError('contextExpectation is invalid');
  }

  if (!hasAllowedValue(PRIMARY_PHENOMENA, value.primaryPhenomenon)) {
    throw new TypeError('primaryPhenomenon is invalid');
  }

  if (!Array.isArray(value.secondaryPhenomena)) {
    throw new TypeError('secondaryPhenomena must be an array');
  }

  for (const tag of value.secondaryPhenomena) {
    if (!hasAllowedValue(SECONDARY_PHENOMENA, tag)) {
      throw new TypeError('secondaryPhenomena contains an unsupported tag');
    }
  }

  if (!Array.isArray(value.contextTurns) || value.contextTurns.length !== value.contextTurnCount) {
    throw new TypeError('contextTurns must match contextTurnCount');
  }

  value.contextTurns.forEach((turn, index) => {
    assertContextTurn(turn, `contextTurns[${index}]`);
  });
  assertContextTurn(value.currentSource, 'currentSource');

  if (value.currentSource.speakerRole !== 'self') {
    throw new TypeError('currentSource.speakerRole must be self in v1 because current input is rendered without helper metadata');
  }

  if (value.currentSource.relativeTimeLabel !== undefined && value.currentSource.relativeTimeLabel !== null) {
    throw new TypeError('currentSource.relativeTimeLabel must be null or omitted in v1');
  }

  const allTurns = [...value.contextTurns, value.currentSource];

  if (value.speakerMode === 'single') {
    const uniqueRoles = new Set(allTurns.map((turn) => turn.speakerRole));

    if (uniqueRoles.size !== 1) {
      throw new TypeError('single speakerMode samples must use exactly one speakerRole across all turns');
    }
  }

  if (value.speakerMode === 'dyadic') {
    const roles = new Set(allTurns.map((turn) => turn.speakerRole));

    if (!roles.has('self') || !roles.has('other')) {
      throw new TypeError('dyadic speakerMode samples must include both self and other across contextTurns and currentSource');
    }
  }
}

export function loadContextRuntimeDataset(filePath: string): ContextRuntimeSample[] {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;

  if (!Array.isArray(parsed)) {
    throw new TypeError('Context runtime dataset must be an array');
  }

  parsed.forEach(assertContextRuntimeSample);
  assertUniqueContextSampleIds(parsed);
  return parsed;
}

export function loadContextInternalDataset(filePath: string): ContextInternalSample[] {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;

  if (!Array.isArray(parsed)) {
    throw new TypeError('Context internal dataset must be an array');
  }

  parsed.forEach((item) => {
    assertContextRuntimeSample(item);
    const internalItem = item as ContextInternalSample;

    if (!Array.isArray(internalItem.relevantContextIndices)) {
      throw new TypeError('relevantContextIndices must be an array');
    }

    for (const index of internalItem.relevantContextIndices) {
      if (!Number.isInteger(index)) {
        throw new TypeError('relevantContextIndices must contain only integers');
      }

      if (index < 0 || index >= internalItem.contextTurns.length) {
        throw new TypeError('relevantContextIndices must reference existing contextTurns');
      }
    }

    assertNonEmptyString(internalItem.intendedInterpretation, 'intendedInterpretation');

    if (!Array.isArray(internalItem.commonFailureModes) || internalItem.commonFailureModes.length === 0) {
      throw new TypeError('commonFailureModes must contain at least one item');
    }

    internalItem.commonFailureModes.forEach((failureMode, index) => {
      assertNonEmptyString(failureMode, `commonFailureModes[${index}]`);
    });

    assertNonEmptyString(internalItem.validationNotes, 'validationNotes');
  });

  return parsed as ContextInternalSample[];
}
