import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBenchmarkReports } from '../src/reporting.js';

test('buildBenchmarkReports returns per-language leaderboard, breakdowns, and failure counts', () => {
  const reports = buildBenchmarkReports(
    [
      {
        run_id: 'run-1',
        source_id: '1',
        target_language: 'en',
        participant_id: 'model-a',
        participant_model_id: 'model-a',
        judge_model_id: 'judge-model',
        status: 'ok',
        errors: [],
        summary: {
          has_no_error: true,
          critical_count: 0,
          major_count: 0,
          minor_count: 0,
          total_penalty: 0,
        },
        raw_judge_output: '{"has_no_error":true,"errors":[]}',
        stable_key: 'run-1::1::en::model-a',
      },
      {
        run_id: 'run-1',
        source_id: '1',
        target_language: 'en',
        participant_id: 'model-b',
        participant_model_id: 'model-b',
        judge_model_id: 'judge-model',
        status: 'judge_failed',
        errors: [],
        summary: null,
        raw_judge_output: 'bad-json',
        stable_key: 'run-1::1::en::model-b',
      },
    ],
    ['model-a', 'model-b'],
  );

  assert.equal(reports.byLanguage.en.leaderboard[0].participant_id, 'model-a');
  assert.equal(reports.byLanguage.en.failures[0].participant_id, 'model-b');
  assert.ok(Array.isArray(reports.summaryOverallNormalized));
});

test('buildBenchmarkReports emits context slice tables, raw penalty summaries, and participant context behavior rates', () => {
  const reports = buildBenchmarkReports(
    [
      {
        run_id: 'run-1',
        source_id: 'ctx1-dyadic-use-referent_resolution-001',
        target_language: 'en',
        participant_id: 'model-a',
        participant_model_id: 'model-a',
        judge_model_id: 'judge-model',
        status: 'ok',
        errors: [],
        summary: {
          has_no_error: true,
          critical_count: 0,
          major_count: 0,
          minor_count: 0,
          total_penalty: 0,
        },
        raw_judge_output: '{"has_no_error":true,"errors":[],"contextBehavior":"used_correctly"}',
        stable_key: 'run-1::ctx1-dyadic-use-referent_resolution-001::en::model-a',
        context_behavior: 'used_correctly',
        context_turn_count: 1,
        speaker_mode: 'dyadic',
        context_expectation: 'use',
        primary_phenomenon: 'referent_resolution',
      },
      {
        run_id: 'run-1',
        source_id: 'ctx2-single-use-register_carryover-001',
        target_language: 'ja',
        participant_id: 'model-a',
        participant_model_id: 'model-a',
        judge_model_id: 'judge-model',
        status: 'ok',
        errors: [
          {
            severity: 'major',
            class: 'fluency/register',
            target_span_text: null,
            source_span_text: null,
            explanation: 'Missed register carryover.',
          },
        ],
        summary: {
          has_no_error: false,
          critical_count: 0,
          major_count: 1,
          minor_count: 0,
          total_penalty: 5,
        },
        raw_judge_output: '{"has_no_error":false,"errors":[],"contextBehavior":"missed_required_context"}',
        stable_key: 'run-1::ctx2-single-use-register_carryover-001::ja::model-a',
        context_behavior: 'missed_required_context',
        context_turn_count: 2,
        speaker_mode: 'single',
        context_expectation: 'use',
        primary_phenomenon: 'register_carryover',
      },
      {
        run_id: 'run-1',
        source_id: 'ctx3-dyadic-ignore-false_lead_trap-001',
        target_language: 'zh-Hans',
        participant_id: 'model-a',
        participant_model_id: 'model-a',
        judge_model_id: 'judge-model',
        status: 'ok',
        errors: [
          {
            severity: 'minor',
            class: 'accuracy/mistranslation',
            target_span_text: null,
            source_span_text: null,
            explanation: 'Overused stale context.',
          },
        ],
        summary: {
          has_no_error: false,
          critical_count: 0,
          major_count: 0,
          minor_count: 1,
          total_penalty: 1,
        },
        raw_judge_output: '{"has_no_error":false,"errors":[],"contextBehavior":"misused_context"}',
        stable_key: 'run-1::ctx3-dyadic-ignore-false_lead_trap-001::zh-Hans::model-a',
        context_behavior: 'misused_context',
        context_turn_count: 3,
        speaker_mode: 'dyadic',
        context_expectation: 'ignore',
        primary_phenomenon: 'false_lead_trap',
      },
      {
        run_id: 'run-1',
        source_id: 'ctx1-single-ignore-topic_shift_independence-001',
        target_language: 'en',
        participant_id: 'model-a',
        participant_model_id: 'model-a',
        judge_model_id: 'judge-model',
        status: 'ok',
        errors: [],
        summary: {
          has_no_error: true,
          critical_count: 0,
          major_count: 0,
          minor_count: 0,
          total_penalty: 0,
        },
        raw_judge_output: '{"has_no_error":true,"errors":[],"contextBehavior":"ignored_irrelevant_context"}',
        stable_key: 'run-1::ctx1-single-ignore-topic_shift_independence-001::en::model-a',
        context_behavior: 'ignored_irrelevant_context',
        context_turn_count: 1,
        speaker_mode: 'single',
        context_expectation: 'ignore',
        primary_phenomenon: 'topic_shift_independence',
      },
      {
        run_id: 'run-1',
        source_id: 'ctx2-dyadic-use-pragmatic_intent_resolution-001',
        target_language: 'en',
        participant_id: 'model-b',
        participant_model_id: 'model-b',
        judge_model_id: 'judge-model',
        status: 'judge_failed',
        errors: [],
        summary: null,
        raw_judge_output: 'bad-json',
        stable_key: 'run-1::ctx2-dyadic-use-pragmatic_intent_resolution-001::en::model-b',
        context_turn_count: 2,
        speaker_mode: 'dyadic',
        context_expectation: 'use',
        primary_phenomenon: 'pragmatic_intent_resolution',
      },
    ],
    ['model-a', 'model-b'],
  );

  assert.deepEqual(reports.summaryOverallPenalty, [
    {
      participant_id: 'model-a',
      participant_display_name: 'model-a',
      mean_penalty: 1.5,
    },
    {
      participant_id: 'model-b',
      participant_display_name: 'model-b',
      mean_penalty: null,
    },
  ]);
  assert.equal(reports.byContextTurnCount['1']?.[0]?.participant_id, 'model-a');
  assert.equal(reports.byContextTurnCount['1']?.[0]?.samples, 2);
  assert.equal(reports.bySpeakerMode.single?.[0]?.samples, 2);
  assert.equal(reports.byContextTurnCountAndSpeakerMode['1::single']?.[0]?.samples, 1);
  assert.equal(reports.byPrimaryPhenomenon.referent_resolution?.[0]?.mean_penalty, 0);
  assert.equal(reports.byContextExpectation.use?.[0]?.samples, 2);
  assert.deepEqual(reports.contextBehavior['model-a'], {
    used_correctly: 1,
    missed_required_context: 1,
    ignored_irrelevant_context: 1,
    misused_context: 1,
    unclear: 0,
  });
  assert.deepEqual(reports.contextBehaviorRates['model-a'], {
    missed_required_context_rate: 0.5,
    misused_context_rate: 0.5,
  });
});

