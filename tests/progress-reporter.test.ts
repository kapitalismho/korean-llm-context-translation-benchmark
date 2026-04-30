import assert from 'node:assert/strict';
import test from 'node:test';

import { createProgressReporter } from '../src/progress-reporter.js';

test('createProgressReporter emits overall summary and cumulative cost without active-worker text', () => {
  const lines: string[] = [];
  const reporter = createProgressReporter({
    phase: 'judge',
    total: 100,
    log: (line) => lines.push(line),
  });

  reporter.update({
    completed: 25,
    succeeded: 25,
    failed: 0,
    activeWorkers: 4,
    totalCostUsd: 1.23,
  });

  assert.match(lines[0] ?? '', /judge overall 25\/100/);
  assert.doesNotMatch(lines[0] ?? '', /active 4/);
  assert.match(lines[0] ?? '', /\$1\.23/);
});

test('createProgressReporter uses initialCompleted as the ETA baseline on resume', () => {
  const lines: string[] = [];
  let now = 0;
  const reporter = createProgressReporter({
    phase: 'translation',
    total: 100,
    log: (line) => lines.push(line),
    now: () => now,
  });

  reporter.update({
    completed: 40,
    succeeded: 40,
    failed: 0,
    activeWorkers: 0,
    totalCostUsd: 0,
    initialCompleted: 40,
  });

  now = 60_000;
  reporter.update({
    completed: 50,
    succeeded: 50,
    failed: 0,
    activeWorkers: 0,
    totalCostUsd: 0,
    initialCompleted: 40,
  });

  assert.match(lines.at(-1) ?? '', /ETA 5m/);
});

test('createProgressReporter uses the spec large-participant selection policy', () => {
  const lines: string[] = [];
  const reporter = createProgressReporter({
    phase: 'translation',
    total: 100,
    log: (line) => lines.push(line),
  });

  reporter.update({
    completed: 20,
    succeeded: 18,
    failed: 2,
    activeWorkers: 0,
    totalCostUsd: 1.23,
    participantSnapshots: [
      {
        participantId: 'shared',
        completed: 2,
        failed: 1,
        inflight: 1,
        retries: 3,
        remaining: 100,
        lastFailureAt: '2026-04-18T10:59:00.000Z',
      },
      {
        participantId: 'inflight-only',
        completed: 1,
        failed: 0,
        inflight: 2,
        retries: 0,
        remaining: 3,
      },
      ...Array.from({ length: 11 }, (_, index) => ({
        participantId: `recent-${index}`,
        completed: index,
        failed: 1,
        inflight: 0,
        retries: 1,
        remaining: 4 - (index % 3),
        lastFailureAt: `2026-04-18T10:${String(58 - index).padStart(2, '0')}:00.000Z`,
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        participantId: `remaining-${index}`,
        completed: 0,
        failed: 0,
        inflight: 0,
        retries: 0,
        remaining: 90 - index,
      })),
      {
        participantId: 'excluded-idle',
        completed: 0,
        failed: 0,
        inflight: 0,
        retries: 0,
        remaining: 1,
      },
    ],
  });

  const participantIds = lines
    .filter((line) => line.startsWith('translation ') && !line.startsWith('translation overall'))
    .map((line) => line.split(' ')[1]);

  assert.ok(lines.some((line) => line.includes('translation overall')));
  assert.deepEqual(participantIds, [
    'shared',
    'inflight-only',
    'recent-0',
    'recent-1',
    'recent-2',
    'recent-3',
    'recent-4',
    'recent-5',
    'recent-6',
    'recent-7',
    'recent-8',
    'remaining-0',
    'remaining-1',
    'remaining-2',
    'remaining-3',
  ]);
  assert.equal(new Set(participantIds).size, participantIds.length);
  assert.equal(participantIds.includes('recent-9'), false);
  assert.equal(participantIds.includes('recent-10'), false);
  assert.equal(participantIds.includes('remaining-4'), false);
  assert.equal(participantIds.includes('excluded-idle'), false);
});

test('createProgressReporter throttles repeated updates before the summary interval', () => {
  const lines: string[] = [];
  let now = 0;
  const reporter = createProgressReporter({
    phase: 'translation',
    total: 100,
    log: (line) => lines.push(line),
    now: () => now,
  });

  reporter.update({
    completed: 1,
    succeeded: 1,
    failed: 0,
    activeWorkers: 0,
    totalCostUsd: 0,
  });

  now = 5_000;
  reporter.update({
    completed: 2,
    succeeded: 2,
    failed: 0,
    activeWorkers: 0,
    totalCostUsd: 0,
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /translation overall 1\/100/);
});

test('createProgressReporter emits again after the summary interval elapses', () => {
  const lines: string[] = [];
  let now = 0;
  const reporter = createProgressReporter({
    phase: 'translation',
    total: 100,
    log: (line) => lines.push(line),
    now: () => now,
  });

  reporter.update({
    completed: 1,
    succeeded: 1,
    failed: 0,
    activeWorkers: 0,
    totalCostUsd: 0,
  });

  now = 10_000;
  reporter.update({
    completed: 2,
    succeeded: 2,
    failed: 0,
    activeWorkers: 0,
    totalCostUsd: 0,
  });

  assert.equal(lines.length, 2);
  assert.match(lines[1] ?? '', /translation overall 2\/100/);
});

test('createProgressReporter flush emits the latest snapshot immediately', () => {
  const lines: string[] = [];
  let now = 0;
  const reporter = createProgressReporter({
    phase: 'judge',
    total: 100,
    log: (line) => lines.push(line),
    now: () => now,
  });

  reporter.update({
    completed: 1,
    succeeded: 1,
    failed: 0,
    activeWorkers: 0,
    totalCostUsd: 0,
  });

  now = 5_000;
  reporter.flush({
    completed: 2,
    succeeded: 2,
    failed: 0,
    activeWorkers: 0,
    totalCostUsd: 0,
  });

  assert.equal(lines.length, 2);
  assert.match(lines[1] ?? '', /judge overall 2\/100/);
});
