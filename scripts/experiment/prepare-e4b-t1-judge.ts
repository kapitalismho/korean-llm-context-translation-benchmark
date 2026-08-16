import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBenchmarkConfig } from '../../src/benchmark-config.js';
import { isContextRuntimeSample } from '../../src/context-dataset.js';
import { prepareForkRun } from '../../src/fork-run.js';
import { loadBenchmarkTestCases } from '../../src/index.js';
import { loadParticipantRegistry, resolveSelectedParticipants } from '../../src/participant-registry.js';
import { rewriteTranslationRecordForRun } from '../../src/rejudge.js';
import { computeFileSha256, readJsonlRecords, writeJsonlRecord } from '../../src/run-artifacts.js';
import type { TranslationArtifactRecord } from '../../src/runner.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDir = path.join(projectRoot, 'output');
const newRunId = 'issue1-milmmt-e4b-20260815-e4b-t1-judge';
const participantIds = [
    'gemma4-e4b-qat-q2',
    'gemma4-e4b-qat-q4',
    'gemma4-e4b-fp16',
    'milmmt-4b-native',
    'milmmt-4b-puripuly-policy',
    'gemma4-31b',
    'gemma-4-26b-openrouter',
    'google-cloud-translate-basic',
    'deepl-api',
];
const e4bImports: Array<{ participantId: string; sourceRunId: string }> = [
    { participantId: 'gemma4-e4b-qat-q2', sourceRunId: 'issue1-milmmt-e4b-20260815-e4b-nr' },
    { participantId: 'gemma4-e4b-qat-q4', sourceRunId: 'issue1-milmmt-e4b-20260815-e4b-q4-t1' },
    { participantId: 'gemma4-e4b-fp16', sourceRunId: 'issue1-milmmt-e4b-20260815-e4b-bf16-t1' },
];

const benchmarkConfig = loadBenchmarkConfig(
    path.resolve(projectRoot, 'data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json'),
);
const testCases = loadBenchmarkTestCases(benchmarkConfig);
const registry = loadParticipantRegistry(path.resolve(projectRoot, 'data/participants/registry.json'));
const participants = resolveSelectedParticipants(registry, participantIds);

const fork = prepareForkRun({
    outputDir,
    sourceRunId: 'issue1-milmmt-e4b-20260815-batch',
    newRunId,
    benchmarkId: benchmarkConfig.benchmarkId,
    datasetVersion: path.basename(benchmarkConfig.dataFile),
    datasetKind: benchmarkConfig.datasetKind,
    datasetFingerprintSha256: computeFileSha256(benchmarkConfig.dataFile),
    promptVersion: path.basename(benchmarkConfig.sharedPromptFile),
    promptFingerprintSha256: computeFileSha256(benchmarkConfig.sharedPromptFile),
    judgePromptVersion: benchmarkConfig.judgePromptSetId,
    judgePromptSetId: benchmarkConfig.judgePromptSetId,
    targetLanguages: benchmarkConfig.targetLanguages,
    targetLanguageLabels: benchmarkConfig.targetLanguageLabels,
    judgeModelId: 'google/gemini-3.7-flash:batch',
    judgeBackend: 'openrouter-batch',
    vertexProject: process.env.GOOGLE_CLOUD_PROJECT ?? null,
    vertexRegion: process.env.GOOGLE_CLOUD_LOCATION ?? null,
    vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
    translationConcurrencyPerModel: 4,
    limitApplied: testCases.length,
    allowedSourceIds: testCases.map((testCase) => (
        isContextRuntimeSample(testCase) ? testCase.sampleId : String(testCase.id)
    )),
    participants,
    excludeCopiedParticipantIds: e4bImports.map((item) => item.participantId),
});

let imported = 0;
for (const item of e4bImports) {
    const sourcePath = path.join(outputDir, item.sourceRunId, 'translations.jsonl');
    const rows = readJsonlRecords<TranslationArtifactRecord>(sourcePath)
        .filter((record) => record.participant_id === item.participantId);
    if (rows.length !== 648) {
        throw new Error(`${item.participantId} from ${item.sourceRunId} has ${rows.length} rows, expected 648`);
    }

    for (const record of rows) {
        writeJsonlRecord(
            fork.layout.translationJsonlPath,
            rewriteTranslationRecordForRun(record, newRunId, item.sourceRunId) as unknown as Record<string, unknown>,
        );
        imported += 1;
    }

    const metricsPath = path.join(outputDir, item.sourceRunId, 'translation-metrics.jsonl');
    if (fs.existsSync(metricsPath)) {
        const metrics = readJsonlRecords<{ stable_key: string }>(metricsPath);
        const byOldKey = new Map(rows.map((record) => [
            record.stable_key,
            `${newRunId}::${record.source_id}::${record.target_language}::${record.participant_id}`,
        ]));
        for (const metric of metrics) {
            const nextKey = byOldKey.get(metric.stable_key);
            if (nextKey) {
                writeJsonlRecord(fork.layout.translationMetricsJsonlPath, { ...metric, stable_key: nextKey });
            }
        }
    }
}

console.log(`prepared ${newRunId}`);
console.log(`forked translations=${fork.translationCount} imported e4b=${imported}`);
