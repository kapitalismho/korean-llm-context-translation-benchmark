import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadBenchmarkConfig } from '../src/benchmark-config.js';

const BASE_BENCHMARK_CONFIG = {
  benchmarkId: 'custom-benchmark',
  description: 'Custom benchmark config.',
  sharedPromptFile: '../prompts/custom.md',
  dataFile: '../dataset/custom.json',
  targetLanguages: ['ja'],
  targetLanguageLabels: {
    ja: 'Japanese',
  },
} as const;

function cloneConfig<T>(config: T): T {
  return structuredClone(config);
}

function withTempConfig(config: unknown, run: (configPath: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'benchmark-config-'));
  const tempConfigPath = join(tempDir, 'benchmark.json');

  try {
    writeFileSync(tempConfigPath, JSON.stringify(config, null, 2));
    run(tempConfigPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('loadBenchmarkConfig accepts configs without participants', () => {
  const config = loadBenchmarkConfig(new URL('../data/benchmarks/gemba-mqm-v1.json', import.meta.url));

  assert.equal(config.benchmarkId, 'gemba-mqm-v1');
  assert.equal((config as { datasetKind?: unknown }).datasetKind, 'sentence');
  assert.equal((config as { judgePromptSetId?: unknown }).judgePromptSetId, 'gemba-mqm-v1');
  assert.equal(config.description, 'Reference-free sentence-level benchmark with one shared prompt.');
  assert.match(config.sharedPromptFile, /data[\\/]prompts[\\/]gemini\.md$/);
  assert.match(config.dataFile, /data[\\/]sentences\.json$/);
  assert.deepEqual(config.targetLanguages, ['en', 'ja', 'zh-Hans']);
  assert.deepEqual(config.targetLanguageLabels, {
    en: 'English',
    ja: 'Japanese',
    'zh-Hans': 'Chinese Simplified',
  });
  assert.equal('participants' in config, false);
});

test('loadBenchmarkConfig preserves explicit context benchmark track metadata', () => {
  const config = {
    ...cloneConfig(BASE_BENCHMARK_CONFIG),
    datasetKind: 'context',
    judgePromptSetId: 'gemba-mqm-context-v1',
  };

  withTempConfig(config, (configPath) => {
    const loaded = loadBenchmarkConfig(configPath);

    assert.equal((loaded as { datasetKind?: unknown }).datasetKind, 'context');
    assert.equal((loaded as { judgePromptSetId?: unknown }).judgePromptSetId, 'gemba-mqm-context-v1');
  });
});

test('loadBenchmarkConfig defaults context benchmarks to the context judge prompt set', () => {
  const config = {
    ...cloneConfig(BASE_BENCHMARK_CONFIG),
    datasetKind: 'context',
  };

  withTempConfig(config, (configPath) => {
    const loaded = loadBenchmarkConfig(configPath);

    assert.equal(loaded.datasetKind, 'context');
    assert.equal(loaded.judgePromptSetId, 'gemba-mqm-context-v1');
  });
});

test('loadBenchmarkConfig selects the no-explanation context judge prompt set for the rework no-explanation benchmark', () => {
  const config = loadBenchmarkConfig(new URL('../data/benchmarks/gemba-mqm-context-v1-rework-no-explanation.json', import.meta.url));

  assert.equal(config.benchmarkId, 'gemba-mqm-context-v1-rework-no-explanation');
  assert.equal(config.datasetKind, 'context');
  assert.equal(config.judgePromptSetId, 'gemba-mqm-context-v1-no-explanation');
  assert.match(config.sharedPromptFile, /data[\\/]prompts[\\/]gemini-context-rework\.md$/);
});

test('invalid datasetKind values are rejected', () => {
  for (const value of ['document', 123, null]) {
    const config = cloneConfig(BASE_BENCHMARK_CONFIG) as Record<string, unknown>;
    config.datasetKind = value;

    withTempConfig(config, (configPath) => {
      assert.throws(() => loadBenchmarkConfig(configPath), /datasetKind must be "sentence" or "context"/i);
    });
  }
});

test('explicit judgePromptSetId must not be blank', () => {
  const config = cloneConfig(BASE_BENCHMARK_CONFIG) as Record<string, unknown>;
  config.judgePromptSetId = '   ';

  withTempConfig(config, (configPath) => {
    assert.throws(() => loadBenchmarkConfig(configPath), /must define judgePromptSetId/i);
  });
});

test('loadBenchmarkConfig accepts non-canonical benchmark definitions', () => {
  const config = cloneConfig(BASE_BENCHMARK_CONFIG);

  withTempConfig(config, (configPath) => {
    const loaded = loadBenchmarkConfig(configPath);

    assert.equal(loaded.benchmarkId, 'custom-benchmark');
    assert.equal(loaded.description, 'Custom benchmark config.');
    assert.match(loaded.sharedPromptFile, /prompts[\\/]custom\.md$/);
    assert.match(loaded.dataFile, /dataset[\\/]custom\.json$/);
    assert.deepEqual(loaded.targetLanguages, ['ja']);
    assert.deepEqual(loaded.targetLanguageLabels, {
      ja: 'Japanese',
    });
  });
});

test('loadBenchmarkConfig preserves pilotOf for pilot definitions', () => {
  const config = cloneConfig(BASE_BENCHMARK_CONFIG) as any;
  config.benchmarkId = 'custom-benchmark-pilot';
  config.pilotOf = 'custom-benchmark';

  withTempConfig(config, (configPath) => {
    const loaded = loadBenchmarkConfig(configPath);
    assert.equal(loaded.pilotOf, 'custom-benchmark');
  });
});

test('pilot config still requires exactly one target language', () => {
  const config = cloneConfig(BASE_BENCHMARK_CONFIG) as any;
  config.benchmarkId = 'custom-benchmark-pilot';
  config.pilotOf = 'custom-benchmark';
  config.targetLanguages = ['en', 'ja'];

  withTempConfig(config, (configPath) => {
    assert.throws(() => loadBenchmarkConfig(configPath), /exactly one language/i);
  });
});

test('benchmark config requires at least one target language', () => {
  const config = cloneConfig(BASE_BENCHMARK_CONFIG) as any;
  config.targetLanguages = [];

  withTempConfig(config, (configPath) => {
    assert.throws(() => loadBenchmarkConfig(configPath), /at least one target language/i);
  });
});

test('malformed target language values are rejected', () => {
  for (const value of ['fr', 123, null]) {
    const config = cloneConfig(BASE_BENCHMARK_CONFIG) as any;
    config.targetLanguages = [value];

    withTempConfig(config, (configPath) => {
      assert.throws(() => loadBenchmarkConfig(configPath), /unsupported target language/i);
    });
  }
});

test('unsupported target language label keys are rejected', () => {
  const config = cloneConfig(BASE_BENCHMARK_CONFIG) as any;
  config.targetLanguageLabels.fr = 'French';

  withTempConfig(config, (configPath) => {
    assert.throws(() => loadBenchmarkConfig(configPath), /unsupported target language label key/i);
  });
});
