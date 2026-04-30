import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  type ContextAuthoringItem,
  type ContextExpectation,
  type ContextInternalSample,
  type ContextRuntimeSample,
  type ContextTurnCount,
  type PrimaryPhenomenon,
  type SpeakerMode,
} from './context-benchmark-types.js';
import { assertContextRuntimeSample } from './context-dataset.js';

const DATASET_ID = 'gemba-mqm-context-v1';

const CONTEXT_TURN_COUNTS: readonly ContextTurnCount[] = [1, 2, 3];
const SPEAKER_MODES: readonly SpeakerMode[] = ['single', 'dyadic'];

const USE_PHENOMENA: readonly PrimaryPhenomenon[] = [
  'referent_resolution',
  'ellipsis_completion',
  'sense_disambiguation',
  'pragmatic_intent_resolution',
  'register_carryover',
  'temporal_or_causal_linkage',
];

const IGNORE_PHENOMENA: readonly PrimaryPhenomenon[] = [
  'topic_shift_independence',
  'false_lead_trap',
  'stale_context_resistance',
  'metadata_nonliteral_resistance',
];

type LockedMetadata = ContextAuthoringItem['locked'];

export interface ContextAuthoringManifest {
  datasetId: typeof DATASET_ID;
  items: ContextAuthoringItem[];
}

export interface ContextAuthoringBatch {
  batchId: string;
  items: ContextAuthoringItem[];
}

function buildLockedItem(
  contextTurnCount: ContextTurnCount,
  speakerMode: SpeakerMode,
  contextExpectation: ContextExpectation,
  primaryPhenomenon: PrimaryPhenomenon,
  sequence: number,
): ContextAuthoringItem {
  return {
    sampleId: `ctx${contextTurnCount}-${speakerMode}-${contextExpectation}-${primaryPhenomenon}-${String(sequence).padStart(3, '0')}`,
    locked: {
      contextTurnCount,
      speakerMode,
      contextExpectation,
      primaryPhenomenon,
    },
    status: 'todo',
    fill: {
      secondaryPhenomena: [],
      contextTurns: Array.from({ length: contextTurnCount }, () => ({
        speakerRole: 'self',
        relativeTimeLabel: null,
        sourceText: '',
      })),
      currentSource: {
        speakerRole: 'self',
        relativeTimeLabel: null,
        sourceText: '',
      },
      relevantContextIndices: [],
      intendedInterpretation: '',
      commonFailureModes: [],
      validationNotes: '',
    },
  };
}

function buildBucketKey(locked: LockedMetadata): string {
  return [
    locked.contextTurnCount,
    locked.speakerMode,
    locked.contextExpectation,
    locked.primaryPhenomenon,
  ].join('::');
}

function buildStructuralBucketKey(locked: LockedMetadata): string {
  return `ctx${locked.contextTurnCount}-${locked.speakerMode}`;
}

function assertTrimmedNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
}

function assertPristineScaffoldItem(item: ContextAuthoringItem): void {
  if (item.status !== 'todo') {
    throw new Error(`Scaffold item ${item.sampleId} must remain pristine with status todo.`);
  }

  if (item.fill.secondaryPhenomena.length !== 0) {
    throw new Error(`Scaffold item ${item.sampleId} must keep secondaryPhenomena empty.`);
  }

  if (item.fill.relevantContextIndices.length !== 0) {
    throw new Error(`Scaffold item ${item.sampleId} must keep relevantContextIndices empty.`);
  }

  if (item.fill.commonFailureModes.length !== 0) {
    throw new Error(`Scaffold item ${item.sampleId} must keep commonFailureModes empty.`);
  }

  if (item.fill.intendedInterpretation !== '') {
    throw new Error(`Scaffold item ${item.sampleId} must keep intendedInterpretation empty.`);
  }

  if (item.fill.validationNotes !== '') {
    throw new Error(`Scaffold item ${item.sampleId} must keep validationNotes empty.`);
  }

  item.fill.contextTurns.forEach((turn, index) => {
    if (turn.speakerRole !== 'self' || turn.relativeTimeLabel !== null || turn.sourceText !== '') {
      throw new Error(`Scaffold item ${item.sampleId} contextTurns[${index}] must remain pristine and empty.`);
    }
  });

  if (
    item.fill.currentSource.speakerRole !== 'self'
    || item.fill.currentSource.relativeTimeLabel !== null
    || item.fill.currentSource.sourceText !== ''
  ) {
    throw new Error(`Scaffold item ${item.sampleId} currentSource must remain pristine and empty.`);
  }
}

