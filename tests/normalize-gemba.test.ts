import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeJudgeFailure,
  normalizeJudgeResponse,
} from '../src/normalize-gemba.js';

test('normalizeJudgeResponse stores no-error as empty errors array', () => {
  const record = normalizeJudgeResponse({
    rawJsonText: '{"has_no_error":true,"errors":[]}',
    runId: 'run-1',
    sourceId: '1',
    targetLanguage: 'ja',
    participantId: 'qwen-3.5-plus',
    participantModelId: 'qwen3.5-plus',
    judgeModelId: 'gemini-2.5-flash',
  });

  assert.equal(record.status, 'ok');
  assert.deepEqual(record.errors, []);
  assert.equal(record.summary?.total_penalty, 0);
});

test('normalizeJudgeResponse preserves populated error lists and computes summary fields', () => {
  const rawJsonText = JSON.stringify({
    has_no_error: false,
    errors: [
      {
        severity: 'critical',
        class: 'accuracy/mistranslation',
        target_span_text: '猫',
        source_span_text: 'cat',
        explanation: 'Meaning changed.',
      },
      {
        severity: 'major',
        class: 'fluency/grammar',
        target_span_text: '走る',
        source_span_text: null,
        explanation: 'Grammar issue.',
      },
      {
        severity: 'minor',
        class: 'style/awkward',
        target_span_text: null,
        source_span_text: 'runs',
        explanation: 'Awkward phrasing.',
      },
    ],
  });

  const record = normalizeJudgeResponse({
    rawJsonText,
    runId: 'run-2',
    sourceId: '2',
    targetLanguage: 'zh-Hans',
    participantId: 'gemini-1.5-pro',
    participantModelId: 'gemini-1.5-pro-002',
    judgeModelId: 'gemini-2.5-flash',
  });

  assert.equal(record.status, 'ok');
  assert.deepEqual(record.summary, {
    has_no_error: false,
    critical_count: 1,
    major_count: 1,
    minor_count: 1,
    total_penalty: 31,
  });
  assert.equal(record.stable_key, 'run-2::2::zh-Hans::gemini-1.5-pro');
});

test('normalizeJudgeResponse accepts judge errors without explanations', () => {
  const rawJsonText = JSON.stringify({
    has_no_error: false,
    errors: [
      {
        severity: 'major',
        class: 'accuracy/mistranslation',
        target_span_text: 'writing',
        source_span_text: '써봐',
      },
    ],
    contextBehavior: 'missed_required_context',
  });

  const record = normalizeJudgeResponse({
    rawJsonText,
    runId: 'run-no-explanation',
    sourceId: 'ctx1',
    targetLanguage: 'en',
    participantId: 'deepseek-v4-flash',
    participantModelId: 'deepseek-v4-flash',
    judgeModelId: 'gemini-3.1-pro-preview',
    contextMetadata: {
      context_turn_count: 1,
      speaker_mode: 'single',
      context_expectation: 'use',
      primary_phenomenon: 'referent_resolution',
    },
  });

  assert.equal(record.status, 'ok');
  assert.equal(record.summary?.total_penalty, 5);
  assert.equal(record.errors[0]?.explanation, undefined);
  assert.equal(record.context_behavior, 'missed_required_context');
});

test('normalizeJudgeResponse preserves contextBehavior and context metadata', () => {
  const record = normalizeJudgeResponse({
    rawJsonText: JSON.stringify({
      has_no_error: true,
      errors: [],
      contextBehavior: 'used_correctly',
    }),
    runId: 'run-context-1',
    sourceId: 'ctx1',
    targetLanguage: 'en',
    participantId: 'gemini-3-flash',
    participantModelId: 'gemini-3-flash-preview',
    judgeModelId: 'gemini-2.5-flash',
    contextMetadata: {
      context_turn_count: 2,
      speaker_mode: 'dyadic',
      context_expectation: 'use',
      primary_phenomenon: 'referent_resolution',
    },
  });

  assert.equal(record.context_behavior, 'used_correctly');
  assert.equal(record.context_turn_count, 2);
  assert.equal(record.speaker_mode, 'dyadic');
  assert.equal(record.context_expectation, 'use');
  assert.equal(record.primary_phenomenon, 'referent_resolution');
});

