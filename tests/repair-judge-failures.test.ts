import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { repairJudgeFailures } from '../src/repair-judge-failures.js';
import {
  createRunLayout,
  readJsonlRecords,
  writeJsonlRecord,
} from '../src/run-artifacts.js';
import type { RunManifestV3Input } from '../src/run-artifacts.js';

const DATASET_FINGERPRINT = 'a'.repeat(64);
const PROMPT_FINGERPRINT = 'b'.repeat(64);

function createTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'repair-judge-failures-'));
}

function createManifest(): RunManifestV3Input {
  return {
    manifestVersion: 3,
    runId: 'run-repair',
    benchmarkId: 'gemba-mqm-context-v1',
    datasetVersion: 'runtime.json',
    datasetKind: 'context',
    datasetFingerprintSha256: DATASET_FINGERPRINT,
    judgeModelId: 'gemini-3.1-pro-preview',
    promptVersion: 'gemini.md',
    promptFingerprintSha256: PROMPT_FINGERPRINT,
    judgePromptVersion: 'gemba-mqm-context-v1',
    judgePromptSetId: 'gemba-mqm-context-v1',
    targetLanguages: ['en'],
    targetLanguageLabels: {
      en: 'English',
    },
    limitApplied: 1,
    participants: [
      {
        participantId: 'model-a',
        displayName: 'Model A',
        provider: 'gemini',
        providerModelId: 'gemini-3-flash-preview',
      },
    ],
    translationConcurrencyPerModel: 1,
    resume: false,
  };
}

