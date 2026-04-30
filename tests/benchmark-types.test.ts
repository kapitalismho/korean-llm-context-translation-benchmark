import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MQM_ERROR_CLASSES,
  buildStableKey,
  computePenalty,
  countBySeverity,
} from '../src/benchmark-types.js';
import * as benchmarkTypesModule from '../src/benchmark-types.js';
import type { JudgeSeverity } from '../src/benchmark-types.js';
import {
  toTargetLanguageCode,
  toTargetLanguageLabel,
} from '../src/languages.js';

type SeverityItem = {
  severity: JudgeSeverity;
};

type SeverityItems = ReadonlyArray<SeverityItem>;

type Expect<T extends true> = T;

type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? ((<T>() => T extends B ? 1 : 2) extends
      (<T>() => T extends A ? 1 : 2)
        ? true
        : false)
    : false;

type _ComputePenaltyAcceptsArray = Expect<
  IsEqual<NonNullable<Parameters<typeof computePenalty>[0]>, SeverityItems>
>;

type _CountBySeverityAcceptsArray = Expect<
  IsEqual<NonNullable<Parameters<typeof countBySeverity>[0]>, SeverityItems>
>;

const SUPPORTED_LANGUAGE_MAPPINGS = [
  {
    label: 'English',
    code: 'en',
  },
  {
    label: 'Japanese',
    code: 'ja',
  },
  {
    label: 'Chinese Simplified',
    code: 'zh-Hans',
  },
] as const;

test('computePenalty applies GEMBA severity weights: critical+major+minor => 31', () => {
  assert.equal(computePenalty([
    {
      severity: 'critical',
    },
    {
      severity: 'major',
    },
    {
      severity: 'minor',
    },
  ]), 31);
});

test('stable key uses run, source, language code, and participant id', () => {
  assert.equal(
    buildStableKey('run-001', 17, 'zh-Hans', 'qwen-3.5-plus'),
    'run-001::17::zh-Hans::qwen-3.5-plus',
  );
});

test('language mappings round-trip for all supported labels and codes', () => {
  for (const mapping of SUPPORTED_LANGUAGE_MAPPINGS) {
    assert.equal(toTargetLanguageCode(mapping.label), mapping.code);
    assert.equal(toTargetLanguageLabel(mapping.code), mapping.label);
  }
});

test('unsupported language labels and codes throw errors', () => {
  assert.throws(() => toTargetLanguageCode('toString'), {
    message: 'Unsupported target language label: toString',
  });

  assert.throws(() => toTargetLanguageLabel('toString' as Parameters<typeof toTargetLanguageLabel>[0]), {
    message: 'Unsupported target language code: toString',
  });
});

test('mqm class inventory is fixed and includes accuracy/untranslated text and non-translation', () => {
  assert.deepEqual(MQM_ERROR_CLASSES, [
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
  ]);
});

test('context behavior inventory is fixed', () => {
  assert.deepEqual(
    (benchmarkTypesModule as Record<string, unknown>).CONTEXT_BEHAVIORS,
    [
      'used_correctly',
      'missed_required_context',
      'ignored_irrelevant_context',
      'misused_context',
      'unclear',
    ],
  );
});

test('countBySeverity is zero-safe and returns { critical: 0, major: 1, minor: 0 }', () => {
  assert.deepEqual(countBySeverity([
    {
      severity: 'major',
    },
  ]), {
    critical: 0,
    major: 1,
    minor: 0,
  });
});
