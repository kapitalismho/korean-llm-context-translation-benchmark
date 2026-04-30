import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertContextRuntimeSample,
  isContextRuntimeSample,
  loadContextInternalDataset,
  loadContextRuntimeDataset,
} from '../src/context-dataset.js';
import type { ContextInternalSample, ContextRuntimeSample } from '../src/context-benchmark-types.js';

const SAMPLE: ContextRuntimeSample = {
  sampleId: 'ctx2-dyadic-use-referent_resolution-001',
  contextTurnCount: 2,
  speakerMode: 'dyadic',
  contextExpectation: 'use',
  primaryPhenomenon: 'referent_resolution',
  secondaryPhenomena: ['self_other_deixis'],
  contextTurns: [
    { speakerRole: 'other', relativeTimeLabel: '18s ago', sourceText: '어 안녕' },
    { speakerRole: 'self', relativeTimeLabel: '6s ago', sourceText: '지금 막 들어왔어' },
  ],
  currentSource: { speakerRole: 'self', relativeTimeLabel: null, sourceText: '거기 몇시야?' },
};

const INTERNAL_SAMPLE: ContextInternalSample = {
  ...SAMPLE,
  relevantContextIndices: [0],
  intendedInterpretation: 'The speaker is asking for the local time in the other person\'s location.',
  commonFailureModes: ['Translate literally as a generic time question without deixis.'],
  validationNotes: 'Dyadic deixis depends on the prior turn sequence.',
};

const SENTENCE_CASE = {
  id: 1,
  source: '안녕하세요',
  sourceLang: 'Korean',
  targetLangs: ['English'],
};

test('assertContextRuntimeSample accepts valid context samples', () => {
  assert.doesNotThrow(() => assertContextRuntimeSample(SAMPLE));
});

test('assertContextRuntimeSample accepts empty-string sampleId', () => {
  assert.doesNotThrow(() => assertContextRuntimeSample({
    ...SAMPLE,
    sampleId: '',
  }));
});

test('isContextRuntimeSample distinguishes runtime samples from sentence samples', () => {
  assert.equal(isContextRuntimeSample(SAMPLE), true);
  assert.equal(isContextRuntimeSample(SENTENCE_CASE), false);
});

test('loadContextRuntimeDataset loads a valid runtime dataset array', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'korean-llm-context-translation-benchmark-runtime-'));
  const filePath = join(tempDir, 'runtime.json');

  try {
    writeFileSync(filePath, `${JSON.stringify([SAMPLE], null, 2)}\n`, 'utf8');
    assert.deepEqual(loadContextRuntimeDataset(filePath), [SAMPLE]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadContextRuntimeDataset rejects duplicate sampleId values', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'korean-llm-context-translation-benchmark-runtime-'));
  const filePath = join(tempDir, 'runtime.json');

  try {
    writeFileSync(filePath, `${JSON.stringify([
      SAMPLE,
      {
        ...SAMPLE,
        currentSource: {
          ...SAMPLE.currentSource,
          sourceText: '다른 현재 발화',
        },
      },
    ], null, 2)}\n`, 'utf8');
    assert.throws(() => loadContextRuntimeDataset(filePath), /duplicate sampleId/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadContextInternalDataset loads a valid internal dataset array', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'korean-llm-context-translation-benchmark-internal-'));
  const filePath = join(tempDir, 'internal.json');

  try {
    writeFileSync(filePath, `${JSON.stringify([INTERNAL_SAMPLE], null, 2)}\n`, 'utf8');
    assert.deepEqual(loadContextInternalDataset(filePath), [INTERNAL_SAMPLE]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadContextInternalDataset rejects non-integer relevantContextIndices', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'korean-llm-context-translation-benchmark-internal-'));
  const filePath = join(tempDir, 'internal.json');

  try {
    writeFileSync(filePath, `${JSON.stringify([{
      ...INTERNAL_SAMPLE,
      relevantContextIndices: [0.5],
    }], null, 2)}\n`, 'utf8');
    assert.throws(() => loadContextInternalDataset(filePath), /relevantContextIndices/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadContextInternalDataset rejects out-of-range relevantContextIndices', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'korean-llm-context-translation-benchmark-internal-'));
  const filePath = join(tempDir, 'internal.json');

  try {
    writeFileSync(filePath, `${JSON.stringify([{
      ...INTERNAL_SAMPLE,
      relevantContextIndices: [-1, 2],
    }], null, 2)}\n`, 'utf8');
    assert.throws(() => loadContextInternalDataset(filePath), /relevantContextIndices/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadContextInternalDataset rejects empty commonFailureModes entries', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'korean-llm-context-translation-benchmark-internal-'));
  const filePath = join(tempDir, 'internal.json');

  try {
    writeFileSync(filePath, `${JSON.stringify([{
      ...INTERNAL_SAMPLE,
      commonFailureModes: [''],
    }], null, 2)}\n`, 'utf8');
    assert.throws(() => loadContextInternalDataset(filePath), /commonFailureModes/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadContextInternalDataset rejects non-string commonFailureModes entries', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'korean-llm-context-translation-benchmark-internal-'));
  const filePath = join(tempDir, 'internal.json');

  try {
    writeFileSync(filePath, `${JSON.stringify([{
      ...INTERNAL_SAMPLE,
      commonFailureModes: [17],
    }], null, 2)}\n`, 'utf8');
    assert.throws(() => loadContextInternalDataset(filePath), /commonFailureModes/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('assertContextRuntimeSample rejects single-speaker samples that switch speakerRole', () => {
  assert.throws(() => assertContextRuntimeSample({
    ...SAMPLE,
    speakerMode: 'single',
  }), /single speakerMode/i);
});

test('assertContextRuntimeSample rejects dyadic samples missing one side of the conversation', () => {
  assert.throws(() => assertContextRuntimeSample({
    ...SAMPLE,
    contextTurns: [{ speakerRole: 'self', relativeTimeLabel: null, sourceText: '어 안녕' }],
    contextTurnCount: 1,
    currentSource: { speakerRole: 'self', relativeTimeLabel: null, sourceText: '거기 몇시야?' },
  }), /dyadic speakerMode/i);
});

test('assertContextRuntimeSample rejects unknown secondary phenomena', () => {
  assert.throws(() => assertContextRuntimeSample({
    ...SAMPLE,
    secondaryPhenomena: ['made_up_tag'],
  }), /secondaryPhenomena/i);
});

test('assertContextRuntimeSample requires currentSource.speakerRole to stay self in v1', () => {
  assert.throws(() => assertContextRuntimeSample({
    ...SAMPLE,
    currentSource: { speakerRole: 'other', relativeTimeLabel: null, sourceText: '거기 몇시야?' },
  }), /currentSource\.speakerRole/i);
});

test('assertContextRuntimeSample requires currentSource.relativeTimeLabel to stay null in v1', () => {
  assert.throws(() => assertContextRuntimeSample({
    ...SAMPLE,
    currentSource: { speakerRole: 'self', relativeTimeLabel: '2s ago', sourceText: '거기 몇시야?' },
  }), /currentSource\.relativeTimeLabel/i);
});