test('normalizeJudgeResponse rejects unknown contextBehavior values', () => {
  assert.throws(() => normalizeJudgeResponse({
    rawJsonText: JSON.stringify({
      has_no_error: true,
      errors: [],
      contextBehavior: 'invented_behavior',
    }),
    runId: 'run-context-2',
    sourceId: 'ctx2',
    targetLanguage: 'en',
    participantId: 'gemini-3-flash',
    participantModelId: 'gemini-3-flash-preview',
    judgeModelId: 'gemini-2.5-flash',
  }), /contextBehavior/i);
});

test('normalizeJudgeResponse rejects missing contextBehavior when context expectation metadata is present', () => {
  assert.throws(() => normalizeJudgeResponse({
    rawJsonText: JSON.stringify({
      has_no_error: true,
      errors: [],
    }),
    runId: 'run-context-3',
    sourceId: 'ctx3',
    targetLanguage: 'ja',
    participantId: 'qwen-3.5-plus',
    participantModelId: 'qwen3.5-plus',
    judgeModelId: 'gemini-2.5-flash',
    contextMetadata: {
      context_turn_count: 1,
      speaker_mode: 'single',
      context_expectation: 'use',
      primary_phenomenon: 'ellipsis_completion',
    },
  }), /contextBehavior/i);
});

test('normalizeJudgeResponse allows any known contextBehavior when context expectation metadata is present', () => {
  const record = normalizeJudgeResponse({
    rawJsonText: JSON.stringify({
      has_no_error: true,
      errors: [],
      contextBehavior: 'ignored_irrelevant_context',
    }),
    runId: 'run-context-4',
    sourceId: 'ctx4',
    targetLanguage: 'ja',
    participantId: 'qwen-3.5-plus',
    participantModelId: 'qwen3.5-plus',
    judgeModelId: 'gemini-2.5-flash',
    contextMetadata: {
      context_turn_count: 3,
      speaker_mode: 'dyadic',
      context_expectation: 'use',
      primary_phenomenon: 'sense_disambiguation',
    },
  });

  assert.equal(record.status, 'ok');
  assert.equal(record.context_behavior, 'ignored_irrelevant_context');
  assert.equal(record.context_expectation, 'use');
});

test('normalizeJudgeResponse rejects malformed-but-parseable payloads', () => {
  assert.throws(() => normalizeJudgeResponse({
    rawJsonText: JSON.stringify({
      has_no_error: false,
      errors: [
        {
          severity: 'severe',
          class: 'accuracy/mistranslation',
          target_span_text: '猫',
          source_span_text: 'cat',
          explanation: 'Invalid severity should be rejected.',
        },
      ],
    }),
    runId: 'run-3',
    sourceId: '3',
    targetLanguage: 'ja',
    participantId: 'qwen-3.5-plus',
    participantModelId: 'qwen3.5-plus',
    judgeModelId: 'gemini-2.5-flash',
  }), /Invalid judge response payload/);
});

test('normalizeJudgeResponse rejects contradictory no-error payloads with findings', () => {
  assert.throws(() => normalizeJudgeResponse({
    rawJsonText: JSON.stringify({
      has_no_error: true,
      errors: [
        {
          severity: 'major',
          class: 'fluency/grammar',
          target_span_text: '走る',
          source_span_text: 'runs',
          explanation: 'Contradictory payload.',
        },
      ],
    }),
    runId: 'run-4',
    sourceId: '4',
    targetLanguage: 'en',
    participantId: 'gemini-3-flash',
    participantModelId: 'gemini-3-flash-preview',
    judgeModelId: 'gemini-2.5-flash',
  }), /Invalid judge response payload/);
});

