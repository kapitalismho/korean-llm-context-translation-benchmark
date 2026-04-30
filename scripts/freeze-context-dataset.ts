import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertBatchCoverageMatchesManifest,
  freezeApprovedContextDataset,
  orderContextAuthoringItemsByManifest,
  validateContextAuthoringScaffold,
} from '../src/context-authoring.js';
import type { ContextAuthoringItem } from '../src/context-benchmark-types.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authoringRoot = path.join(projectRoot, 'data', 'datasets', 'gemba-mqm-context-v1.authoring');
const datasetRoot = path.join(projectRoot, 'data', 'datasets', 'gemba-mqm-context-v1');
const batchesDir = path.join(authoringRoot, 'batches');

function sameLockedMetadata(
  left: ContextAuthoringItem['locked'] | undefined,
  right: ContextAuthoringItem['locked'],
): boolean {
  return left !== undefined
    && left.contextTurnCount === right.contextTurnCount
    && left.speakerMode === right.speakerMode
    && left.contextExpectation === right.contextExpectation
    && left.primaryPhenomenon === right.primaryPhenomenon;
}

function assertLockedMetadataMatchesManifest(
  manifestItems: ContextAuthoringItem[],
  batchItems: ContextAuthoringItem[],
): void {
  const lockedBySampleId = new Map(manifestItems.map((item) => [item.sampleId, item.locked]));

  for (const item of batchItems) {
    if (!sameLockedMetadata(lockedBySampleId.get(item.sampleId), item.locked)) {
      throw new Error(`Batch item ${item.sampleId} modified locked metadata.`);
    }
  }
}

const manifest = JSON.parse(readFileSync(path.join(authoringRoot, 'manifest.json'), 'utf8')) as {
  items: ContextAuthoringItem[];
};
const batchItems = readdirSync(batchesDir)
  .filter((fileName) => fileName.endsWith('.json'))
  .sort((left, right) => left.localeCompare(right))
  .flatMap((fileName) => {
    const batch = JSON.parse(readFileSync(path.join(batchesDir, fileName), 'utf8')) as {
      items: ContextAuthoringItem[];
    };
    return batch.items;
  });

validateContextAuthoringScaffold(manifest.items);
assertLockedMetadataMatchesManifest(manifest.items, batchItems);
assertBatchCoverageMatchesManifest(manifest.items, batchItems);

const orderedBatchItems = orderContextAuthoringItemsByManifest(manifest.items, batchItems);

const frozen = freezeApprovedContextDataset(orderedBatchItems);

mkdirSync(datasetRoot, { recursive: true });
writeFileSync(path.join(datasetRoot, 'internal.json'), `${JSON.stringify(frozen.internal, null, 2)}\n`, 'utf8');
writeFileSync(path.join(datasetRoot, 'runtime.json'), `${JSON.stringify(frozen.runtime, null, 2)}\n`, 'utf8');

console.log(`Frozen ${frozen.runtime.length} context samples.`);
