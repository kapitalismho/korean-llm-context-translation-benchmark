import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readJsonlRecords } from '../src/run-artifacts.js';
import {
  redactErrorMessage,
  sanitizePersistedErrorText,
  truncatePreview,
  writeRunEvent,
  writeRunStateSnapshot,
} from '../src/run-observability.js';

test('redactErrorMessage removes bearer tokens and auth headers', () => {
  const redacted = redactErrorMessage('Authorization: Bearer fixture-123');

  assert.match(redacted, /Bearer \*\*\*/);
  assert.doesNotMatch(redacted, /fixture-123/);
});

test('redactErrorMessage removes quoted JSON credential fields', () => {
  const redacted = redactErrorMessage('{"x-api-key":"secret-1","apiKey":"secret-2","nested":{"api_key":"secret-3"},"authorization":"Basic fixture-value","authorization_two":"leave-me"}');

  assert.match(redacted, /"x-api-key":"\*\*\*"/i);
  assert.match(redacted, /"apiKey":"\*\*\*"/);
  assert.match(redacted, /"api_key":"\*\*\*"/i);
  assert.match(redacted, /"authorization":"\*\*\*"/i);
  assert.doesNotMatch(redacted, /secret-1/);
  assert.doesNotMatch(redacted, /secret-2/);
  assert.doesNotMatch(redacted, /secret-3/);
  assert.doesNotMatch(redacted, /fixture-value/);
  assert.match(redacted, /"authorization_two":"leave-me"/);
});

test('sanitizePersistedErrorText redacts request bodies and system prompts before persistence', () => {
  const sanitized = sanitizePersistedErrorText([
    'request body: {"messages":[{"role":"system","content":"do not persist this prompt"}]}',
    'system prompt: translate everything literally',
  ].join('\n'));

  assert.match(sanitized, /request body: \[redacted\]/i);
  assert.match(sanitized, /system prompt: \[redacted\]/i);
  assert.doesNotMatch(sanitized, /do not persist this prompt/);
  assert.doesNotMatch(sanitized, /translate everything literally/);
});

test('sanitizePersistedErrorText redacts multiline prompt sections without leaking inner label-like lines', () => {
  const sanitized = sanitizePersistedErrorText([
    'system prompt: translate everything literally',
    'tone: formal',
    'style: concise',
  ].join('\n'));

  assert.match(sanitized, /system prompt: \[redacted\]/i);
  assert.doesNotMatch(sanitized, /tone: formal/);
  assert.doesNotMatch(sanitized, /style: concise/);
});

test('sanitizePersistedErrorText redacts pretty-printed object payloads and preserves following fields', () => {
  const sanitized = sanitizePersistedErrorText([
    'request body: {',
    '  "messages": [',
    '    {',
    '      "role": "system",',
    '      "content": "do not persist this prompt"',
    '    }',
    '  ],',
    '  "metadata": {',
    '    "foo": "bar"',
    '  }',
    '}',
    'provider code: 429',
  ].join('\n'));

  assert.match(sanitized, /request body: \[redacted\]/i);
  assert.match(sanitized, /provider code: 429/i);
  assert.doesNotMatch(sanitized, /"messages"/);
  assert.doesNotMatch(sanitized, /do not persist this prompt/);
  assert.doesNotMatch(sanitized, /"foo": "bar"/);
});

test('redactErrorMessage redacts object-valued request-body and system-prompt keys', () => {
  const redacted = redactErrorMessage('{"requestBody":{"messages":[{"content":"secret"}]},"systemPrompt":{"text":"hidden"}}');

  assert.match(redacted, /"requestBody":"\[redacted\]"/);
  assert.match(redacted, /"systemPrompt":"\[redacted\]"/);
  assert.doesNotMatch(redacted, /secret/);
  assert.doesNotMatch(redacted, /hidden/);
});

test('truncatePreview limits to 120 Unicode code points without splitting surrogate pairs', () => {
  const preview = truncatePreview(`${'😀'.repeat(120)}🙂trailing`);

  assert.equal(Array.from(preview).length, 120);
  assert.equal(preview, '😀'.repeat(120));
});

test('writeRunEvent redacts raw error text, truncates persisted output, and normalizes nullable fields', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'run-observability-events-'));
  const eventPath = join(tempDir, 'events.jsonl');

  try {
    writeRunEvent(eventPath, {
      scope: 'throttle_bucket',
      timestamp: '2026-04-18T10:00:00.000Z',
      phase: 'translation',
      event_type: 'throttle_bucket_cooldown_start',
      throttle_bucket_key: 'gemini::gemini-3-flash-preview',
      raw_error_message: `Authorization: Bearer ${['fixture', 'token'].join('-')}-${'x'.repeat(5000)}\nrequest body: {"systemPrompt":"leak-me"}`,
    });

    const records = readJsonlRecords<Array<Record<string, unknown>> extends infer _T ? Record<string, unknown> : never>(eventPath);
    const record = records[0];
    const rawErrorMessage = String(record?.raw_error_message ?? '');

    assert.equal(record?.scope, 'throttle_bucket');
    assert.equal(record?.stable_key, null);
    assert.equal(record?.source_id, null);
    assert.equal(record?.source_lang, null);
    assert.equal(record?.target_language, null);
    assert.equal(record?.participant_id, null);
    assert.equal(record?.participant_model_id, null);
    assert.equal(record?.provider, null);
    assert.match(rawErrorMessage, /Bearer \*\*\*/);
    assert.doesNotMatch(rawErrorMessage, /fixture-token/);
    assert.match(rawErrorMessage, /request body: \[redacted\]/i);
    assert.doesNotMatch(rawErrorMessage, /leak-me/);
    assert.equal(Array.from(rawErrorMessage).length <= 4000, true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('writeRunStateSnapshot persists camelCase run-state JSON', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'run-observability-state-'));
  const statePath = join(tempDir, 'run-state.json');

  try {
    writeRunStateSnapshot(statePath, {
      currentPhase: 'translation',
      updatedAt: '2026-04-18T10:00:00.000Z',
      overall: {
        completed: 3,
        succeeded: 2,
        failed: 1,
        retryCount: 4,
        cumulativeRetryCount: 4,
      },
      participants: [
        {
          participantId: 'gemini-3-flash',
          completed: 3,
          succeeded: 2,
          failed: 1,
          retryCount: 4,
          inflight: 0,
          remaining: 7,
        },
      ],
      throttleBuckets: [
        {
          throttleBucketKey: 'gemini::gemini-3-flash-preview',
          participantIds: ['gemini-3-flash'],
          inflight: 0,
          queued: 7,
          cooldownUntil: null,
        },
      ],
      inflightItems: [],
      recentFailures: [],
      recentRetries: [],
    });

    const snapshot = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;

    assert.equal(snapshot.currentPhase, 'translation');
    assert.equal(snapshot.updatedAt, '2026-04-18T10:00:00.000Z');
    assert.equal((snapshot.overall as { cumulativeRetryCount: number }).cumulativeRetryCount, 4);
    assert.equal('current_phase' in snapshot, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