test('repairJudgeFailures converts repairable judge_failed rows into ok rows and prunes failure artifacts', () => {
  const root = createTempRoot();

  try {
    const layout = createRunLayout(root, createManifest());

    writeJsonlRecord(layout.normalizedJudgeJsonlPath, {
      run_id: 'run-repair',
      source_id: 'ctx-ok',
      target_language: 'en',
      participant_id: 'model-a',
      participant_model_id: 'gemini-3-flash-preview',
      judge_model_id: 'gemini-3.1-pro-preview',
      status: 'judge_failed',
      errors: [],
      summary: null,
      raw_judge_output: '{"has_no_error":true,"errors":[],"contextBehavior":"used_correctly"}',
      stable_key: 'run-repair::ctx-ok::en::model-a',
      context_turn_count: 1,
      speaker_mode: 'single',
      context_expectation: 'ignore',
      primary_phenomenon: 'topic_shift_independence',
    });
    writeJsonlRecord(layout.failuresJsonlPath, {
      stable_key: 'run-repair::ctx-ok::en::model-a',
      source_id: 'ctx-ok',
      target_language: 'en',
      participant_id: 'model-a',
      participant_model_id: 'gemini-3-flash-preview',
      error: 'TypeError: Invalid judge response payload: contextBehavior used_correctly is incompatible with contextExpectation ignore',
      raw_judge_output: '{"has_no_error":true,"errors":[],"contextBehavior":"used_correctly"}',
    });

    writeJsonlRecord(layout.normalizedJudgeJsonlPath, {
      run_id: 'run-repair',
      source_id: 'ctx-still-bad',
      target_language: 'en',
      participant_id: 'model-a',
      participant_model_id: 'gemini-3-flash-preview',
      judge_model_id: 'gemini-3.1-pro-preview',
      status: 'judge_failed',
      errors: [],
      summary: null,
      raw_judge_output: '{"has_no_error":true,"errors":[]}',
      stable_key: 'run-repair::ctx-still-bad::en::model-a',
      context_turn_count: 1,
      speaker_mode: 'single',
      context_expectation: 'ignore',
      primary_phenomenon: 'topic_shift_independence',
    });
    writeJsonlRecord(layout.failuresJsonlPath, {
      stable_key: 'run-repair::ctx-still-bad::en::model-a',
      source_id: 'ctx-still-bad',
      target_language: 'en',
      participant_id: 'model-a',
      participant_model_id: 'gemini-3-flash-preview',
      error: 'TypeError: Invalid judge response payload: contextBehavior is required when context_expectation metadata is present',
      raw_judge_output: '{"has_no_error":true,"errors":[]}',
    });

    const result = repairJudgeFailures(layout, { backupLabel: 'test-backup' });

    assert.equal(result.repairedCount, 1);
    assert.equal(result.remainingFailureCount, 1);
    if (result.backupPaths === null) {
      assert.fail('expected backup paths when repairs are applied');
    }
    assert.equal(existsSync(result.backupPaths.normalizedJudgePath), true);
    assert.equal(existsSync(result.backupPaths.failurePath), true);

    const normalized = readJsonlRecords<Array<Record<string, unknown>>[number]>(layout.normalizedJudgeJsonlPath);
    assert.equal(normalized.length, 2);
    assert.equal(normalized[0]?.status, 'ok');
    assert.equal(normalized[0]?.context_behavior, 'used_correctly');
    assert.equal(normalized[1]?.status, 'judge_failed');

    const failures = readJsonlRecords<Array<Record<string, unknown>>[number]>(layout.failuresJsonlPath);
    assert.deepEqual(failures.map((record) => record.stable_key), ['run-repair::ctx-still-bad::en::model-a']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repairJudgeFailures reports remaining failures from normalized rows and prunes stale failure artifacts', () => {
  const root = createTempRoot();

  try {
    const layout = createRunLayout(root, createManifest());

    writeJsonlRecord(layout.normalizedJudgeJsonlPath, {
      run_id: 'run-repair',
      source_id: 'ctx-repairable',
      target_language: 'en',
      participant_id: 'model-a',
      participant_model_id: 'gemini-3-flash-preview',
      judge_model_id: 'gemini-3.1-pro-preview',
      status: 'judge_failed',
      errors: [],
      summary: null,
      raw_judge_output: '{"has_no_error":true,"errors":[],"contextBehavior":"used_correctly"}',
      stable_key: 'run-repair::ctx-repairable::en::model-a',
      context_turn_count: 1,
      speaker_mode: 'single',
      context_expectation: 'ignore',
      primary_phenomenon: 'topic_shift_independence',
    });
    writeJsonlRecord(layout.failuresJsonlPath, {
      stable_key: 'run-repair::ctx-repairable::en::model-a',
      source_id: 'ctx-repairable',
      target_language: 'en',
      participant_id: 'model-a',
      participant_model_id: 'gemini-3-flash-preview',
      error: 'TypeError: repairable',
      raw_judge_output: '{"has_no_error":true,"errors":[],"contextBehavior":"used_correctly"}',
    });

    writeJsonlRecord(layout.normalizedJudgeJsonlPath, {
      run_id: 'run-repair',
      source_id: 'ctx-still-failed',
      target_language: 'en',
      participant_id: 'model-a',
      participant_model_id: 'gemini-3-flash-preview',
      judge_model_id: 'gemini-3.1-pro-preview',
      status: 'judge_failed',
      errors: [],
      summary: null,
      raw_judge_output: '{"has_no_error":true,"errors":[]}',
      stable_key: 'run-repair::ctx-still-failed::en::model-a',
      context_turn_count: 1,
      speaker_mode: 'single',
      context_expectation: 'ignore',
      primary_phenomenon: 'topic_shift_independence',
    });

    writeJsonlRecord(layout.failuresJsonlPath, {
      stable_key: 'run-repair::stale::en::model-a',
      source_id: 'stale',
      target_language: 'en',
      participant_id: 'model-a',
      participant_model_id: 'gemini-3-flash-preview',
      error: 'stale failure artifact',
      raw_judge_output: 'stale',
    });

    const result = repairJudgeFailures(layout, { backupLabel: 'stale-prune' });

    assert.equal(result.repairedCount, 1);
    assert.equal(result.remainingFailureCount, 1);

    const failures = readJsonlRecords<Array<Record<string, unknown>>[number]>(layout.failuresJsonlPath);
    assert.deepEqual(failures, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repairJudgeFailures tolerates a missing judge-failures artifact file', () => {
  const root = createTempRoot();

  try {
    const layout = createRunLayout(root, createManifest());
    unlinkSync(layout.failuresJsonlPath);

    writeJsonlRecord(layout.normalizedJudgeJsonlPath, {
      run_id: 'run-repair',
      source_id: 'ctx-repairable',
      target_language: 'en',
      participant_id: 'model-a',
      participant_model_id: 'gemini-3-flash-preview',
      judge_model_id: 'gemini-3.1-pro-preview',
      status: 'judge_failed',
      errors: [],
      summary: null,
      raw_judge_output: '{"has_no_error":true,"errors":[],"contextBehavior":"used_correctly"}',
      stable_key: 'run-repair::ctx-repairable::en::model-a',
      context_turn_count: 1,
      speaker_mode: 'single',
      context_expectation: 'ignore',
      primary_phenomenon: 'topic_shift_independence',
    });

    const result = repairJudgeFailures(layout, { backupLabel: 'missing-failure-file' });

    assert.equal(result.repairedCount, 1);
    assert.notEqual(result.backupPaths, null);
    if (result.backupPaths === null) {
      assert.fail('expected backup paths when repairs are applied');
    }
    assert.equal(existsSync(result.backupPaths.failurePath), true);
    assert.equal(readFileSync(result.backupPaths.failurePath, 'utf8'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