test('buildBenchmarkReports respects provided target language set', () => {
  const reports = buildBenchmarkReports(
    [
      {
        run_id: 'run-1',
        source_id: '1',
        target_language: 'en',
        participant_id: 'model-a',
        participant_model_id: 'model-a',
        judge_model_id: 'judge-model',
        status: 'ok',
        errors: [],
        summary: {
          has_no_error: true,
          critical_count: 0,
          major_count: 0,
          minor_count: 0,
          total_penalty: 0,
        },
        raw_judge_output: '{"has_no_error":true,"errors":[]}',
        stable_key: 'run-1::1::en::model-a',
      },
    ],
    ['model-a'],
    ['en'],
  );

  assert.deepEqual(Object.keys(reports.byLanguage), ['en']);
});

test('buildBenchmarkReports preserves the supplied participant order for leaderboard and summary rows', () => {
  const reports = buildBenchmarkReports(
    [
      {
        run_id: 'run-1',
        source_id: '1',
        target_language: 'en',
        participant_id: 'model-a',
        participant_model_id: 'shared-model',
        judge_model_id: 'judge-model',
        status: 'ok',
        errors: [],
        summary: {
          has_no_error: true,
          critical_count: 0,
          major_count: 0,
          minor_count: 0,
          total_penalty: 0,
        },
        raw_judge_output: '{"has_no_error":true,"errors":[]}',
        stable_key: 'run-1::1::en::model-a',
      },
      {
        run_id: 'run-1',
        source_id: '1',
        target_language: 'en',
        participant_id: 'model-b',
        participant_model_id: 'shared-model',
        judge_model_id: 'judge-model',
        status: 'ok',
        errors: [],
        summary: {
          has_no_error: false,
          critical_count: 0,
          major_count: 0,
          minor_count: 5,
          total_penalty: 5,
        },
        raw_judge_output: '{"has_no_error":false,"errors":[]}',
        stable_key: 'run-1::1::en::model-b',
      },
    ],
    ['model-b', 'model-a'],
    ['en'],
  );

  assert.deepEqual(
    reports.byLanguage.en.leaderboard.map((row) => row.participant_id),
    ['model-b', 'model-a'],
  );
  assert.deepEqual(
    reports.summaryOverallPenalty.map((row) => row.participant_id),
    ['model-b', 'model-a'],
  );
  assert.deepEqual(
    reports.summaryOverallNormalized.map((row) => row.participant_id),
    ['model-b', 'model-a'],
  );
});
