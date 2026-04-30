import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadParticipantRegistry,
  resolveSelectedParticipants,
} from '../src/participant-registry.js';

function withTempRegistry(registry: unknown, run: (registryPath: string) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'participant-registry-'));
  const registryPath = join(tempDir, 'registry.json');

  try {
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    run(registryPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('loadParticipantRegistry loads the shared participant catalog', () => {
  const registry = loadParticipantRegistry(new URL('../data/participants/registry.json', import.meta.url));

  assert.equal(registry.length, 25);
  assert.deepEqual(registry.map((participant) => participant.participantId), [
    'qwen-3.6-plus',
    'qwen-3.6-flash',
    'qwen-3.5-plus',
    'qwen-3.5-flash',
    'qwen-3.6-plus-nocontext',
    'qwen-3.6-flash-nocontext',
    'qwen-3.5-plus-nocontext',
    'qwen-3.5-flash-nocontext',
    'gemini-3-flash',
    'gemini-3.1-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-3-flash-nocontext',
    'gemini-3.1-flash-lite-nocontext',
    'gemini-2.5-flash-lite-nocontext',
    'gemma-4-26b-openrouter',
    'gemma-4-26b-openrouter-nocontext',
    'gemma-4-26b-openrouter-nocontext-baseline',
    'deepseek-v4-flash',
    'deepseek-v4-flash-nocontext',
    'deepseek-v4-flash-nocontext-baseline',
    'deepseek-v4-flash-openrouter',
    'deepl-api',
    'deepl-api-nocontext',
    'google-cloud-translate-basic',
    'google-translate-web',
  ]);
});

test('loadParticipantRegistry keeps no-context participants on the same provider model as their base participant', () => {
  const registry = loadParticipantRegistry(new URL('../data/participants/registry.json', import.meta.url));
  const participantsById = new Map(registry.map((participant) => [participant.participantId, participant]));

  assert.deepEqual(participantsById.get('qwen-3.6-plus-nocontext'), {
    participantId: 'qwen-3.6-plus-nocontext',
    displayName: 'Qwen 3.6 Plus (No context)',
    provider: 'qwen',
    providerModelId: 'qwen3.6-plus',
  });
  assert.equal(participantsById.get('gemini-3-flash-nocontext')?.providerModelId, 'gemini-3-flash-preview');
  assert.equal(participantsById.get('gemma-4-26b-openrouter-nocontext')?.providerModelId, 'google/gemma-4-26b-a4b-it');
  assert.deepEqual(participantsById.get('gemma-4-26b-openrouter-nocontext-baseline'), {
    participantId: 'gemma-4-26b-openrouter-nocontext-baseline',
    displayName: 'Gemma 4 26B via OpenRouter (No context baseline)',
    provider: 'openrouter',
    providerModelId: 'google/gemma-4-26b-a4b-it',
    promptFile: fileURLToPath(new URL('../data/prompts/simple-translation.md', import.meta.url)),
  });
  assert.equal(participantsById.get('deepseek-v4-flash-nocontext')?.providerModelId, 'deepseek-v4-flash');
  assert.deepEqual(participantsById.get('deepseek-v4-flash-nocontext-baseline'), {
    participantId: 'deepseek-v4-flash-nocontext-baseline',
    displayName: 'DeepSeek V4 Flash (No context baseline)',
    provider: 'deepseek',
    providerModelId: 'deepseek-v4-flash',
    promptFile: fileURLToPath(new URL('../data/prompts/simple-translation.md', import.meta.url)),
  });
  assert.deepEqual(participantsById.get('deepseek-v4-flash-openrouter'), {
    participantId: 'deepseek-v4-flash-openrouter',
    displayName: 'DeepSeek V4 Flash via OpenRouter',
    provider: 'openrouter',
    providerModelId: 'deepseek/deepseek-v4-flash',
  });
  assert.equal(participantsById.get('deepl-api-nocontext')?.providerModelId, 'deepl-api');
});

test('loadParticipantRegistry resolves optional promptFile relative to the registry file', () => {
  withTempRegistry([
    {
      participantId: 'context-model',
      displayName: 'Context Model',
      provider: 'gemini',
      providerModelId: 'gemini-3-flash-preview',
    },
    {
      participantId: 'baseline-model',
      displayName: 'Baseline Model',
      provider: 'deepseek',
      providerModelId: 'deepseek-v4-flash',
      promptFile: './prompts/simple.md',
    },
  ], (registryPath) => {
    const registry = loadParticipantRegistry(registryPath);

    assert.equal(registry[0].promptFile, undefined);
    assert.equal(registry[1].promptFile, join(dirname(registryPath), 'prompts', 'simple.md'));
  });
});

test('loadParticipantRegistry rejects invalid promptFile values', () => {
  withTempRegistry([
    {
      participantId: 'one',
      displayName: 'One',
      provider: 'gemini',
      providerModelId: 'gemini-3-flash-preview',
    },
    {
      participantId: 'two',
      displayName: 'Two',
      provider: 'deepseek',
      providerModelId: 'deepseek-v4-flash',
      promptFile: '',
    },
  ], (registryPath) => {
    assert.throws(() => loadParticipantRegistry(registryPath), /registry\[1\]\.promptFile/i);
  });
});

test('loadParticipantRegistry accepts deepseek, deepl, google-translate-basic, and google-web providers', () => {
  withTempRegistry([
    {
      participantId: 'deepseek-v4-flash',
      displayName: 'DeepSeek V4 Flash',
      provider: 'deepseek',
      providerModelId: 'deepseek-v4-flash',
    },
    {
      participantId: 'deepl-api',
      displayName: 'DeepL API',
      provider: 'deepl',
      providerModelId: 'deepl-api',
    },
    {
      participantId: 'google-cloud-translate-basic',
      displayName: 'Google Cloud Translation Basic',
      provider: 'google-translate-basic',
      providerModelId: 'google-translate-basic',
    },
    {
      participantId: 'google-translate-web',
      displayName: 'Google Translate Web',
      provider: 'google-web',
      providerModelId: 'google-translate-web',
    },
  ], (registryPath) => {
    const registry = loadParticipantRegistry(registryPath);
    assert.deepEqual(registry.map((participant) => participant.provider), ['deepseek', 'deepl', 'google-translate-basic', 'google-web']);
  });
});

test('loadParticipantRegistry lists all supported providers in validation errors', () => {
  withTempRegistry([
    {
      participantId: 'one',
      displayName: 'One',
      provider: 'gemini',
      providerModelId: 'gemini-3-flash-preview',
    },
    {
      participantId: 'two',
      displayName: 'Two',
      provider: 'not-a-provider',
      providerModelId: 'mystery',
    },
  ], (registryPath) => {
    assert.throws(
      () => loadParticipantRegistry(registryPath),
      /must be one of gemini, qwen, openrouter, deepseek, deepl, google-translate-basic, or google-web/i,
    );
  });
});

test('resolveSelectedParticipants preserves CLI order', () => {
  const registry = loadParticipantRegistry(new URL('../data/participants/registry.json', import.meta.url));
  const selected = resolveSelectedParticipants(registry, ['gemini-3-flash', 'qwen-3.6-plus']);

  assert.deepEqual(selected.map((item) => item.participantId), ['gemini-3-flash', 'qwen-3.6-plus']);
});

test('resolveSelectedParticipants rejects unknown participant ids', () => {
  const registry = loadParticipantRegistry(new URL('../data/participants/registry.json', import.meta.url));

  assert.throws(() => resolveSelectedParticipants(registry, ['missing-model']), /unknown participant id/i);
});

test('resolveSelectedParticipants rejects duplicate selected participant ids', () => {
  const registry = loadParticipantRegistry(new URL('../data/participants/registry.json', import.meta.url));

  assert.throws(
    () => resolveSelectedParticipants(registry, ['gemini-3-flash', 'gemini-3-flash']),
    /duplicate participant id.*gemini-3-flash/i,
  );
});

test('loadParticipantRegistry rejects registries with fewer than two participants', () => {
  withTempRegistry([
    {
      participantId: 'solo',
      displayName: 'Solo',
      provider: 'gemini',
      providerModelId: 'gemini-3-flash-preview',
    },
  ], (registryPath) => {
    assert.throws(() => loadParticipantRegistry(registryPath), /at least two participants/i);
  });
});

test('loadParticipantRegistry rejects duplicate participant ids', () => {
  withTempRegistry([
    {
      participantId: 'dup',
      displayName: 'One',
      provider: 'gemini',
      providerModelId: 'gemini-3-flash-preview',
    },
    {
      participantId: 'dup',
      displayName: 'Two',
      provider: 'qwen',
      providerModelId: 'qwen3.6-plus',
    },
  ], (registryPath) => {
    assert.throws(() => loadParticipantRegistry(registryPath), /duplicate participant id/i);
  });
});

test('loadParticipantRegistry allows duplicate provider model ids', () => {
  withTempRegistry([
    {
      participantId: 'alias-one',
      displayName: 'Alias One',
      provider: 'gemini',
      providerModelId: 'shared-model',
    },
    {
      participantId: 'alias-two',
      displayName: 'Alias Two',
      provider: 'gemini',
      providerModelId: 'shared-model',
    },
  ], (registryPath) => {
    const registry = loadParticipantRegistry(registryPath);
    assert.deepEqual(registry.map((participant) => participant.participantId), ['alias-one', 'alias-two']);
  });
});
