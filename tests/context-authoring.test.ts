import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ContextAuthoringItem } from '../src/context-benchmark-types.js';
import {
  assertBatchCoverageMatchesManifest,
  assertContextAuthoringWorkspaceCanInitialize,
  buildContextAuthoringManifest,
  freezeApprovedContextDataset,
  initializeContextAuthoringScaffold,
  orderContextAuthoringItemsByManifest,
  splitContextAuthoringBatches,
  validateAuthoredContextItems,
  validateContextAuthoringScaffold,
} from '../src/context-authoring.js';

function buildApprovedItems(): ContextAuthoringItem[] {
  const manifest = buildContextAuthoringManifest();

  return manifest.items.map((item) => ({
    ...item,
    status: 'approved',
    fill: {
      secondaryPhenomena: [],
      contextTurns: Array.from({ length: item.locked.contextTurnCount }, (_, index) => ({
        speakerRole: item.locked.speakerMode === 'dyadic'
          ? (index % 2 === 0 ? 'other' : 'self')
          : 'self',
        relativeTimeLabel: index === 0 ? '18s ago' : '6s ago',
        sourceText: `맥락 ${index + 1}`,
      })),
      currentSource: {
        speakerRole: 'self',
        relativeTimeLabel: null,
        sourceText: '현재 발화',
      },
      relevantContextIndices: [0],
      intendedInterpretation: 'Synthetic approved sample for freeze-path testing.',
      commonFailureModes: ['Synthetic failure mode.'],
      validationNotes: 'Synthetic approved notes for freeze-path testing.',
    },
  }));
}

test('buildContextAuthoringManifest produces 216 locked slots', () => {
  const manifest = buildContextAuthoringManifest();

  assert.equal(manifest.items.length, 216);
});

test('splitContextAuthoringBatches emits 18 batches of 12 items', () => {
  const manifest = buildContextAuthoringManifest();
  const batches = splitContextAuthoringBatches(manifest.items, 12);

  assert.equal(batches.length, 18);
  assert.ok(batches.every((batch) => batch.items.length === 12));
});

test('validateContextAuthoringScaffold accepts freshly generated empty scaffolds', () => {
  const manifest = buildContextAuthoringManifest();

  assert.doesNotThrow(() => validateContextAuthoringScaffold(manifest.items));
});

test('validateContextAuthoringScaffold rejects modified scaffold content', () => {
  const manifest = buildContextAuthoringManifest();
  const modifiedItems: ContextAuthoringItem[] = manifest.items.map((item, index) => (index === 0
    ? {
      ...item,
      status: 'drafted',
    }
    : item));

  assert.throws(() => validateContextAuthoringScaffold(modifiedItems), /pristine|todo|empty/i);
});

test('validateAuthoredContextItems rejects empty authored content', () => {
  const manifest = buildContextAuthoringManifest();
  const drafted: ContextAuthoringItem = {
    ...manifest.items[0],
    status: 'drafted',
  };

  assert.throws(() => validateAuthoredContextItems([drafted]), /sourceText is required/i);
});

test('assertBatchCoverageMatchesManifest rejects missing authored items', () => {
  const manifest = buildContextAuthoringManifest();

  assert.throws(
    () => assertBatchCoverageMatchesManifest(manifest.items, manifest.items.slice(0, 215)),
    /exactly once/i,
  );
});

test('assertContextAuthoringWorkspaceCanInitialize rejects modified existing batches without force', () => {
  const manifest = buildContextAuthoringManifest();
  const modifiedItems: ContextAuthoringItem[] = manifest.items.map((item, index) => (index === 0
    ? {
      ...item,
      fill: {
        ...item.fill,
        intendedInterpretation: 'Started drafting this item.',
      },
    }
    : item));

  assert.throws(() => assertContextAuthoringWorkspaceCanInitialize(modifiedItems, false), /--force/i);
});

test('initializeContextAuthoringScaffold with force recovers from malformed existing batch JSON', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'korean-llm-context-translation-benchmark-authoring-'));
  const authoringRoot = join(tempDir, 'gemba-mqm-context-v1.authoring');
  const batchesDir = join(authoringRoot, 'batches');

  mkdirSync(batchesDir, { recursive: true });
  writeFileSync(join(batchesDir, 'broken.json'), '{not valid json', 'utf8');

  try {
    assert.doesNotThrow(() => initializeContextAuthoringScaffold(authoringRoot, true));
    assert.equal(existsSync(join(authoringRoot, 'manifest.json')), true);
    assert.equal(readdirSync(batchesDir).filter((fileName) => fileName.endsWith('.json')).length, 18);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('orderContextAuthoringItemsByManifest restores manifest order from shuffled items', () => {
  const manifest = buildContextAuthoringManifest();
  const approvedItems = buildApprovedItems().reverse();

  const orderedItems = orderContextAuthoringItemsByManifest(manifest.items, approvedItems);

  assert.deepEqual(
    orderedItems.map((item) => item.sampleId),
    manifest.items.map((item) => item.sampleId),
  );
});

test('freezeApprovedContextDataset rejects non-approved items', () => {
  const manifest = buildContextAuthoringManifest();
  const draft: ContextAuthoringItem = {
    ...manifest.items[0],
    status: 'drafted',
    fill: {
      secondaryPhenomena: [],
      contextTurns: [{ speakerRole: 'self', relativeTimeLabel: null, sourceText: '어 안녕' }],
      currentSource: { speakerRole: 'self', relativeTimeLabel: null, sourceText: '지금 몇시야?' },
      relevantContextIndices: [0],
      intendedInterpretation: 'Ask what time it is right now.',
      commonFailureModes: ['Translate it as a greeting.'],
      validationNotes: 'Needs approval first.',
    },
  };

  assert.throws(() => freezeApprovedContextDataset([draft]), /approved/i);
});

test('freezeApprovedContextDataset materializes runtime and internal datasets for a complete approved set', () => {
  const manifest = buildContextAuthoringManifest();
  const approvedItems = buildApprovedItems().reverse();
  const frozen = freezeApprovedContextDataset(orderContextAuthoringItemsByManifest(manifest.items, approvedItems));

  assert.equal(frozen.runtime.length, 216);
  assert.equal(frozen.internal.length, 216);
  assert.ok('intendedInterpretation' in frozen.internal[0]);
  assert.equal('locked' in frozen.internal[0], false);
  assert.equal('fill' in frozen.internal[0], false);
  assert.equal(frozen.runtime[0]?.sampleId, manifest.items[0]?.sampleId);
  assert.equal(frozen.internal[215]?.sampleId, manifest.items[215]?.sampleId);
});
