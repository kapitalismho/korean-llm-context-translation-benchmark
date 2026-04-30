import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateRunCosts,
  computeCallCost,
  type CallUsageMetrics,
} from '../src/run-metrics.js';

test('computeCallCost returns estimated totals from token counts', () => {
  const metrics: CallUsageMetrics = {
    provider: 'vertex',
    model: 'gemini-3.1-pro-preview',
    phase: 'judge',
    inputTokens: 1000,
    outputTokens: 200,
    reasoningTokens: 50,
    latencyMs: 1234,
  };

  const priced = computeCallCost(metrics, '2026-04-17');

  assert.equal(priced.costStatus, 'estimated');
  assert.equal(priced.computedCostUsd, 0.0044);
});

test('computeCallCost uses current Gemini text pricing for translation models', () => {
  const priced = computeCallCost({
    provider: 'gemini',
    model: 'gemini-3.1-flash-lite-preview',
    phase: 'translation',
    inputTokens: 1_000,
    outputTokens: 200,
    latencyMs: 123,
  }, '2026-04-20');

  assert.equal(priced.costStatus, 'estimated');
  assert.equal(priced.computedCostUsd, 0.00055);
});

test('computeCallCost converts Alibaba Model Studio Beijing pricing for qwen estimates', () => {
  const priced = computeCallCost({
    provider: 'qwen',
    model: 'qwen3.6-plus',
    phase: 'translation',
    inputTokens: 1_000,
    outputTokens: 200,
    latencyMs: 123,
  }, '2026-04-20');

  assert.equal(priced.costStatus, 'estimated');
  assert.equal(priced.computedCostUsd, 0.000607);
});

test('computeCallCost estimates DeepSeek official API pricing', () => {
  const priced = computeCallCost({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    phase: 'translation',
    inputTokens: 1_000,
    outputTokens: 200,
    latencyMs: 123,
  }, '2026-04-24');

  assert.equal(priced.costStatus, 'estimated');
  assert.equal(priced.computedCostUsd, 0.000196);
});

test('computeCallCost estimates DeepSeek V4 Flash via OpenRouter pricing', () => {
  const priced = computeCallCost({
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash',
    phase: 'translation',
    inputTokens: 1_000,
    outputTokens: 200,
    latencyMs: 123,
  }, '2026-04-24');

  assert.equal(priced.costStatus, 'estimated');
  assert.equal(priced.computedCostUsd, 0.000196);
});

test('computeCallCost leaves DeepL costs unknown when token pricing is unavailable', () => {
  const priced = computeCallCost({
    provider: 'deepl',
    model: 'deepl-api',
    phase: 'translation',
    inputTokens: null,
    outputTokens: null,
    latencyMs: 123,
  }, '2026-04-20');

  assert.equal(priced.costStatus, 'unknown');
  assert.equal(priced.computedCostUsd, null);
});

test('aggregateRunCosts groups totals by phase and model', () => {
  const summary = aggregateRunCosts([
    {
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      phase: 'translation',
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 10,
      costStatus: 'estimated',
      computedCostUsd: 0.01,
    },
    {
      provider: 'vertex',
      model: 'gemini-3.1-pro-preview',
      phase: 'judge',
      inputTokens: 20,
      outputTokens: 10,
      latencyMs: 20,
      costStatus: 'estimated',
      computedCostUsd: 0.02,
    },
  ] satisfies CallUsageMetrics[]);

  assert.equal(summary.overall.totalCostUsd, 0.03);
  assert.equal(summary.overall.unknownCostRecordCount, 0);
  assert.equal(summary.byPhase.translation.totalCostUsd, 0.01);
  assert.equal(summary.byPhase.translation.unknownCostRecordCount, 0);
  assert.equal(summary.byModel['gemini-3.1-pro-preview'].totalCostUsd, 0.02);
  assert.equal(summary.byModel['gemini-3.1-pro-preview'].unknownCostRecordCount, 0);
});

test('aggregateRunCosts tracks unknown-cost records instead of silently reporting them as zero-cost', () => {
  const summary = aggregateRunCosts([
    {
      provider: 'deepl',
      model: 'deepl-api',
      phase: 'translation',
      inputTokens: null,
      outputTokens: null,
      latencyMs: 10,
      costStatus: 'unknown',
      computedCostUsd: null,
    },
    {
      provider: 'vertex',
      model: 'gemini-3.1-pro-preview',
      phase: 'judge',
      inputTokens: 20,
      outputTokens: 10,
      latencyMs: 20,
      costStatus: 'estimated',
      computedCostUsd: 0.02,
    },
  ] satisfies CallUsageMetrics[]);

  assert.equal(summary.overall.totalCostUsd, 0.02);
  assert.equal(summary.overall.unknownCostRecordCount, 1);
  assert.equal(summary.byPhase.translation.unknownCostRecordCount, 1);
  assert.equal(summary.byModel['deepl-api'].unknownCostRecordCount, 1);
});
