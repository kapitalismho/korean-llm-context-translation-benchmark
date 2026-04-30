import { createRunLayout, writeJsonlRecord } from '../src/run-artifacts.js';
import { TestRunner, type JudgeClient, type RunnerOptions } from '../src/runner.js';
import type { BenchmarkConfig } from '../src/benchmark-config.js';
import type { InteractiveJudge } from '../src/judge.js';
import type { Condition } from '../src/llm-client.js';

// @ts-expect-error Task 7 does not expose RunManifest publicly.
import type { RunManifest } from '../src/run-artifacts.js';

const manifest: Record<string, unknown> & { runId: string; resume: boolean } = {
  runId: 'run-001',
  resume: false,
};

// @ts-expect-error createRunLayout requires a full v3 manifest input.
createRunLayout('output', manifest);

// @ts-expect-error writeJsonlRecord accepts only record-shaped payloads.
writeJsonlRecord('output/translations.jsonl', 'not-a-record');

declare const benchmarkConfig: BenchmarkConfig;
declare const conditions: Condition[];
declare const judge: JudgeClient | null;
declare const legacyJudge: InteractiveJudge;
declare const options: RunnerOptions;

new TestRunner(benchmarkConfig, conditions, judge, options);

// @ts-expect-error Legacy 3-argument constructor must remain unavailable.
new TestRunner(conditions, legacyJudge, { delayMs: 0 });
