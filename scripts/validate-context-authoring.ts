import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertBatchCoverageMatchesManifest,
  validateAuthoredContextItems,
  validateContextAuthoringScaffold,
} from '../src/context-authoring.js';
import type { ContextAuthoringItem } from '../src/context-benchmark-types.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authoringRoot = path.join(projectRoot, 'data', 'datasets', 'gemba-mqm-context-v1.authoring');
const manifestPath = path.join(authoringRoot, 'manifest.json');
const batchesDir = path.join(authoringRoot, 'batches');

function parseMode(argv: string[]): 'scaffold' | 'authored' {
  const modeIndex = argv.indexOf('--mode');
  const mode = modeIndex === -1 ? 'scaffold' : argv[modeIndex + 1];

  if (mode === 'scaffold' || mode === 'authored') {
    return mode;
  }

  throw new Error(`Unsupported validation mode: ${String(mode)}`);
}

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

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFilledItem(item: ContextAuthoringItem): boolean {
  return item.fill.secondaryPhenomena.length > 0
    || item.fill.relevantContextIndices.length > 0
    || item.fill.commonFailureModes.length > 0
    || item.fill.contextTurns.some((turn) => hasNonEmptyString(turn.sourceText))
    || hasNonEmptyString(item.fill.currentSource.sourceText)
    || hasNonEmptyString(item.fill.intendedInterpretation)
    || hasNonEmptyString(item.fill.validationNotes);
}

const mode = parseMode(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { items: ContextAuthoringItem[] };
const batchItems = readdirSync(batchesDir)
  .filter((fileName) => fileName.endsWith('.json'))
  .sort((left, right) => left.localeCompare(right))
  .flatMap((fileName) => {
    const batch = JSON.parse(readFileSync(path.join(batchesDir, fileName), 'utf8')) as { items: ContextAuthoringItem[] };
    return batch.items;
  });

validateContextAuthoringScaffold(manifest.items);
assertLockedMetadataMatchesManifest(manifest.items, batchItems);
assertBatchCoverageMatchesManifest(manifest.items, batchItems);

if (mode === 'scaffold') {
  validateContextAuthoringScaffold(batchItems);
  console.log('Scaffold validation passed.');
} else {
  const authoredItems = batchItems.filter(isFilledItem);

  if (authoredItems.length === 0) {
    throw new Error('Authored validation requires at least one filled item.');
  }

  validateAuthoredContextItems(authoredItems);
  console.log('Authored validation passed.');
}