function materializeRuntimeSample(item: ContextAuthoringItem): ContextRuntimeSample {
  return {
    sampleId: item.sampleId,
    contextTurnCount: item.locked.contextTurnCount,
    speakerMode: item.locked.speakerMode,
    contextExpectation: item.locked.contextExpectation,
    primaryPhenomenon: item.locked.primaryPhenomenon,
    secondaryPhenomena: item.fill.secondaryPhenomena,
    contextTurns: item.fill.contextTurns,
    currentSource: item.fill.currentSource,
  };
}

function materializeInternalSample(item: ContextAuthoringItem): ContextInternalSample {
  return {
    ...materializeRuntimeSample(item),
    relevantContextIndices: item.fill.relevantContextIndices,
    intendedInterpretation: item.fill.intendedInterpretation,
    commonFailureModes: item.fill.commonFailureModes,
    validationNotes: item.fill.validationNotes,
  };
}

export function buildContextAuthoringManifest(): ContextAuthoringManifest {
  const items: ContextAuthoringItem[] = [];

  for (const contextTurnCount of CONTEXT_TURN_COUNTS) {
    for (const speakerMode of SPEAKER_MODES) {
      for (const phenomenon of USE_PHENOMENA) {
        for (let sequence = 1; sequence <= 4; sequence += 1) {
          items.push(buildLockedItem(contextTurnCount, speakerMode, 'use', phenomenon, sequence));
        }
      }

      for (const phenomenon of IGNORE_PHENOMENA) {
        for (let sequence = 1; sequence <= 3; sequence += 1) {
          items.push(buildLockedItem(contextTurnCount, speakerMode, 'ignore', phenomenon, sequence));
        }
      }
    }
  }

  return {
    datasetId: DATASET_ID,
    items,
  };
}

export function splitContextAuthoringBatches(
  items: ContextAuthoringItem[],
  batchSize: number,
): ContextAuthoringBatch[] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('batchSize must be a positive integer');
  }

  const groupedItems = new Map<string, ContextAuthoringItem[]>();

  for (const item of items) {
    const key = buildStructuralBucketKey(item.locked);
    const bucketItems = groupedItems.get(key);

    if (bucketItems) {
      bucketItems.push(item);
    } else {
      groupedItems.set(key, [item]);
    }
  }

  const batches: ContextAuthoringBatch[] = [];

  for (const [key, bucketItems] of groupedItems) {
    for (let offset = 0; offset < bucketItems.length; offset += batchSize) {
      const batchNumber = Math.floor(offset / batchSize) + 1;

      batches.push({
        batchId: `${key}-batch-${String(batchNumber).padStart(2, '0')}`,
        items: bucketItems.slice(offset, offset + batchSize),
      });
    }
  }

  return batches;
}

export function assertBatchCoverageMatchesManifest(
  manifestItems: ContextAuthoringItem[],
  batchItems: ContextAuthoringItem[],
): void {
  const manifestIds = new Set(manifestItems.map((item) => item.sampleId));
  const observedCounts = new Map<string, number>();

  for (const item of batchItems) {
    observedCounts.set(item.sampleId, (observedCounts.get(item.sampleId) ?? 0) + 1);
  }

  for (const manifestId of manifestIds) {
    if (observedCounts.get(manifestId) !== 1) {
      throw new Error(`Manifest item ${manifestId} must appear exactly once across authoring batches.`);
    }
  }

  for (const sampleId of observedCounts.keys()) {
    if (!manifestIds.has(sampleId)) {
      throw new Error(`Unexpected batch item not found in manifest: ${sampleId}`);
    }
  }
}

export function orderContextAuthoringItemsByManifest(
  manifestItems: ContextAuthoringItem[],
  items: ContextAuthoringItem[],
): ContextAuthoringItem[] {
  assertBatchCoverageMatchesManifest(manifestItems, items);

  const itemsBySampleId = new Map(items.map((item) => [item.sampleId, item]));

  return manifestItems.map((manifestItem) => {
    const item = itemsBySampleId.get(manifestItem.sampleId);

    if (!item) {
      throw new Error(`Manifest item ${manifestItem.sampleId} is missing from authoring items.`);
    }

    return item;
  });
}

export function assertContextAuthoringWorkspaceCanInitialize(
  existingBatchItems: ContextAuthoringItem[],
  force: boolean,
): void {
  if (force || existingBatchItems.length === 0) {
    return;
  }

  try {
    validateContextAuthoringScaffold(existingBatchItems);
  } catch {
    throw new Error('Refusing to overwrite existing authoring batches unless --force is passed. Existing batches are not a pristine scaffold.');
  }
}

function loadExistingContextAuthoringBatchItems(batchesDir: string): ContextAuthoringItem[] {
  return readdirSync(batchesDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right))
    .flatMap((fileName) => {
      const batch = JSON.parse(readFileSync(path.join(batchesDir, fileName), 'utf8')) as { items: ContextAuthoringItem[] };
      return batch.items;
    });
}