test('normalizeJudgeResponse rejects contradictory payloads with has_no_error false and no findings', () => {
  assert.throws(() => normalizeJudgeResponse({
    rawJsonText: JSON.stringify({
      has_no_error: false,
      errors: [],
    }),
    runId: 'run-5',
    sourceId: '5',
    targetLanguage: 'ja',
    participantId: 'qwen-3.5-plus',
    participantModelId: 'qwen3.5-plus',
    judgeModelId: 'gemini-2.5-flash',
  }), /Invalid judge response payload/);
});

test('normalizeJudgeResponse rejects error objects with unexpected extra keys', () => {
  assert.throws(() => normalizeJudgeResponse({
    rawJsonText: JSON.stringify({
      has_no_error: false,
      errors: [
        {
          severity: 'major',
          class: 'fluency/grammar',
          target_span_text: '走る',
          source_span_text: 'runs',
          explanation: 'Unexpected metadata should be rejected.',
          extra_field: 'unexpected',
        },
      ],
    }),
    runId: 'run-6',
    sourceId: '6',
    targetLanguage: 'en',
    participantId: 'gemini-3-flash',
    participantModelId: 'gemini-3-flash-preview',
    judgeModelId: 'gemini-2.5-flash',
  }), /Invalid judge response payload/);
});

test('normalizeJudgeFailure emits judge_failed record', () => {
  const record = normalizeJudgeFailure({
    rawJudgeOutput: 'not-json',
    runId: 'run-1',
    sourceId: '1',
    targetLanguage: 'en',
    participantId: 'gemini-3-flash',
    participantModelId: 'gemini-3-flash-preview',
    judgeModelId: 'gemini-2.5-flash',
  });

  assert.equal(record.status, 'judge_failed');
  assert.equal(record.summary, null);
});

test('normalizeJudgeFailure preserves optional context metadata', () => {
  const record = normalizeJudgeFailure({
    rawJudgeOutput: 'not-json',
    runId: 'run-context-5',
    sourceId: 'ctx5',
    targetLanguage: 'en',
    participantId: 'gemini-3-flash',
    participantModelId: 'gemini-3-flash-preview',
    judgeModelId: 'gemini-2.5-flash',
    contextMetadata: {
      context_turn_count: 2,
      speaker_mode: 'dyadic',
      context_expectation: 'ignore',
      primary_phenomenon: 'topic_shift_independence',
    },
  });

  assert.equal(record.status, 'judge_failed');
  assert.equal(record.context_turn_count, 2);
  assert.equal(record.speaker_mode, 'dyadic');
  assert.equal(record.context_expectation, 'ignore');
  assert.equal(record.primary_phenomenon, 'topic_shift_independence');
});

test('normalizeJudgeFailure ignores malformed context metadata but preserves safe fields', () => {
  const record = normalizeJudgeFailure({
    rawJudgeOutput: 'not-json',
    runId: 'run-context-6',
    sourceId: 'ctx6',
    targetLanguage: 'en',
    participantId: 'gemini-3-flash',
    participantModelId: 'gemini-3-flash-preview',
    judgeModelId: 'gemini-2.5-flash',
    contextMetadata: {
      context_turn_count: 9,
      speaker_mode: 'dyadic',
      context_expectation: 'bogus',
      primary_phenomenon: 'topic_shift_independence',
    } as unknown as Parameters<typeof normalizeJudgeFailure>[0]['contextMetadata'],
  });

  assert.equal(record.status, 'judge_failed');
  assert.equal(record.context_turn_count, undefined);
  assert.equal(record.speaker_mode, 'dyadic');
  assert.equal(record.context_expectation, undefined);
  assert.equal(record.primary_phenomenon, 'topic_shift_independence');
});