export function initializeContextAuthoringScaffold(authoringRoot: string, force: boolean): void {
  const batchesDir = path.join(authoringRoot, 'batches');
  const manifest = buildContextAuthoringManifest();
  const batches = splitContextAuthoringBatches(manifest.items, 12);

  mkdirSync(batchesDir, { recursive: true });

  if (!force) {
    const existingBatchItems = loadExistingContextAuthoringBatchItems(batchesDir);
    assertContextAuthoringWorkspaceCanInitialize(existingBatchItems, false);
  }

  for (const fileName of readdirSync(batchesDir)) {
    if (fileName.endsWith('.json')) {
      rmSync(path.join(batchesDir, fileName), { force: true });
    }
  }

  writeFileSync(path.join(authoringRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  for (const batch of batches) {
    writeFileSync(
      path.join(batchesDir, `${batch.batchId}.json`),
      `${JSON.stringify({ datasetId: manifest.datasetId, batchId: batch.batchId, items: batch.items }, null, 2)}\n`,
      'utf8',
    );
  }
}

export function validateContextAuthoringScaffold(items: ContextAuthoringItem[]): void {
  if (items.length !== 216) {
    throw new Error('Context authoring scaffold must contain exactly 216 items.');
  }

  const sampleIds = new Set<string>();
  const bucketCounts = new Map<string, number>();

  for (const item of items) {
    if (sampleIds.has(item.sampleId)) {
      throw new Error(`Duplicate sampleId in scaffold: ${item.sampleId}`);
    }
    sampleIds.add(item.sampleId);

    if (item.fill.contextTurns.length !== item.locked.contextTurnCount) {
      throw new Error(`Scaffold item ${item.sampleId} has the wrong number of contextTurns.`);
    }

    assertPristineScaffoldItem(item);

    const bucketKey = buildBucketKey(item.locked);
    bucketCounts.set(bucketKey, (bucketCounts.get(bucketKey) ?? 0) + 1);
  }

  for (const contextTurnCount of CONTEXT_TURN_COUNTS) {
    for (const speakerMode of SPEAKER_MODES) {
      for (const phenomenon of USE_PHENOMENA) {
        const bucketKey = buildBucketKey({
          contextTurnCount,
          speakerMode,
          contextExpectation: 'use',
          primaryPhenomenon: phenomenon,
        });

        if (bucketCounts.get(bucketKey) !== 4) {
          throw new Error(`Expected 4 items for ${bucketKey}.`);
        }
      }

      for (const phenomenon of IGNORE_PHENOMENA) {
        const bucketKey = buildBucketKey({
          contextTurnCount,
          speakerMode,
          contextExpectation: 'ignore',
          primaryPhenomenon: phenomenon,
        });

        if (bucketCounts.get(bucketKey) !== 3) {
          throw new Error(`Expected 3 items for ${bucketKey}.`);
        }
      }
    }
  }
}

export function validateAuthoredContextItems(items: ContextAuthoringItem[]): void {
  for (const item of items) {
    const runtimeSample = materializeRuntimeSample(item);

    assertContextRuntimeSample(runtimeSample);

    runtimeSample.contextTurns.forEach((turn, index) => {
      assertTrimmedNonEmptyString(turn.sourceText, `contextTurns[${index}].sourceText`);
    });
    assertTrimmedNonEmptyString(runtimeSample.currentSource.sourceText, 'currentSource.sourceText');
    assertTrimmedNonEmptyString(item.fill.intendedInterpretation, 'intendedInterpretation');
    assertTrimmedNonEmptyString(item.fill.validationNotes, 'validationNotes');

    if (!Array.isArray(item.fill.commonFailureModes) || item.fill.commonFailureModes.length === 0) {
      throw new Error(`Authored item ${item.sampleId} must define at least one commonFailureMode.`);
    }

    item.fill.commonFailureModes.forEach((failureMode, index) => {
      assertTrimmedNonEmptyString(failureMode, `commonFailureModes[${index}]`);
    });

    if (!Array.isArray(item.fill.relevantContextIndices)) {
      throw new Error(`Authored item ${item.sampleId} must define relevantContextIndices as an array.`);
    }

    item.fill.relevantContextIndices.forEach((index) => {
      if (!Number.isInteger(index) || index < 0 || index >= runtimeSample.contextTurns.length) {
        throw new Error(`Authored item ${item.sampleId} has an invalid relevantContextIndices entry.`);
      }
    });
  }
}

export function freezeApprovedContextDataset(items: ContextAuthoringItem[]): {
  runtime: ContextRuntimeSample[];
  internal: ContextInternalSample[];
} {
  validateAuthoredContextItems(items);

  if (items.some((item) => item.status !== 'approved')) {
    throw new Error('All context authoring items must be approved before freezing.');
  }

  return {
    runtime: items.map(materializeRuntimeSample),
    internal: items.map(materializeInternalSample),
  };
}
