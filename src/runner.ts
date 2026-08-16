import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BenchmarkConfig } from './benchmark-config.js';
import {
    buildStableKey,
    type NormalizedJudgeRecord,
    type TargetLanguageCode,
} from './benchmark-types.js';
import type { ContextRuntimeSample } from './context-benchmark-types.js';
import { isContextRuntimeSample } from './context-dataset.js';
import {
    renderContextJudgeTemplateVariables,
    renderContextModelInput,
} from './context-serialization.js';
import { interpolatePrompt, SUPPORTED_LANGUAGES } from './gemini.js';
import { normalizeDeepLError } from './deepl.js';
import { normalizeDeepSeekError } from './deepseek.js';
import { normalizeGeminiError } from './gemini.js';
import { normalizeGoogleTranslateBasicError } from './google-translate-basic.js';
import { normalizeGoogleWebError } from './google-web.js';
import { loadGembaAssets } from './gemba-assets.js';
import type { JudgeScore } from './judge.js';
import type {
    Condition,
    NormalizedClientError,
    Provider,
    TranslationResult,
} from './llm-client.js';
import { normalizeOpenRouterError } from './openrouter.js';
import { OpenRouterBatchGembaJudge } from './openrouter-batch-judge.js';
import { normalizePapagoError } from './papago.js';
import type { ParticipantDefinition } from './participant-registry.js';
import {
    normalizeJudgeFailure,
    normalizeJudgeResponse,
} from './normalize-gemba.js';
import { normalizeQwenError } from './qwen.js';
import { normalizeLlamaCppError } from './llamacpp.js';
import {
    executeWithRetries,
    type ExecuteWithRetriesInput,
} from './retry-executor.js';
import {
    computeFileSha256,
    createRunLayout,
    getUnresolvedTranslationFailureRecords,
    loadRunManifest,
    readJsonlRecords,
    type RunManifestV3,
    type TranslationFailureArtifactRecord,
    updateRunManifest,
    writeJsonlRecord,
    type JudgeBackend,
} from './run-artifacts.js';
import {
    createCoalescedRunStateWriter,
    renderRunEvent,
    sanitizePersistedErrorText,
    toRunStateEventSummary,
    truncatePreview,
    writeRunEvent,
    type RunEventRecord,
    type RunStateEventSummary,
    type RunStateInflightItem,
    type RunStateParticipantSnapshot,
    type RunStateThrottleBucketSnapshot,
} from './run-observability.js';
import { buildBenchmarkReports, buildCommonCellReports } from './reporting.js';
import { createProgressReporter } from './progress-reporter.js';
import { aggregateRunCosts, type BenchmarkPhase, type CallUsageMetrics } from './run-metrics.js';
import {
    buildVertexJudgeRequest,
    judgeWithRetries,
    type JudgeResult,
    type JudgeRetryExecutorOptions,
} from './vertex-judge.js';
import { runWorkQueue } from './work-queue.js';

export interface ConditionResult {
    label: string;
    provider: string;
    model: string;
    output: string;
    latencyMs: number;
    judge: JudgeScore;
}

export interface LangResult {
    targetLang: string;
    conditions: ConditionResult[];
}

export interface TestResult {
    id: string | number;
    sourceId: string;
    source: string;
    sourceLang: string;
    translations: LangResult[];
}

export interface ConditionLatencyStats {
    avg: number;
    min: number;
    max: number;
}

export interface ConditionScoreStats {
    avgAccuracy: number;
    avgFluency: number;
    avgTone: number;
    avgFormat: number;
    avgTotal: number;
}

export interface LangStats {
    latencies: { [label: string]: ConditionLatencyStats };
    scores: { [label: string]: ConditionScoreStats };
}

export interface TestSummary {
    timestamp: string;
    judgeModel: string;
    conditions: {
        label: string;
        provider: string;
        model: string;
        promptFile: string;
        dataFile: string;
    }[];
    totalSentences: number;
    totalTranslations: number;
    targetLangs: string[];
    prompts: { [label: string]: string };
    results: TestResult[];
    summaryByLang: { [lang: string]: LangStats };
    summaryOverall: LangStats;
}

export interface RunnerOptions {
    benchmarkId: string;
    promptVersion: string;
    judgePromptVersion: string;
    judgeBackend?: JudgeBackend;
    geminiCliBin?: string;
    outputDir: string;
    runId: string;
    forkFromRunId?: string;
    delayMs: number;
    limit?: number;
    limitApplied?: number;
    resume: boolean;
    judgeModelId?: string;
    participants?: ParticipantDefinition[];
    translationConcurrency?: number;
    translationConcurrencyPerModel?: number;
    translationRetryNow?: ExecuteWithRetriesInput<TranslationResult>['now'];
    translationRetryRandom?: ExecuteWithRetriesInput<TranslationResult>['random'];
    translationRetrySleep?: ExecuteWithRetriesInput<TranslationResult>['sleep'];
    judgeConcurrency?: number;
    skipTranslationPhase?: boolean;
    log?: (line: string) => void;
}

export interface JudgeClient {
    preflight(): Promise<void>;
    judge(request: ReturnType<typeof buildVertexJudgeRequest>): Promise<JudgeResult>;
}

/**
 * Batch judge backends resolve items by stable key after a whole-workload
 * submission; per-item retries are meaningless there because retries happen at
 * job level inside the adapter.
 */
export interface BatchJudgeClient extends JudgeClient {
    judgeItem(stableKey: string): Promise<{ ok: boolean; rawText: string; usage: CallUsageMetrics }>;
}

async function resolveJudgeResult(
    judgeClient: JudgeClient,
    request: ReturnType<typeof buildVertexJudgeRequest>,
    stableKey: string,
    retryOptions: JudgeRetryExecutorOptions,
): Promise<{ ok: boolean; rawText: string; usage: CallUsageMetrics }> {
    if ('judgeItem' in judgeClient) {
        return (judgeClient as BatchJudgeClient).judgeItem(stableKey);
    }

    return judgeWithRetries(judgeClient, request, 3, retryOptions);
}

type TranslationMetricsRecord = CallUsageMetrics & { stable_key: string };
type JudgeMetricsRecord = CallUsageMetrics & { stable_key: string };
type TranslationWorkItem = {
    condition: Condition;
    sourceId: string;
    sourcePreview: string;
    sourceLang: string;
    translationInput: string;
    artifactSource: string;
    contextArtifactFields?: ContextArtifactFields;
    targetLanguageCode: TargetLanguageCode;
    targetLanguageLabel: string;
    participantId: string;
    participantModelId: string;
    provider: Provider;
    throttleBucketKey: string;
    stableKey: string;
};

type ContextArtifactFields = Pick<TranslationArtifactRecord,
    'dataset_kind'
    | 'context_turn_count'
    | 'speaker_mode'
    | 'context_expectation'
    | 'primary_phenomenon'
    | 'secondary_phenomena'
>;

type BenchmarkCaseLookupEntry = {
    sourceId: string;
    resultId: string | number;
    source: string;
    sourceLang: string;
    order: number;
    contextSample?: ContextRuntimeSample;
};

export type PendingJudgeWorkItem = TranslationArtifactRecord & {
    contextSample?: ContextRuntimeSample;
};

type PhaseParticipantState = RunStateParticipantSnapshot & {
    initialCompleted: number;
    lastFailureAt: string | null;
};

type ThrottleBucketDebugState = RunStateThrottleBucketSnapshot;

type ThrottleBucketState = {
    key: string;
    participantIds: string[];
    queuesByParticipantId: Map<string, TranslationWorkItem[]>;
    nextParticipantIndex: number;
    cooldownUntilMs: number;
};

export interface TranslationArtifactRecord {
    stable_key: string;
    source_id: string;
    source: string;
    source_lang: string;
    dataset_kind?: 'sentence' | 'context';
    target_language: 'en' | 'ja' | 'zh-Hans';
    target_language_label: string;
    participant_id: string;
    participant_model_id: string;
    translation: string;
    context_turn_count?: NormalizedJudgeRecord['context_turn_count'];
    speaker_mode?: NormalizedJudgeRecord['speaker_mode'];
    context_expectation?: NormalizedJudgeRecord['context_expectation'];
    primary_phenomenon?: NormalizedJudgeRecord['primary_phenomenon'];
    secondary_phenomena?: ContextRuntimeSample['secondaryPhenomena'];
}

function buildJudgeContextMetadata(record: TranslationArtifactRecord): Partial<Pick<NormalizedJudgeRecord,
    'context_turn_count'
    | 'speaker_mode'
    | 'context_expectation'
    | 'primary_phenomenon'
>> | undefined {
    if (
        record.context_turn_count === undefined
        && record.speaker_mode === undefined
        && record.context_expectation === undefined
        && record.primary_phenomenon === undefined
    ) {
        return undefined;
    }

    return {
        context_turn_count: record.context_turn_count,
        speaker_mode: record.speaker_mode,
        context_expectation: record.context_expectation,
        primary_phenomenon: record.primary_phenomenon,
    };
}

export function buildPendingJudgeWorkItems(
    translations: TranslationArtifactRecord[],
    completedStableKeys: Set<string>,
    contextSamplesBySourceId: ReadonlyMap<string, ContextRuntimeSample> = new Map(),
): PendingJudgeWorkItem[] {
    return translations
        .filter((record) => !completedStableKeys.has(record.stable_key))
        .map((record) => {
            const contextSample = contextSamplesBySourceId.get(record.source_id);

            if (contextSample !== undefined) {
                return {
                    ...record,
                    contextSample,
                };
            }

            if (record.dataset_kind === 'context') {
                throw new Error(
                    `Missing context sample for persisted source_id ${record.source_id} while rebuilding pending judge work items.`,
                );
            }

            return { ...record };
        });
}

/**
 * Fisher-Yates shuffle for fair ordering of conditions.
 */
function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

export class TestRunner {
    constructor(
        private readonly benchmarkConfig: BenchmarkConfig,
        private readonly conditions: Condition[],
        private readonly judge: JudgeClient | null,
        private readonly options: RunnerOptions,
    ) {
    }

    async run(): Promise<TestSummary> {
        const conditions = this.conditions;
        let resumeManifest: RunManifestV3 | null = null;

        if (conditions.length === 0) {
            throw new Error('At least one condition is required to run the benchmark.');
        }

        if (this.options.resume && this.benchmarkConfig.datasetKind === 'context') {
            resumeManifest = loadRunManifest(this.options.outputDir, this.options.runId, 'resume');
            assertActiveContextDatasetFingerprintMatchesManifest(
                resumeManifest,
                this.benchmarkConfig.dataFile,
            );
        }

        // Use the first condition's test cases to determine iteration count
        // (each condition may have different data, but we iterate up to limit)
        const maxCases = this.options.limit !== undefined
            ? Math.min(this.options.limit, ...conditions.map(c => c.testCases.length))
            : Math.min(...conditions.map(c => c.testCases.length));
        const benchmarkCaseLookup = this.buildBenchmarkCaseLookup(maxCases);
        const contextSamplesBySourceId = new Map(
            Array.from(benchmarkCaseLookup.values())
                .flatMap((entry) => entry.contextSample === undefined ? [] : [[entry.sourceId, entry.contextSample] as const]),
        );

        const requestedManifestParticipants = resolveManifestParticipants(
            this.conditions,
            this.options.participants,
            this.benchmarkConfig.sharedPromptFile,
        );

        const layout = createRunLayout(this.options.outputDir, {
            manifestVersion: 3,
            runId: this.options.runId,
            benchmarkId: this.options.benchmarkId,
            datasetVersion: path.basename(this.benchmarkConfig.dataFile),
            datasetKind: this.benchmarkConfig.datasetKind,
            judgeModelId: this.options.judgeModelId ?? null,
            promptVersion: this.options.promptVersion,
            judgePromptVersion: this.options.judgePromptVersion,
            judgePromptSetId: this.benchmarkConfig.judgePromptSetId,
            judgeBackend: this.options.judgeBackend ?? 'vertex',
            targetLanguages: [...this.benchmarkConfig.targetLanguages],
            targetLanguageLabels: { ...this.benchmarkConfig.targetLanguageLabels },
            limitApplied: this.options.limitApplied ?? maxCases,
            participants: requestedManifestParticipants,
            forkFromRunId: this.options.forkFromRunId,
            translationConcurrencyPerModel:
                this.options.translationConcurrencyPerModel
                ?? this.options.translationConcurrency
                ?? 1,
            vertexProject: process.env.GOOGLE_CLOUD_PROJECT ?? null,
            vertexRegion: process.env.GOOGLE_CLOUD_LOCATION ?? null,
            geminiCliBin: this.options.geminiCliBin,
            vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
            resume: this.options.resume,
        });
        const manifest = resumeManifest ?? loadRunManifest(this.options.outputDir, this.options.runId, 'resume');
        if (manifest.forkFromRunId !== undefined && this.options.resume) {
            // A fork is only resumable after prepareForkRun completed all
            // copies (carried-forward failures in particular). Without the
            // marker, resume could regenerate paid cells that a crash left
            // half-copied. Recovery: delete the partial run directory and
            // re-run the fresh fork command.
            const forkPreparedMarkerPath = path.join(layout.runDir, 'fork-prepared.json');
            if (!fs.existsSync(forkPreparedMarkerPath)) {
                throw new Error(
                    `Cannot resume fork run ${this.options.runId}: fork-prepared.json is missing, so the fork prepare did not complete atomically. Delete the partial run directory (${layout.runDir}) and re-run the fresh fork command (--fork-from-run ${manifest.forkFromRunId}) to avoid regenerating paid cells.`,
                );
            }
        }
        const manifestParticipants = manifest.participants;
        const allTargetLangs = [...manifest.targetLanguages];

        const existingTranslationRecords = readJsonlRecords<TranslationArtifactRecord>(layout.translationJsonlPath);
        const existingTranslationFailureRecords = readJsonlRecords<TranslationFailureArtifactRecord>(
            layout.translationFailuresJsonlPath,
        );
        const translationRecordByStableKey = new Map(
            existingTranslationRecords.map((record) => [record.stable_key, record]),
        );
        const unresolvedTranslationFailures = getUnresolvedTranslationFailureRecords(
            existingTranslationRecords,
            existingTranslationFailureRecords,
        );
        const persistedRunEvents = [
            ...readJsonlRecords<RunEventRecord>(layout.translationEventsJsonlPath),
            ...readJsonlRecords<RunEventRecord>(layout.judgeEventsJsonlPath),
        ];
        const persistedRetryEvents = persistedRunEvents.filter((event) => event.event_type === 'retry');
        const persistedTranslationRetryEvents = persistedRetryEvents.filter((event) => event.phase === 'translation');
        const persistedJudgeRetryEvents = persistedRetryEvents.filter((event) => event.phase === 'judge');
        const persistedFailureEvents = persistedRunEvents.filter((event) => event.event_type === 'failure');
        const unresolvedTranslationFailureStableKeys = new Set(
            unresolvedTranslationFailures.map((record) => record.stable_key),
        );
        const log = this.options.log ?? console.log;
        const participantOrder = manifestParticipants.map((participant) => participant.participantId);
        const providerByParticipantId = new Map(
            manifestParticipants.map((participant) => [participant.participantId, participant.provider]),
        );
        const participantRetryCountById = countBy(
            persistedRetryEvents.filter((event): event is RunEventRecord & { participant_id: string } => event.participant_id !== null),
            (event) => event.participant_id,
        );
        const participantStateById = new Map<string, PhaseParticipantState>();
        const throttleBucketStateByKey = new Map<string, ThrottleBucketDebugState>();
        const inflightItems = new Map<string, RunStateInflightItem>();
        const recentFailures: RunStateEventSummary[] = buildInitialRecentFailureSummaries(
            existingTranslationFailureRecords,
            persistedFailureEvents,
        );
        const recentRetries: RunStateEventSummary[] = buildRecentEventSummaries(persistedRetryEvents, 10);
        let currentPhase: BenchmarkPhase | 'complete' = 'translation';
        let currentOverallState = {
            completed: 0,
            succeeded: 0,
            failed: 0,
            retryCount: 0,
        };
        let cumulativeRetryCount = persistedRetryEvents.length;
        const runStateWriter = createCoalescedRunStateWriter({
            filePath: layout.runStatePath,
        });

        const writePhaseState = () => {
            runStateWriter.update({
                currentPhase,
                updatedAt: new Date().toISOString(),
                overall: {
                    ...currentOverallState,
                    cumulativeRetryCount,
                },
                participants: participantOrder
                    .map((participantId) => participantStateById.get(participantId))
                    .filter((participant): participant is PhaseParticipantState => participant !== undefined)
                    .map(({ initialCompleted: _initialCompleted, lastFailureAt: _lastFailureAt, ...participant }) => ({
                        ...participant,
                    })),
                throttleBuckets: Array.from(throttleBucketStateByKey.values()),
                inflightItems: Array.from(inflightItems.values()),
                recentFailures: [...recentFailures],
                recentRetries: [...recentRetries],
            });
        };

        const pushRecentEvent = (
            target: RunStateEventSummary[],
            event: RunEventRecord,
            limit: number,
        ) => {
            target.unshift(toRunStateEventSummary(event));
            if (target.length > limit) {
                target.length = limit;
            }
        };

        const emitRunEvent = (
            filePath: string,
            category: 'retry' | 'failure' | null,
            event: Record<string, unknown>,
        ) => {
            const record = writeRunEvent(filePath, event);
            log(renderRunEvent(record));

            if (category === 'retry') {
                pushRecentEvent(recentRetries, record, 10);
            } else if (category === 'failure') {
                pushRecentEvent(recentFailures, record, 5);
            }

            writePhaseState();
            return record;
        };

        if (!this.options.skipTranslationPhase) {
            const existingTranslationMetrics = readJsonlRecords<TranslationMetricsRecord>(layout.translationMetricsJsonlPath);
            const translationRetryNow = this.options.translationRetryNow ?? Date.now;
            const translationRetrySleep = this.options.translationRetrySleep ?? (async (ms: number) => {
                await this.delay(ms);
            });
            const translationConcurrencyPerBucket = this.options.translationConcurrencyPerModel
                ?? this.options.translationConcurrency
                ?? 1;
            const allTranslationItems = this.buildTranslationWorkItems(maxCases);

            let translationCompleted = existingTranslationRecords.length + unresolvedTranslationFailures.length;
            let translationSucceeded = existingTranslationRecords.length;
            let translationFailed = unresolvedTranslationFailures.length;
            let translationActive = 0;
            let translationCostUsd = existingTranslationMetrics.reduce(
                (sum, record) => sum + (record.computedCostUsd ?? 0),
                0,
            );

            const translationItems = allTranslationItems
                .filter((item) => !translationRecordByStableKey.has(item.stableKey))
                .filter((item) => !unresolvedTranslationFailureStableKeys.has(item.stableKey));
            const translationInitialCompleted = translationCompleted;
            const translationReporter = createProgressReporter({
                phase: 'translation',
                total: translationCompleted + translationItems.length,
                log,
            });

            currentPhase = 'translation';
            currentOverallState = {
                completed: translationCompleted,
                succeeded: translationSucceeded,
                failed: translationFailed,
                retryCount: persistedTranslationRetryEvents.length,
            };
            participantStateById.clear();
            for (const [participantId, state] of createPhaseParticipantStateMap({
                participantIds: participantOrder,
                totalsByParticipantId: countBy(allTranslationItems, (item) => item.participantId),
                completedByParticipantId: countBy([
                    ...existingTranslationRecords.map((record) => record.participant_id),
                    ...unresolvedTranslationFailures.map((record) => record.participant_id),
                ], (participantId) => participantId),
                succeededByParticipantId: countBy(existingTranslationRecords, (record) => record.participant_id),
                failedByParticipantId: countBy(unresolvedTranslationFailures, (record) => record.participant_id),
                lastFailureAtByParticipantId: latestTimestampBy(unresolvedTranslationFailures, (record) => record.participant_id, (record) => record.recorded_at),
                retryCountByParticipantId: participantRetryCountById,
            })) {
                participantStateById.set(participantId, state);
            }
            syncThrottleBucketDebugState(
                throttleBucketStateByKey,
                buildThrottleBucketStates(allTranslationItems),
                buildThrottleBucketStates(translationItems),
            );

            const updateTranslationProgress = () => {
                translationReporter.update({
                    completed: translationCompleted,
                    succeeded: translationSucceeded,
                    failed: translationFailed,
                    activeWorkers: translationActive,
                    totalCostUsd: translationCostUsd,
                    retryCount: currentOverallState.retryCount,
                    initialCompleted: translationInitialCompleted,
                    participantSnapshots: buildProgressParticipantSnapshots(participantStateById, participantOrder),
                });
            };

            writePhaseState();
            updateTranslationProgress();

            await runThrottleBucketQueues({
                buckets: buildThrottleBucketStates(translationItems),
                concurrencyPerBucket: translationConcurrencyPerBucket,
                worker: async (item, throttleBucket) => {
                    const participantState = getOrCreatePhaseParticipantState(participantStateById, item.participantId);
                    const bucketState = getOrCreateThrottleBucketDebugState(
                        throttleBucketStateByKey,
                        item.throttleBucketKey,
                        [item.participantId],
                    );
                    translationActive += 1;
                    participantState.inflight += 1;
                    bucketState.inflight += 1;
                    bucketState.queued = Math.max(bucketState.queued - 1, 0);
                    inflightItems.set(item.stableKey, {
                        phase: 'translation',
                        stableKey: item.stableKey,
                        throttleBucketKey: item.throttleBucketKey,
                        participantId: item.participantId,
                        participantModelId: item.participantModelId,
                        provider: item.provider,
                        sourceId: item.sourceId,
                        sourcePreview: truncatePreview(item.sourcePreview),
                        sourceLang: item.sourceLang,
                        targetLanguage: item.targetLanguageCode,
                        attempt: 1,
                        startedAt: new Date().toISOString(),
                        requestTimeoutMs: item.condition.client.getRequestTimeoutMs(),
                    });
                    writePhaseState();

                    try {
                        let attemptsUsed = 1;

                        try {
                            const result = await executeWithRetries({
                                maxAttempts: 5,
                                operation: async () => {
                                    await waitForThrottleBucketCooldown(
                                        throttleBucket,
                                        translationRetryNow,
                                        translationRetrySleep,
                                        () => {
                                            if (bucketState.cooldownUntil === null) {
                                                return;
                                            }

                                            bucketState.cooldownUntil = null;
                                            emitRunEvent(layout.translationEventsJsonlPath, null, {
                                                scope: 'throttle_bucket',
                                                phase: 'translation',
                                                event_type: 'throttle_bucket_cooldown_end',
                                                throttle_bucket_key: item.throttleBucketKey,
                                            });
                                        },
                                    );

                                    if (this.options.delayMs > 0) {
                                        await translationRetrySleep(this.options.delayMs);
                                    }

                                    return await item.condition.client.translate(
                                        item.translationInput,
                                        item.condition.prompt,
                                        item.sourceLang,
                                        item.targetLanguageLabel,
                                    );
                                },
                                classify: (error) => normalizeTranslationError(
                                    item.provider,
                                    error,
                                    item.condition.client.getRequestTimeoutMs(),
                                ),
                                now: this.options.translationRetryNow,
                                random: this.options.translationRetryRandom,
                                sleep: this.options.translationRetrySleep,
                                onFailure: async (event) => {
                                    attemptsUsed = event.attempt;
                                    const inflightState = inflightItems.get(item.stableKey);
                                    if (inflightState) {
                                        inflightState.attempt = event.attempt + (event.willRetry ? 1 : 0);
                                    }

                                    if (event.throttleBucketCooldown !== null) {
                                        applyThrottleBucketCooldown(
                                            throttleBucket,
                                            event.throttleBucketCooldown.delayMs,
                                            translationRetryNow,
                                        );
                                        bucketState.cooldownUntil = new Date(throttleBucket.cooldownUntilMs).toISOString();
                                        emitRunEvent(layout.translationEventsJsonlPath, null, {
                                            scope: 'throttle_bucket',
                                            phase: 'translation',
                                            event_type: 'throttle_bucket_cooldown_start',
                                            throttle_bucket_key: item.throttleBucketKey,
                                            attempt: event.attempt,
                                            max_attempts: event.maxAttempts,
                                            error_class: event.normalizedError.errorClass,
                                            error_summary: event.normalizedError.rawMessage,
                                            raw_error_message: event.normalizedError.rawMessage,
                                            next_delay_ms: event.throttleBucketCooldown.delayMs,
                                        });
                                    }

                                    if (event.willRetry) {
                                        currentOverallState.retryCount += 1;
                                        cumulativeRetryCount += 1;
                                        participantRetryCountById.set(
                                            item.participantId,
                                            (participantRetryCountById.get(item.participantId) ?? 0) + 1,
                                        );
                                        participantState.retryCount += 1;
                                        emitRunEvent(layout.translationEventsJsonlPath, 'retry', {
                                            scope: 'item',
                                            phase: 'translation',
                                            event_type: 'retry',
                                            throttle_bucket_key: item.throttleBucketKey,
                                            stable_key: item.stableKey,
                                            source_id: item.sourceId,
                                            source_preview: item.sourcePreview,
                                            source_lang: item.sourceLang,
                                            target_language: item.targetLanguageCode,
                                            participant_id: item.participantId,
                                            participant_model_id: item.participantModelId,
                                            provider: item.provider,
                                            attempt: event.attempt,
                                            max_attempts: event.maxAttempts,
                                            error_class: event.normalizedError.errorClass,
                                            error_summary: event.normalizedError.rawMessage,
                                            raw_error_message: event.normalizedError.rawMessage,
                                            next_delay_ms: event.retryDelayMs,
                                        });
                                    }
                                },
                            });

                            const artifactRecord: TranslationArtifactRecord = {
                                stable_key: item.stableKey,
                                source_id: item.sourceId,
                                source: item.artifactSource,
                                source_lang: item.sourceLang,
                                target_language: item.targetLanguageCode,
                                target_language_label: item.targetLanguageLabel,
                                participant_id: item.participantId,
                                participant_model_id: item.participantModelId,
                                translation: result.output,
                                ...item.contextArtifactFields,
                            };

                            writeJsonlRecord(layout.translationJsonlPath, { ...artifactRecord });
                            writeJsonlRecord(layout.translationMetricsJsonlPath, {
                                stable_key: item.stableKey,
                                ...result.usage,
                            });
                            translationRecordByStableKey.set(item.stableKey, artifactRecord);
                            translationCompleted += 1;
                            translationSucceeded += 1;
                            translationCostUsd += result.usage.computedCostUsd ?? 0;
                            currentOverallState.completed = translationCompleted;
                            currentOverallState.succeeded = translationSucceeded;
                            participantState.completed += 1;
                            participantState.succeeded += 1;
                            participantState.remaining = Math.max(participantState.remaining - 1, 0);

                            if (attemptsUsed > 1) {
                                emitRunEvent(layout.translationEventsJsonlPath, null, {
                                    scope: 'item',
                                    phase: 'translation',
                                    event_type: 'recovered',
                                    throttle_bucket_key: item.throttleBucketKey,
                                    stable_key: item.stableKey,
                                    source_id: item.sourceId,
                                    source_preview: item.sourcePreview,
                                    source_lang: item.sourceLang,
                                    target_language: item.targetLanguageCode,
                                    participant_id: item.participantId,
                                    participant_model_id: item.participantModelId,
                                    provider: item.provider,
                                    attempt: attemptsUsed,
                                    max_attempts: 5,
                                    latency_ms: result.latencyMs,
                                });
                            }
                        } catch (error) {
                            const normalized = normalizeTranslationError(
                                item.provider,
                                error,
                                item.condition.client.getRequestTimeoutMs(),
                            );
                            const failureRecord: TranslationFailureArtifactRecord = {
                                recorded_at: new Date().toISOString(),
                                stable_key: item.stableKey,
                                participant_id: item.participantId,
                                participant_model_id: item.participantModelId,
                                provider: item.provider,
                                source_id: item.sourceId,
                                source_lang: item.sourceLang,
                                target_language: item.targetLanguageCode,
                                final_disposition: normalized.retryable ? 'retry_exhausted' : 'terminal_deterministic',
                                error_class: normalized.errorClass,
                                attempts_used: attemptsUsed,
                                last_error_summary: sanitizePersistedErrorText(normalized.rawMessage),
                            };

                            writeJsonlRecord(layout.translationFailuresJsonlPath, {
                                ...failureRecord,
                            } as unknown as Record<string, unknown>);
                            translationCompleted += 1;
                            translationFailed += 1;
                            currentOverallState.completed = translationCompleted;
                            currentOverallState.failed = translationFailed;
                            participantState.completed += 1;
                            participantState.failed += 1;
                            participantState.remaining = Math.max(participantState.remaining - 1, 0);
                            participantState.lastFailureAt = failureRecord.recorded_at;
                            emitRunEvent(layout.translationEventsJsonlPath, 'failure', {
                                scope: 'item',
                                phase: 'translation',
                                event_type: 'failure',
                                throttle_bucket_key: item.throttleBucketKey,
                                stable_key: item.stableKey,
                                source_id: item.sourceId,
                                source_preview: item.sourcePreview,
                                source_lang: item.sourceLang,
                                target_language: item.targetLanguageCode,
                                participant_id: item.participantId,
                                participant_model_id: item.participantModelId,
                                provider: item.provider,
                                attempt: attemptsUsed,
                                max_attempts: 5,
                                error_class: normalized.errorClass,
                                error_summary: normalized.rawMessage,
                                raw_error_message: normalized.rawMessage,
                            });
                        }
                    } finally {
                        translationActive -= 1;
                        participantState.inflight = Math.max(participantState.inflight - 1, 0);
                        bucketState.inflight = Math.max(bucketState.inflight - 1, 0);
                        inflightItems.delete(item.stableKey);
                        updateTranslationProgress();
                        writePhaseState();
                    }
                },
            });

            translationReporter.flush({
                completed: translationCompleted,
                succeeded: translationSucceeded,
                failed: translationFailed,
                activeWorkers: translationActive,
                totalCostUsd: translationCostUsd,
                retryCount: currentOverallState.retryCount,
                initialCompleted: translationInitialCompleted,
                participantSnapshots: buildProgressParticipantSnapshots(participantStateById, participantOrder),
            });
        }

        const translationRecords = readJsonlRecords<TranslationArtifactRecord>(layout.translationJsonlPath);
        const translationFailureRecords = readJsonlRecords<TranslationFailureArtifactRecord>(layout.translationFailuresJsonlPath);
        const translationMetrics = readJsonlRecords<TranslationMetricsRecord>(layout.translationMetricsJsonlPath);
        const results = this.buildResultsFromArtifacts(translationRecords, translationMetrics, benchmarkCaseLookup);

        if (this.judge !== null) {
            if (!this.options.judgeModelId) {
                throw new Error('judgeModelId is required when judge execution is enabled.');
            }

            const judgeClient = this.judge;
            const judgeModelId = this.options.judgeModelId;
            const existingNormalizedJudgeRecords = readJsonlRecords<NormalizedJudgeRecord>(layout.normalizedJudgeJsonlPath);

            const completedStableKeys = new Set(
                existingNormalizedJudgeRecords.map((record) => record.stable_key),
            );

            const pendingJudgeItems = buildPendingJudgeWorkItems(
                translationRecords,
                completedStableKeys,
                contextSamplesBySourceId,
            );

            if (pendingJudgeItems.length > 0) {
                const gembaAssets = loadJudgeAssets(this.options.judgePromptVersion);
                const existingJudgeMetrics = readJsonlRecords<JudgeMetricsRecord>(layout.judgeMetricsJsonlPath);
                // A crash between the metrics write and the normalized write
                // would re-judge the cell on resume; dedupe so cost accounting
                // never aggregates the same stable key twice.
                const judgeMetricsByStableKey = new Set(existingJudgeMetrics.map((record) => record.stable_key));
                const judgeBucketKey = buildJudgeThrottleBucketKey(this.options.judgeBackend ?? 'vertex', judgeModelId);
                let judgeCompleted = completedStableKeys.size;
                let judgeSucceeded = existingNormalizedJudgeRecords.filter((record) => record.status === 'ok').length;
                let judgeFailed = existingNormalizedJudgeRecords.filter((record) => record.status !== 'ok').length;
                let judgeActive = 0;
                let judgeCostUsd = existingJudgeMetrics.reduce((sum, record) => sum + (record.computedCostUsd ?? 0), 0);
                const judgeInitialCompleted = judgeCompleted;
                const judgeReporter = createProgressReporter({
                    phase: 'judge',
                    total: translationRecords.length,
                    log,
                });

                currentPhase = 'judge';
                currentOverallState = {
                    completed: judgeCompleted,
                    succeeded: judgeSucceeded,
                    failed: judgeFailed,
                    retryCount: persistedJudgeRetryEvents.length,
                };
                participantStateById.clear();
                for (const [participantId, state] of createPhaseParticipantStateMap({
                    participantIds: participantOrder,
                    totalsByParticipantId: countBy(translationRecords, (record) => record.participant_id),
                    completedByParticipantId: countBy(existingNormalizedJudgeRecords, (record) => record.participant_id),
                    succeededByParticipantId: countBy(
                        existingNormalizedJudgeRecords.filter((record) => record.status === 'ok'),
                        (record) => record.participant_id,
                    ),
                    failedByParticipantId: countBy(
                        existingNormalizedJudgeRecords.filter((record) => record.status !== 'ok'),
                        (record) => record.participant_id,
                    ),
                    retryCountByParticipantId: participantRetryCountById,
                })) {
                    participantStateById.set(participantId, state);
                }
                throttleBucketStateByKey.set(judgeBucketKey, {
                    throttleBucketKey: judgeBucketKey,
                    participantIds: Array.from(new Set(translationRecords.map((record) => record.participant_id))),
                    inflight: 0,
                    queued: pendingJudgeItems.length,
                    cooldownUntil: null,
                });

                const updateJudgeProgress = () => {
                    judgeReporter.update({
                        completed: judgeCompleted,
                        succeeded: judgeSucceeded,
                        failed: judgeFailed,
                        activeWorkers: judgeActive,
                        totalCostUsd: judgeCostUsd,
                        initialCompleted: judgeInitialCompleted,
                        retryCount: currentOverallState.retryCount,
                    });
                };

                const collectedBatchJudgeRequests: Array<{
                    stableKey: string;
                    request: ReturnType<typeof buildVertexJudgeRequest>;
                }> = [];
                const isBatchJudgeBackend = this.options.judgeBackend === 'openrouter-batch';

                for (const item of pendingJudgeItems) {
                    if (!isBatchJudgeBackend) {
                        continue;
                    }

                    collectedBatchJudgeRequests.push({
                        stableKey: item.stable_key,
                        request: buildVertexJudgeRequest({
                            model: judgeModelId,
                            systemPrompt: gembaAssets.systemPrompt,
                            fewShotMessages: gembaAssets.fewShotMessages,
                            userPromptTemplate: gembaAssets.userPromptTemplate,
                            templateVariables: buildJudgeTemplateVariables(item),
                        }),
                    });
                }

                if (isBatchJudgeBackend) {
                    const batchJudge = this.judge as unknown as OpenRouterBatchGembaJudge | null;
                    if (!batchJudge) {
                        throw new Error('openrouter-batch judge backend requires a judge client');
                    }

                    const identity = batchJudge.getEndpointIdentity();
                    if (manifest.openRouterBatchApiBaseUrl !== undefined && manifest.openRouterBatchApiBaseUrl !== identity.apiBaseUrl) {
                        throw new Error(`openrouter-batch endpoint mismatch on resume: manifest recorded ${manifest.openRouterBatchApiBaseUrl}, current config is ${identity.apiBaseUrl}`);
                    }

                    if (manifest.openRouterBatchModelId !== undefined && manifest.openRouterBatchModelId !== identity.model) {
                        throw new Error(`openrouter-batch model mismatch on resume: manifest recorded ${manifest.openRouterBatchModelId}, current config is ${identity.model}`);
                    }

                    if ((manifest.openRouterBatchJobIds?.length ?? 0) > 0 && manifest.openRouterBatchApiBaseUrl === undefined) {
                        // Legacy manifest (job ids without endpoint identity): backfill
                        // the current identity so future resumes validate.
                        updateRunManifest(layout, {
                            openRouterBatchApiBaseUrl: identity.apiBaseUrl,
                            openRouterBatchModelId: identity.model,
                        });
                        log('openrouter-batch: backfilled endpoint identity into legacy manifest');
                    }

                    const prepared = await batchJudge.prepareBatch({
                        runDir: layout.runDir,
                        requests: collectedBatchJudgeRequests,
                        existingJobIds: manifest.openRouterBatchJobIds,
                        onJobStatus: (info) => {
                            log(`batch judge job ${info.jobId}: ${info.status} (${info.completed}/${info.total})`);
                        },
                        onNewJobIds: (jobIds) => {
                            // Persist immediately after each submit so a crash or
                            // poll interruption can resume without double-spending.
                            updateRunManifest(layout, {
                                openRouterBatchJobIds: jobIds,
                                openRouterBatchApiBaseUrl: identity.apiBaseUrl,
                                openRouterBatchModelId: identity.model,
                            });
                        },
                    });

                    if (prepared.newJobIds.length > 0) {
                        log(`OpenRouter batch judge job(s) submitted: ${prepared.newJobIds.join(', ')}`);
                    }

                    for (const jobCost of prepared.jobCosts) {
                        if (jobCost.costUsd !== null) {
                            log(`batch judge job ${jobCost.jobId}: authoritative cost $${jobCost.costUsd}`);
                        }
                    }
                }

                writePhaseState();
                await this.judge.preflight();
                updateJudgeProgress();

                await runWorkQueue<PendingJudgeWorkItem>({
                    items: pendingJudgeItems,
                    concurrency: this.options.judgeConcurrency ?? 1,
                    worker: async (item) => {
                        const participantState = getOrCreatePhaseParticipantState(participantStateById, item.participant_id);
                        const bucketState = getOrCreateThrottleBucketDebugState(
                            throttleBucketStateByKey,
                            judgeBucketKey,
                            [item.participant_id],
                        );
                        judgeActive += 1;
                        participantState.inflight += 1;
                        bucketState.inflight += 1;
                        bucketState.queued = Math.max(bucketState.queued - 1, 0);
                        inflightItems.set(item.stable_key, {
                            phase: 'judge',
                            stableKey: item.stable_key,
                            throttleBucketKey: judgeBucketKey,
                            participantId: item.participant_id,
                            participantModelId: item.participant_model_id,
                            provider: providerByParticipantId.get(item.participant_id) ?? null,
                            sourceId: item.source_id,
                            sourcePreview: truncatePreview(item.source),
                            sourceLang: item.source_lang,
                            targetLanguage: item.target_language,
                            attempt: 1,
                            startedAt: new Date().toISOString(),
                            requestTimeoutMs: 90_000,
                        });
                        writePhaseState();

                        try {
                            let attemptsUsed = 1;
                            let terminalFailureEventWritten = false;
                            const request = buildVertexJudgeRequest({
                                model: judgeModelId,
                                systemPrompt: gembaAssets.systemPrompt,
                                fewShotMessages: gembaAssets.fewShotMessages,
                                userPromptTemplate: gembaAssets.userPromptTemplate,
                                templateVariables: buildJudgeTemplateVariables(item),
                            });

                            const judgeResult = await resolveJudgeResult(judgeClient, request, item.stable_key, {
                                onFailure: async (event) => {
                                    attemptsUsed = event.attempt;
                                    const inflightState = inflightItems.get(item.stable_key);
                                    if (inflightState) {
                                        inflightState.attempt = event.attempt + (event.willRetry ? 1 : 0);
                                    }

                                    if (event.willRetry) {
                                        currentOverallState.retryCount += 1;
                                        cumulativeRetryCount += 1;
                                        participantRetryCountById.set(
                                            item.participant_id,
                                            (participantRetryCountById.get(item.participant_id) ?? 0) + 1,
                                        );
                                        participantState.retryCount += 1;
                                        emitRunEvent(layout.judgeEventsJsonlPath, 'retry', {
                                            scope: 'item',
                                            phase: 'judge',
                                            event_type: 'retry',
                                            throttle_bucket_key: judgeBucketKey,
                                            stable_key: item.stable_key,
                                            source_id: item.source_id,
                                            source_preview: item.source,
                                            source_lang: item.source_lang,
                                            target_language: item.target_language,
                                            participant_id: item.participant_id,
                                            participant_model_id: item.participant_model_id,
                                            provider: providerByParticipantId.get(item.participant_id) ?? null,
                                            attempt: event.attempt,
                                            max_attempts: event.maxAttempts,
                                            error_class: event.normalizedError.errorClass,
                                            error_summary: event.normalizedError.rawMessage,
                                            raw_error_message: event.normalizedError.rawMessage,
                                            next_delay_ms: event.retryDelayMs,
                                        });
                                        return;
                                    }

                                    terminalFailureEventWritten = true;
                                    emitRunEvent(layout.judgeEventsJsonlPath, 'failure', {
                                        scope: 'item',
                                        phase: 'judge',
                                        event_type: 'failure',
                                        throttle_bucket_key: judgeBucketKey,
                                        stable_key: item.stable_key,
                                        source_id: item.source_id,
                                        source_preview: item.source,
                                        source_lang: item.source_lang,
                                        target_language: item.target_language,
                                        participant_id: item.participant_id,
                                        participant_model_id: item.participant_model_id,
                                        provider: providerByParticipantId.get(item.participant_id) ?? null,
                                        attempt: event.attempt,
                                        max_attempts: event.maxAttempts,
                                        error_class: event.normalizedError.errorClass,
                                        error_summary: event.normalizedError.rawMessage,
                                        raw_error_message: event.normalizedError.rawMessage,
                                    });
                                },
                            });
                            if (!judgeMetricsByStableKey.has(item.stable_key)) {
                                writeJsonlRecord(layout.judgeMetricsJsonlPath, {
                                    stable_key: item.stable_key,
                                    ...judgeResult.usage,
                                });
                            }

                            judgeCompleted += 1;
                            judgeCostUsd += judgeResult.usage.computedCostUsd ?? 0;
                            currentOverallState.completed = judgeCompleted;
                            participantState.completed += 1;
                            participantState.remaining = Math.max(participantState.remaining - 1, 0);

                            if (judgeResult.ok) {
                                writeJsonlRecord(layout.rawJudgeJsonlPath, {
                                    stable_key: item.stable_key,
                                    source_id: item.source_id,
                                    target_language: item.target_language,
                                    participant_id: item.participant_id,
                                    participant_model_id: item.participant_model_id,
                                    raw_judge_output: judgeResult.rawText,
                                });

                                try {
                                    const normalizedRecord = normalizeJudgeResponse({
                                        rawJudgeOutput: judgeResult.rawText,
                                        runId: this.options.runId,
                                        sourceId: item.source_id,
                                        targetLanguage: item.target_language,
                                        participantId: item.participant_id,
                                        participantModelId: item.participant_model_id,
                                        judgeModelId,
                                        contextMetadata: buildJudgeContextMetadata(item),
                                    });

                                    writeJsonlRecord(layout.normalizedJudgeJsonlPath, { ...normalizedRecord });
                                    judgeSucceeded += 1;
                                    currentOverallState.succeeded = judgeSucceeded;
                                    participantState.succeeded += 1;

                                    if (attemptsUsed > 1) {
                                        emitRunEvent(layout.judgeEventsJsonlPath, null, {
                                            scope: 'item',
                                            phase: 'judge',
                                            event_type: 'recovered',
                                            throttle_bucket_key: judgeBucketKey,
                                            stable_key: item.stable_key,
                                            source_id: item.source_id,
                                            source_preview: item.source,
                                            source_lang: item.source_lang,
                                            target_language: item.target_language,
                                            participant_id: item.participant_id,
                                            participant_model_id: item.participant_model_id,
                                            provider: providerByParticipantId.get(item.participant_id) ?? null,
                                            attempt: attemptsUsed,
                                            max_attempts: 3,
                                            latency_ms: judgeResult.usage.latencyMs,
                                        });
                                    }

                                    return;
                                } catch (error) {
                                    const failureRecord = normalizeJudgeFailure({
                                        rawJudgeOutput: judgeResult.rawText,
                                        runId: this.options.runId,
                                        sourceId: item.source_id,
                                        targetLanguage: item.target_language,
                                        participantId: item.participant_id,
                                        participantModelId: item.participant_model_id,
                                        judgeModelId,
                                        contextMetadata: buildJudgeContextMetadata(item),
                                    });

                                    writeJsonlRecord(layout.failuresJsonlPath, {
                                        stable_key: item.stable_key,
                                        source_id: item.source_id,
                                        target_language: item.target_language,
                                        participant_id: item.participant_id,
                                        participant_model_id: item.participant_model_id,
                                        error: sanitizePersistedErrorText(String(error)),
                                        raw_judge_output: judgeResult.rawText,
                                    });
                                    writeJsonlRecord(layout.normalizedJudgeJsonlPath, { ...failureRecord });
                                    judgeFailed += 1;
                                    currentOverallState.failed = judgeFailed;
                                    participantState.failed += 1;
                                    participantState.lastFailureAt = new Date().toISOString();

                                    if (!terminalFailureEventWritten) {
                                        emitRunEvent(layout.judgeEventsJsonlPath, 'failure', {
                                            scope: 'item',
                                            phase: 'judge',
                                            event_type: 'failure',
                                            throttle_bucket_key: judgeBucketKey,
                                            stable_key: item.stable_key,
                                            source_id: item.source_id,
                                            source_preview: item.source,
                                            source_lang: item.source_lang,
                                            target_language: item.target_language,
                                            participant_id: item.participant_id,
                                            participant_model_id: item.participant_model_id,
                                            provider: providerByParticipantId.get(item.participant_id) ?? null,
                                            attempt: attemptsUsed,
                                            max_attempts: 3,
                                            error_class: 'invalid_response',
                                            error_summary: String(error),
                                            raw_error_message: String(error),
                                        });
                                    }

                                    return;
                                }
                            }

                            const failureRecord = normalizeJudgeFailure({
                                rawJudgeOutput: judgeResult.rawText,
                                runId: this.options.runId,
                                sourceId: item.source_id,
                                targetLanguage: item.target_language,
                                participantId: item.participant_id,
                                participantModelId: item.participant_model_id,
                                judgeModelId,
                                contextMetadata: buildJudgeContextMetadata(item),
                            });

                            writeJsonlRecord(layout.failuresJsonlPath, {
                                stable_key: item.stable_key,
                                source_id: item.source_id,
                                target_language: item.target_language,
                                participant_id: item.participant_id,
                                participant_model_id: item.participant_model_id,
                                error: sanitizePersistedErrorText(judgeResult.rawText),
                                raw_judge_output: sanitizePersistedErrorText(judgeResult.rawText),
                            });
                            writeJsonlRecord(layout.normalizedJudgeJsonlPath, { ...failureRecord });
                            judgeFailed += 1;
                            currentOverallState.failed = judgeFailed;
                            participantState.failed += 1;
                            participantState.lastFailureAt = new Date().toISOString();

                            if (!terminalFailureEventWritten) {
                                emitRunEvent(layout.judgeEventsJsonlPath, 'failure', {
                                    scope: 'item',
                                    phase: 'judge',
                                    event_type: 'failure',
                                    throttle_bucket_key: judgeBucketKey,
                                    stable_key: item.stable_key,
                                    source_id: item.source_id,
                                    source_preview: item.source,
                                    source_lang: item.source_lang,
                                    target_language: item.target_language,
                                    participant_id: item.participant_id,
                                    participant_model_id: item.participant_model_id,
                                    provider: providerByParticipantId.get(item.participant_id) ?? null,
                                    attempt: attemptsUsed,
                                    max_attempts: 3,
                                    error_class: 'unknown',
                                    error_summary: judgeResult.rawText,
                                    raw_error_message: judgeResult.rawText,
                                });
                            }
                        } finally {
                            judgeActive -= 1;
                            participantState.inflight = Math.max(participantState.inflight - 1, 0);
                            bucketState.inflight = Math.max(bucketState.inflight - 1, 0);
                            inflightItems.delete(item.stable_key);
                            updateJudgeProgress();
                            writePhaseState();
                        }
                    },
                });

                judgeReporter.flush({
                    completed: judgeCompleted,
                    succeeded: judgeSucceeded,
                    failed: judgeFailed,
                    activeWorkers: judgeActive,
                    totalCostUsd: judgeCostUsd,
                    initialCompleted: judgeInitialCompleted,
                    retryCount: currentOverallState.retryCount,
                });
            }
        }

        const normalizedRecords = readJsonlRecords<NormalizedJudgeRecord>(layout.normalizedJudgeJsonlPath);
        const reports = buildBenchmarkReports(
            normalizedRecords,
            manifestParticipants,
            manifest.targetLanguages,
        );

        this.writeBenchmarkReports(
            layout.reportsDir,
            reports,
            normalizedRecords,
            translationRecords,
            translationFailureRecords,
            manifest,
        );
        this.writeCostReports(layout, [
            ...translationMetrics,
            ...readJsonlRecords<JudgeMetricsRecord>(layout.judgeMetricsJsonlPath),
        ]);

        const unresolvedTranslationFailuresAtEnd = getUnresolvedTranslationFailureRecords(
            translationRecords,
            translationFailureRecords,
        );
        const judgeSuccessRecords = normalizedRecords.filter((record) => record.status === 'ok');
        const judgeFailureRecords = normalizedRecords.filter((record) => record.status !== 'ok');
        const retryEvents = [
            ...readJsonlRecords<{ participant_id: string | null; event_type: string }>(layout.translationEventsJsonlPath),
            ...readJsonlRecords<{ participant_id: string | null; event_type: string }>(layout.judgeEventsJsonlPath),
        ].filter((event) => event.event_type === 'retry' && event.participant_id !== null);
        const retryCountByParticipantId = countBy(retryEvents, (event) => event.participant_id ?? '');
        const finalParticipantSnapshots = participantOrder.map((participantId) => {
            const translationSucceeded = translationRecords.filter((record) => record.participant_id === participantId).length;
            const translationFailed = unresolvedTranslationFailuresAtEnd.filter((record) => record.participant_id === participantId).length;
            const judgeSucceeded = judgeSuccessRecords.filter((record) => record.participant_id === participantId).length;
            const judgeFailed = judgeFailureRecords.filter((record) => record.participant_id === participantId).length;

            return {
                participantId,
                completed: translationSucceeded + translationFailed + judgeSucceeded + judgeFailed,
                succeeded: translationSucceeded + judgeSucceeded,
                failed: translationFailed + judgeFailed,
                retryCount: retryCountByParticipantId.get(participantId) ?? 0,
                inflight: 0,
                remaining: 0,
            };
        });
        const finalOverallState = {
            completed: finalParticipantSnapshots.reduce((sum, participant) => sum + participant.completed, 0),
            succeeded: finalParticipantSnapshots.reduce((sum, participant) => sum + participant.succeeded, 0),
            failed: finalParticipantSnapshots.reduce((sum, participant) => sum + participant.failed, 0),
            retryCount: retryEvents.length,
        };

        currentPhase = 'complete';
        runStateWriter.update({
            currentPhase,
            updatedAt: new Date().toISOString(),
            overall: {
                ...finalOverallState,
                cumulativeRetryCount,
            },
            participants: finalParticipantSnapshots,
            throttleBuckets: Array.from(throttleBucketStateByKey.values()).map((bucket) => ({
                ...bucket,
                inflight: 0,
                queued: 0,
                cooldownUntil: null,
            })),
            inflightItems: [],
            recentFailures: [...recentFailures],
            recentRetries: [...recentRetries],
        });
        runStateWriter.flush();

        const summary = this.calculateSummary(results, allTargetLangs);
        return summary;
    }

    private calculateSummary(
        results: TestResult[],
        targetLangs: string[]
    ): TestSummary {
        const conditions = this.conditions;
        const allTranslations = results.flatMap(r => r.translations);

        // Per-language stats
        const summaryByLang: { [lang: string]: LangStats } = {};

        for (const lang of targetLangs) {
            const langTranslations = allTranslations.filter(t => t.targetLang === lang);
            summaryByLang[lang] = this.calcLangStats(langTranslations, conditions);
        }

        // Overall stats
        const summaryOverall = this.calcLangStats(allTranslations, conditions);

        // Build prompts map
        const prompts: { [label: string]: string } = {};
        for (const c of conditions) {
            // Interpolate with placeholder values for display
            const interpolated = interpolatePrompt(c.prompt, {
                sourceName: '(source)',
                targetName: '(target)',
                text: '(text)',
                supported_languages: SUPPORTED_LANGUAGES.join(', '),
            });
            prompts[c.label] = interpolated;
        }

        return {
            timestamp: new Date().toISOString(),
            judgeModel: this.judge === null
                ? 'Disabled'
                : (this.options.judgeModelId ?? 'Configured Judge'),
            conditions: conditions.map(c => ({
                label: c.label,
                provider: c.provider,
                model: c.model,
                promptFile: path.basename(c.promptFile),
                dataFile: path.basename(c.dataFile),
            })),
            totalSentences: results.length,
            totalTranslations: allTranslations.length * conditions.length,
            targetLangs,
            prompts,
            results,
            summaryByLang,
            summaryOverall,
        };
    }

    private calcLangStats(
        langTranslations: LangResult[],
        conditions: Condition[]
    ): LangStats {
        const latencies: { [label: string]: ConditionLatencyStats } = {};
        const scores: { [label: string]: ConditionScoreStats } = {};

        for (const c of conditions) {
            const condData = langTranslations.flatMap(lt =>
                lt.conditions.filter(cr => cr.label === c.label)
            );

            if (condData.length === 0) continue;

            const lats = condData.map(d => d.latencyMs);
            latencies[c.label] = {
                avg: Math.round(lats.reduce((a, b) => a + b, 0) / lats.length),
                min: Math.min(...lats),
                max: Math.max(...lats),
            };

            const validScores = condData.filter(d => d.judge.total > 0);
            if (validScores.length > 0) {
                scores[c.label] = {
                    avgAccuracy: this.roundTo(validScores.reduce((a, d) => a + d.judge.accuracy, 0) / validScores.length, 2),
                    avgFluency: this.roundTo(validScores.reduce((a, d) => a + d.judge.fluency, 0) / validScores.length, 2),
                    avgTone: this.roundTo(validScores.reduce((a, d) => a + d.judge.tone, 0) / validScores.length, 2),
                    avgFormat: this.roundTo(validScores.reduce((a, d) => a + d.judge.format, 0) / validScores.length, 2),
                    avgTotal: this.roundTo(validScores.reduce((a, d) => a + d.judge.total, 0) / validScores.length, 2),
                };
            }
        }

        return { latencies, scores };
    }

    private roundTo(value: number, decimals: number): number {
        const factor = Math.pow(10, decimals);
        return Math.round(value * factor) / factor;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private buildBenchmarkCaseLookup(maxCases: number): Map<string, BenchmarkCaseLookupEntry> {
        const lookup = new Map<string, BenchmarkCaseLookupEntry>();

        for (let i = 0; i < maxCases; i += 1) {
            const referenceCase = this.conditions[0]?.testCases[i];

            if (!referenceCase) {
                continue;
            }

            const runtimeInfo = describeBenchmarkTestCase(referenceCase);
            lookup.set(runtimeInfo.sourceId, {
                sourceId: runtimeInfo.sourceId,
                resultId: runtimeInfo.resultId,
                source: runtimeInfo.artifactSource,
                sourceLang: runtimeInfo.sourceLang,
                order: i,
                contextSample: runtimeInfo.contextSample,
            });
        }

        return lookup;
    }

    private buildTranslationWorkItems(maxCases: number): TranslationWorkItem[] {
        const items: TranslationWorkItem[] = [];

        for (let i = 0; i < maxCases; i += 1) {
            for (const targetLanguageCode of this.benchmarkConfig.targetLanguages) {
                const targetLanguageLabel = this.benchmarkConfig.targetLanguageLabels[targetLanguageCode] ?? targetLanguageCode;
                const shuffledConditions = shuffle(this.conditions);

                for (const condition of shuffledConditions) {
                    const testCase = condition.testCases[i];
                    const runtimeInfo = describeBenchmarkTestCase(testCase);
                    const participant = resolveParticipant(condition);
                    items.push({
                        condition,
                        sourceId: runtimeInfo.sourceId,
                        sourcePreview: runtimeInfo.sourcePreview,
                        sourceLang: runtimeInfo.sourceLang,
                        translationInput: resolveTranslationInputForParticipant(runtimeInfo, participant.participantId),
                        artifactSource: runtimeInfo.artifactSource,
                        contextArtifactFields: runtimeInfo.contextArtifactFields,
                        targetLanguageCode,
                        targetLanguageLabel,
                        participantId: participant.participantId,
                        participantModelId: participant.participantModelId,
                        provider: condition.provider,
                        throttleBucketKey: buildThrottleBucketKey(condition.provider, participant.participantModelId),
                        stableKey: buildStableKey(
                            this.options.runId,
                            runtimeInfo.sourceId,
                            targetLanguageCode,
                            participant.participantId,
                        ),
                    });
                }
            }
        }

        return items;
    }

    private buildResultsFromArtifacts(
        translationRecords: TranslationArtifactRecord[],
        translationMetrics: TranslationMetricsRecord[],
        benchmarkCaseLookup: Map<string, BenchmarkCaseLookupEntry>,
    ): TestResult[] {
        const latencyByStableKey = new Map(
            translationMetrics.map((record) => [record.stable_key, record.latencyMs]),
        );
        const conditionByParticipantId = new Map(
            this.conditions.map((condition) => [
                resolveParticipant(condition).participantId,
                condition,
            ]),
        );
        const conditionByParticipantModelId = new Map(
            this.conditions.map((condition) => [
                resolveParticipant(condition).participantModelId,
                condition,
            ]),
        );
        const sourceMap = new Map<string, { order: number; result: TestResult }>();

        for (const record of translationRecords) {
            const sourceInfo = benchmarkCaseLookup.get(record.source_id);

            if (!sourceInfo) {
                continue;
            }

            const sourceEntry = sourceMap.get(record.source_id) ?? {
                order: sourceInfo.order,
                result: {
                    id: sourceInfo.resultId,
                    sourceId: sourceInfo.sourceId,
                    source: sourceInfo.source,
                    sourceLang: sourceInfo.sourceLang,
                    translations: this.benchmarkConfig.targetLanguages.map((targetLang) => ({
                        targetLang,
                        conditions: [],
                    })),
                },
            };
            const langEntry = sourceEntry.result.translations.find((entry) => entry.targetLang === record.target_language);
            const condition = conditionByParticipantId.get(record.participant_id)
                ?? conditionByParticipantModelId.get(record.participant_model_id);

            if (langEntry && condition) {
                langEntry.conditions.push({
                    label: condition.label,
                    provider: condition.provider,
                    model: condition.model,
                    output: record.translation,
                    latencyMs: latencyByStableKey.get(record.stable_key) ?? 0,
                    judge: buildPlaceholderJudgeScore(),
                });
                langEntry.conditions.sort((a, b) => a.label.localeCompare(b.label));
            }

            sourceMap.set(record.source_id, sourceEntry);
        }

        return Array.from(sourceMap.values())
            .sort((a, b) => a.order - b.order)
            .map(({ result }) => ({
                ...result,
                translations: result.translations.filter((translation) => translation.conditions.length > 0),
            }));
    }

    private writeCostReports(layout: { reportsDir: string }, metrics: CallUsageMetrics[]): void {
        const costSummary = aggregateRunCosts(metrics);

        fs.writeFileSync(
            path.join(layout.reportsDir, 'cost-summary.json'),
            `${JSON.stringify(costSummary, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(layout.reportsDir, 'cost-by-model.json'),
            `${JSON.stringify(costSummary.byModel, null, 2)}\n`,
        );
    }

    private writeBenchmarkReports(
        reportsDir: string,
        reports: ReturnType<typeof buildBenchmarkReports>,
        normalizedRecords: NormalizedJudgeRecord[],
        translationRecords: TranslationArtifactRecord[],
        translationFailureRecords: TranslationFailureArtifactRecord[],
        manifest: RunManifestV3,
    ): void {
        const totalExpected = getExpectedJudgeItemCount(manifest, translationRecords);
        const totalNormalized = normalizedRecords.length;
        const translationFailureHistoricalCount = translationFailureRecords.length;
        const unresolvedTranslationFailures = getUnresolvedTranslationFailureRecords(
            translationRecords,
            translationFailureRecords,
        );
        const translationFailureUnresolvedCount = unresolvedTranslationFailures.length;
        const expectedTranslationCount = getExpectedTranslationItemCount(manifest, translationRecords);
        const judgeFailureRatesByParticipantLanguage = buildJudgeFailureRatesByParticipantLanguage(
            manifest,
            translationRecords,
            normalizedRecords,
        );
        const benchmarkValid = totalExpected > 0
            && translationRecords.length === expectedTranslationCount
            && translationFailureUnresolvedCount === 0
            && totalNormalized === totalExpected
            && Object.values(judgeFailureRatesByParticipantLanguage).every((value) => {
                const total = value.ok + value.failed;
                return total > 0 && value.failed / total <= 0.01;
            });
        const commonCellReports = buildCommonCellReports(normalizedRecords, manifest.participants, manifest.targetLanguages);

        fs.writeFileSync(
            path.join(reportsDir, 'run-status.json'),
            `${JSON.stringify({
                benchmarkValid,
                totalExpected,
                totalNormalized,
                translationFailureHistoricalCount,
                translationFailureUnresolvedCount,
                commonCellCount: commonCellReports.commonCellCount,
                judgeFailureRatesByParticipantLanguage,
            }, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'leaderboard.by-language.json'),
            `${JSON.stringify(reports.byLanguage, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'severity-breakdown.by-language.json'),
            `${JSON.stringify(Object.fromEntries(Object.entries(reports.byLanguage).map(([lang, value]) => [lang, value.severityBreakdown])), null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'error-class-breakdown.by-language.json'),
            `${JSON.stringify(Object.fromEntries(Object.entries(reports.byLanguage).map(([lang, value]) => [lang, value.errorClassBreakdown])), null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'failed-samples.by-language.json'),
            `${JSON.stringify(Object.fromEntries(Object.entries(reports.byLanguage).map(([lang, value]) => [lang, value.failures])), null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'summary-overall.penalty.json'),
            `${JSON.stringify(reports.summaryOverallPenalty, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'summary-overall.penalty.common-cell.json'),
            `${JSON.stringify(commonCellReports.overall, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'leaderboard.by-language.common-cell.json'),
            `${JSON.stringify(commonCellReports.byLanguage, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'leaderboard.by-context-expectation.common-cell.json'),
            `${JSON.stringify(commonCellReports.byContextExpectation, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'summary-overall.normalized.json'),
            `${JSON.stringify(reports.summaryOverallNormalized, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'leaderboard.by-context-turn-count.json'),
            `${JSON.stringify(reports.byContextTurnCount, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'leaderboard.by-speaker-mode.json'),
            `${JSON.stringify(reports.bySpeakerMode, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'leaderboard.by-context-turn-count-and-speaker-mode.json'),
            `${JSON.stringify(reports.byContextTurnCountAndSpeakerMode, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'leaderboard.by-primary-phenomenon.json'),
            `${JSON.stringify(reports.byPrimaryPhenomenon, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'leaderboard.by-context-expectation.json'),
            `${JSON.stringify(reports.byContextExpectation, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'context-behavior.counts.json'),
            `${JSON.stringify(reports.contextBehavior, null, 2)}\n`,
        );
        fs.writeFileSync(
            path.join(reportsDir, 'context-behavior.rates.json'),
            `${JSON.stringify(reports.contextBehaviorRates, null, 2)}\n`,
        );
    }

    saveResults(summary: TestSummary, outputDir: string): string {
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `results_${timestamp}.json`;
        const filepath = path.join(outputDir, filename);

        fs.writeFileSync(filepath, JSON.stringify(summary, null, 2));
        return filepath;
    }

    printSummary(summary: TestSummary): void {
        console.log('\n' + '='.repeat(60));
        console.log('📊 EVALUATION SUMMARY');
        console.log('='.repeat(60));
        console.log(`Sentences: ${summary.totalSentences}`);
        console.log(`Total translations: ${summary.totalTranslations}`);
        console.log(`Target languages: ${summary.targetLangs.join(', ')}`);
        console.log(`Judge model: ${summary.judgeModel}`);
        console.log(`Timestamp: ${summary.timestamp}`);

        console.log('\n📋 Conditions:');
        for (const c of summary.conditions) {
            console.log(`  ${c.label}: ${c.provider}:${c.model} | ${c.promptFile} | ${c.dataFile}`);
        }

        // Per-language breakdown
        for (const lang of summary.targetLangs) {
            const stats = summary.summaryByLang[lang];
            console.log(`\n📈 [${lang}]`);

            // Latency table
            console.log('  ⏱️  Latency:');
            for (const [label, lat] of Object.entries(stats.latencies)) {
                console.log(`    ${label}: avg=${lat.avg}ms, min=${lat.min}ms, max=${lat.max}ms`);
            }

            // Find fastest
            const latEntries = Object.entries(stats.latencies);
            if (latEntries.length > 0) {
                const fastest = latEntries.reduce((a, b) => a[1].avg < b[1].avg ? a : b);
                console.log(`    → Fastest: ${fastest[0]} (${fastest[1].avg}ms avg)`);
            }

            // Score table
            if (Object.keys(stats.scores).length > 0) {
                console.log('  ⚖️  Quality Scores (1-5):');
                console.log(`    ${''.padEnd(6)}${'Acc'.padStart(6)}${'Flu'.padStart(6)}${'Tone'.padStart(6)}${'Fmt'.padStart(6)}${'Total'.padStart(8)}`);
                for (const [label, sc] of Object.entries(stats.scores)) {
                    console.log(`    ${label.padEnd(6)}${sc.avgAccuracy.toFixed(1).padStart(6)}${sc.avgFluency.toFixed(1).padStart(6)}${sc.avgTone.toFixed(1).padStart(6)}${sc.avgFormat.toFixed(1).padStart(6)}${sc.avgTotal.toFixed(1).padStart(8)}`);
                }

                // Find best total
                const scoreEntries = Object.entries(stats.scores);
                const best = scoreEntries.reduce((a, b) => a[1].avgTotal > b[1].avgTotal ? a : b);
                console.log(`    → Best quality: ${best[0]} (${best[1].avgTotal.toFixed(1)}/20)`);
            }
        }

        // Overall stats
        console.log('\n' + '-'.repeat(60));
        console.log('📊 OVERALL');

        const overall = summary.summaryOverall;

        console.log('  ⏱️  Latency:');
        for (const [label, lat] of Object.entries(overall.latencies)) {
            console.log(`    ${label}: avg=${lat.avg}ms, min=${lat.min}ms, max=${lat.max}ms`);
        }

        const latEntries = Object.entries(overall.latencies);
        if (latEntries.length > 0) {
            const fastest = latEntries.reduce((a, b) => a[1].avg < b[1].avg ? a : b);
            console.log(`    → Fastest: ${fastest[0]} (${fastest[1].avg}ms avg)`);
        }

        if (Object.keys(overall.scores).length > 0) {
            console.log('  ⚖️  Quality Scores (1-5):');
            console.log(`    ${''.padEnd(6)}${'Acc'.padStart(6)}${'Flu'.padStart(6)}${'Tone'.padStart(6)}${'Fmt'.padStart(6)}${'Total'.padStart(8)}`);
            for (const [label, sc] of Object.entries(overall.scores)) {
                console.log(`    ${label.padEnd(6)}${sc.avgAccuracy.toFixed(1).padStart(6)}${sc.avgFluency.toFixed(1).padStart(6)}${sc.avgTone.toFixed(1).padStart(6)}${sc.avgFormat.toFixed(1).padStart(6)}${sc.avgTotal.toFixed(1).padStart(8)}`);
            }

            const scoreEntries = Object.entries(overall.scores);
            const best = scoreEntries.reduce((a, b) => a[1].avgTotal > b[1].avgTotal ? a : b);
            console.log(`\n  🏆 Best overall: ${best[0]} (${best[1].avgTotal.toFixed(1)}/20)`);
        }

        console.log('\n' + '='.repeat(60) + '\n');
    }
}

function buildThrottleBucketKey(provider: Provider, providerModelId: string): string {
    return `${provider}::${providerModelId}`;
}

function buildJudgeThrottleBucketKey(judgeBackend: JudgeBackend, judgeModelId: string): string {
    return `${judgeBackend}::${judgeModelId}`;
}

function countBy<T>(
    items: readonly T[],
    keySelector: (item: T) => string,
): Map<string, number> {
    const counts = new Map<string, number>();

    for (const item of items) {
        const key = keySelector(item);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return counts;
}

function latestTimestampBy<T>(
    items: readonly T[],
    keySelector: (item: T) => string,
    timestampSelector: (item: T) => string,
): Map<string, string> {
    const latestByKey = new Map<string, string>();

    for (const item of items) {
        const key = keySelector(item);
        const timestamp = timestampSelector(item);
        const current = latestByKey.get(key);

        if (!current || current < timestamp) {
            latestByKey.set(key, timestamp);
        }
    }

    return latestByKey;
}

function buildRecentEventSummaries(
    events: readonly RunEventRecord[],
    limit: number,
): RunStateEventSummary[] {
    return [...events]
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, limit)
        .map((event) => toRunStateEventSummary(event));
}

function buildInitialRecentFailureSummaries(
    translationFailureRecords: readonly TranslationFailureArtifactRecord[],
    failureEvents: readonly RunEventRecord[],
): RunStateEventSummary[] {
    const summaries = buildRecentEventSummaries(failureEvents, Number.MAX_SAFE_INTEGER);
    const seenStableKeys = new Set(
        failureEvents
            .map((event) => event.stable_key)
            .filter((stableKey): stableKey is string => stableKey !== null),
    );

    for (const record of translationFailureRecords) {
        if (seenStableKeys.has(record.stable_key)) {
            continue;
        }

        summaries.push({
            phase: 'translation',
            eventType: 'failure',
            timestamp: record.recorded_at,
            throttleBucketKey: buildThrottleBucketKey(record.provider, record.participant_model_id),
            stableKey: record.stable_key,
            sourceId: record.source_id,
            sourcePreview: null,
            sourceLang: record.source_lang,
            targetLanguage: record.target_language,
            participantId: record.participant_id,
            participantModelId: record.participant_model_id,
            provider: record.provider,
            attempt: record.attempts_used,
            maxAttempts: null,
            latencyMs: null,
            errorClass: record.error_class,
            errorSummary: record.last_error_summary,
            rawErrorMessage: record.last_error_summary,
            nextDelayMs: null,
        });
    }

    return summaries
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, 5);
}

function createPhaseParticipantStateMap(input: {
    participantIds: string[];
    totalsByParticipantId: Map<string, number>;
    completedByParticipantId?: Map<string, number>;
    succeededByParticipantId?: Map<string, number>;
    failedByParticipantId?: Map<string, number>;
    lastFailureAtByParticipantId?: Map<string, string>;
    retryCountByParticipantId?: Map<string, number>;
}): Map<string, PhaseParticipantState> {
    const states = new Map<string, PhaseParticipantState>();

    for (const participantId of input.participantIds) {
        const completed = input.completedByParticipantId?.get(participantId) ?? 0;
        states.set(participantId, {
            participantId,
            completed,
            initialCompleted: completed,
            succeeded: input.succeededByParticipantId?.get(participantId) ?? 0,
            failed: input.failedByParticipantId?.get(participantId) ?? 0,
            retryCount: input.retryCountByParticipantId?.get(participantId) ?? 0,
            inflight: 0,
            remaining: Math.max((input.totalsByParticipantId.get(participantId) ?? 0) - completed, 0),
            lastFailureAt: input.lastFailureAtByParticipantId?.get(participantId) ?? null,
        });
    }

    for (const [participantId, total] of input.totalsByParticipantId) {
        if (states.has(participantId)) {
            continue;
        }

        const completed = input.completedByParticipantId?.get(participantId) ?? 0;
        states.set(participantId, {
            participantId,
            completed,
            initialCompleted: completed,
            succeeded: input.succeededByParticipantId?.get(participantId) ?? 0,
            failed: input.failedByParticipantId?.get(participantId) ?? 0,
            retryCount: input.retryCountByParticipantId?.get(participantId) ?? 0,
            inflight: 0,
            remaining: Math.max(total - completed, 0),
            lastFailureAt: input.lastFailureAtByParticipantId?.get(participantId) ?? null,
        });
    }

    return states;
}

function getOrCreatePhaseParticipantState(
    participantStateById: Map<string, PhaseParticipantState>,
    participantId: string,
): PhaseParticipantState {
    const existing = participantStateById.get(participantId);
    if (existing) {
        return existing;
    }

    const created: PhaseParticipantState = {
        participantId,
        completed: 0,
        initialCompleted: 0,
        succeeded: 0,
        failed: 0,
        retryCount: 0,
        inflight: 0,
        remaining: 0,
        lastFailureAt: null,
    };
    participantStateById.set(participantId, created);
    return created;
}

function buildProgressParticipantSnapshots(
    participantStateById: Map<string, PhaseParticipantState>,
    participantOrder: string[],
) {
    return participantOrder
        .map((participantId) => participantStateById.get(participantId))
        .filter((participant): participant is PhaseParticipantState => participant !== undefined)
        .map((participant) => ({
            participantId: participant.participantId,
            completed: participant.completed,
            failed: participant.failed,
            inflight: participant.inflight,
            retries: participant.retryCount,
            remaining: participant.remaining,
            initialCompleted: participant.initialCompleted,
            lastFailureAt: participant.lastFailureAt,
        }));
}

function getOrCreateThrottleBucketDebugState(
    throttleBucketStateByKey: Map<string, ThrottleBucketDebugState>,
    throttleBucketKey: string,
    participantIds: string[],
): ThrottleBucketDebugState {
    const existing = throttleBucketStateByKey.get(throttleBucketKey);
    if (existing) {
        existing.participantIds = Array.from(new Set([...existing.participantIds, ...participantIds]));
        return existing;
    }

    const created: ThrottleBucketDebugState = {
        throttleBucketKey,
        participantIds: [...participantIds],
        inflight: 0,
        queued: 0,
        cooldownUntil: null,
    };
    throttleBucketStateByKey.set(throttleBucketKey, created);
    return created;
}

function syncThrottleBucketDebugState(
    throttleBucketStateByKey: Map<string, ThrottleBucketDebugState>,
    allBuckets: ThrottleBucketState[],
    pendingBuckets: ThrottleBucketState[],
): void {
    const pendingByKey = new Map(pendingBuckets.map((bucket) => [bucket.key, bucket]));

    for (const bucket of allBuckets) {
        const pendingBucket = pendingByKey.get(bucket.key);
        throttleBucketStateByKey.set(bucket.key, {
            throttleBucketKey: bucket.key,
            participantIds: [...bucket.participantIds],
            inflight: 0,
            queued: pendingBucket ? getThrottleBucketItemCount(pendingBucket) : 0,
            cooldownUntil: null,
        });
    }
}

function buildTranslationQueues(items: TranslationWorkItem[]): Map<string, TranslationWorkItem[]> {
    const queuesByParticipantId = new Map<string, TranslationWorkItem[]>();

    for (const item of items) {
        const queue = queuesByParticipantId.get(item.participantId) ?? [];
        queue.push(item);
        queuesByParticipantId.set(item.participantId, queue);
    }

    return queuesByParticipantId;
}

function buildThrottleBucketStates(items: TranslationWorkItem[]): ThrottleBucketState[] {
    const queuesByParticipantId = buildTranslationQueues(items);
    const throttleBucketsByKey = new Map<string, ThrottleBucketState>();

    for (const [participantId, queue] of queuesByParticipantId) {
        const firstItem = queue[0];
        if (!firstItem) {
            continue;
        }

        const throttleBucket = throttleBucketsByKey.get(firstItem.throttleBucketKey) ?? {
            key: firstItem.throttleBucketKey,
            participantIds: [],
            queuesByParticipantId: new Map<string, TranslationWorkItem[]>(),
            nextParticipantIndex: 0,
            cooldownUntilMs: 0,
        };

        throttleBucket.participantIds.push(participantId);
        throttleBucket.queuesByParticipantId.set(participantId, [...queue]);
        throttleBucketsByKey.set(firstItem.throttleBucketKey, throttleBucket);
    }

    return Array.from(throttleBucketsByKey.values());
}

function getThrottleBucketItemCount(throttleBucket: ThrottleBucketState): number {
    let count = 0;

    for (const queue of throttleBucket.queuesByParticipantId.values()) {
        count += queue.length;
    }

    return count;
}

function takeNextThrottleBucketItem(throttleBucket: ThrottleBucketState): TranslationWorkItem | null {
    while (throttleBucket.participantIds.length > 0) {
        if (throttleBucket.nextParticipantIndex >= throttleBucket.participantIds.length) {
            throttleBucket.nextParticipantIndex = 0;
        }

        const participantId = throttleBucket.participantIds[throttleBucket.nextParticipantIndex];
        const queue = participantId
            ? throttleBucket.queuesByParticipantId.get(participantId)
            : undefined;

        if (!participantId || !queue || queue.length === 0) {
            if (participantId) {
                throttleBucket.queuesByParticipantId.delete(participantId);
                throttleBucket.participantIds.splice(throttleBucket.nextParticipantIndex, 1);
            }

            continue;
        }

        const item = queue.shift() ?? null;

        if (queue.length === 0) {
            throttleBucket.queuesByParticipantId.delete(participantId);
            throttleBucket.participantIds.splice(throttleBucket.nextParticipantIndex, 1);

            if (throttleBucket.nextParticipantIndex >= throttleBucket.participantIds.length) {
                throttleBucket.nextParticipantIndex = 0;
            }
        } else {
            throttleBucket.nextParticipantIndex = (throttleBucket.nextParticipantIndex + 1) % throttleBucket.participantIds.length;
        }

        if (item !== null) {
            return item;
        }
    }

    throttleBucket.nextParticipantIndex = 0;
    return null;
}

async function runThrottleBucketQueues(input: {
    buckets: ThrottleBucketState[];
    concurrencyPerBucket: number;
    worker: (item: TranslationWorkItem, throttleBucket: ThrottleBucketState) => Promise<void>;
}): Promise<void> {
    const tasks = input.buckets.flatMap((throttleBucket) => {
        const workerCount = Math.min(
            Math.max(input.concurrencyPerBucket, 1),
            getThrottleBucketItemCount(throttleBucket),
        );

        return Array.from({ length: workerCount }, async () => {
            while (true) {
                const item = takeNextThrottleBucketItem(throttleBucket);

                if (item === null) {
                    return;
                }

                await input.worker(item, throttleBucket);
            }
        });
    });

    await Promise.all(tasks);
}

function applyThrottleBucketCooldown(
    throttleBucket: ThrottleBucketState,
    delayMs: number,
    now: () => number,
): void {
    throttleBucket.cooldownUntilMs = Math.max(throttleBucket.cooldownUntilMs, now() + delayMs);
}

async function waitForThrottleBucketCooldown(
    throttleBucket: ThrottleBucketState,
    now: () => number,
    sleep: (ms: number) => Promise<void>,
    onCooldownEnd?: () => void | Promise<void>,
): Promise<void> {
    let waited = false;

    while (throttleBucket.cooldownUntilMs > now()) {
        waited = true;
        await sleep(throttleBucket.cooldownUntilMs - now());
    }

    if (waited) {
        throttleBucket.cooldownUntilMs = 0;
        await onCooldownEnd?.();
    }
}

function normalizeTranslationError(
    provider: Provider,
    error: unknown,
    requestTimeoutMs: number,
): NormalizedClientError {
    switch (provider) {
        case 'deepl':
            return normalizeDeepLError(error, requestTimeoutMs);
        case 'gemini':
            return normalizeGeminiError(error, requestTimeoutMs);
        case 'google-translate-basic':
            return normalizeGoogleTranslateBasicError(error, requestTimeoutMs);
        case 'google-web':
            return normalizeGoogleWebError(error, requestTimeoutMs);
        case 'qwen':
            return normalizeQwenError(error, requestTimeoutMs);
        case 'openrouter':
            return normalizeOpenRouterError(error, requestTimeoutMs);
        case 'deepseek':
            return normalizeDeepSeekError(error, requestTimeoutMs);
        case 'llamacpp':
            return normalizeLlamaCppError(error, requestTimeoutMs);
        case 'papago':
            return normalizePapagoError(error, requestTimeoutMs);
    }
}

function resolveParticipant(condition: Condition) {
    return {
        participantId: condition.label,
        participantModelId: condition.model,
    };
}

function resolveManifestParticipants(
    conditions: Condition[],
    participants: ParticipantDefinition[] | undefined,
    sharedPromptFile: string,
): ParticipantDefinition[] {
    const conditionsByLabel = new Map(conditions.map((condition) => [condition.label, condition]));

    if (participants !== undefined) {
        return participants.map((participant) => {
            const condition = conditionsByLabel.get(participant.participantId);
            const conditionPromptMetadata = condition
                ? resolveConditionPromptMetadataForManifest(condition, sharedPromptFile)
                : {};

            // For fresh participants the fork/prepare manifest records the
            // participant promptFile (even when it equals the shared prompt),
            // so resume validation must reproduce that snapshot exactly:
            // always carry the participant-level prompt metadata verbatim when
            // the participant already carries a fingerprint (fork path). Plain
            // registry participants have no attached fingerprint — the
            // condition metadata below supplies it for non-shared prompts and
            // omits shared-prompt files entirely, keeping the manifest valid.
            const participantPromptMetadata = participant.promptFile && participant.promptFingerprintSha256
                ? { promptFile: participant.promptFile, promptFingerprintSha256: participant.promptFingerprintSha256 }
                : {};

            return {
                participantId: participant.participantId,
                displayName: participant.displayName,
                provider: participant.provider,
                providerModelId: participant.providerModelId,
                ...(participant.messageLayout ? { messageLayout: participant.messageLayout } : {}),
                ...(participant.llamaCppServerUrl ? { llamaCppServerUrl: participant.llamaCppServerUrl } : {}),
                ...(participant.llamaCppMode ? { llamaCppMode: participant.llamaCppMode } : {}),
                ...participantPromptMetadata,
                // Condition metadata is validated (throws when a non-shared
                // promptFile lacks a fingerprint) and takes precedence.
                ...conditionPromptMetadata,
            };
        });
    }

    const snapshots: ParticipantDefinition[] = [];
    const seen = new Set<string>();

    for (const condition of conditions) {
        if (seen.has(condition.label)) {
            continue;
        }

        seen.add(condition.label);
        const conditionPromptMetadata = resolveConditionPromptMetadataForManifest(condition, sharedPromptFile);
        snapshots.push({
            participantId: condition.label,
            displayName: condition.label,
            provider: condition.provider,
            providerModelId: condition.model,
            ...(condition.messageLayout ? { messageLayout: condition.messageLayout } : {}),
            ...(condition.llamaCppServerUrl ? { llamaCppServerUrl: condition.llamaCppServerUrl } : {}),
            ...(condition.llamaCppMode ? { llamaCppMode: condition.llamaCppMode } : {}),
            ...conditionPromptMetadata,
        });
    }

    return snapshots;
}

function resolveConditionPromptMetadataForManifest(
    condition: Condition,
    sharedPromptFile: string,
): Pick<ParticipantDefinition, 'promptFile' | 'promptFingerprintSha256'> {
    if (condition.promptFile === sharedPromptFile) {
        return {};
    }

    if (!condition.promptFingerprintSha256) {
        throw new Error(
            `Condition "${condition.label}" uses participant promptFile override "${condition.promptFile}" but is missing promptFingerprintSha256`,
        );
    }

    return {
        promptFile: condition.promptFile,
        promptFingerprintSha256: condition.promptFingerprintSha256,
    };
}

function isReusedTranslationsManifest(manifest: RunManifestV3): boolean {
    return manifest.reusedTranslations === true || manifest.rejudgeFromRunId !== undefined;
}

function getExpectedTranslationItemCount(
    manifest: RunManifestV3,
    translationRecords: TranslationArtifactRecord[],
): number {
    if (isReusedTranslationsManifest(manifest)) {
        return translationRecords.length;
    }

    return manifest.limitApplied * manifest.targetLanguages.length * manifest.participants.length;
}

function getExpectedJudgeItemCount(
    manifest: RunManifestV3,
    translationRecords: TranslationArtifactRecord[],
): number {
    if (isReusedTranslationsManifest(manifest)) {
        return translationRecords.length;
    }

    return getExpectedTranslationItemCount(manifest, translationRecords);
}

function buildJudgeFailureRatesByParticipantLanguage(
    manifest: RunManifestV3,
    translationRecords: TranslationArtifactRecord[],
    normalizedRecords: NormalizedJudgeRecord[],
): Record<string, { ok: number; failed: number }> {
    const expectedKeys = isReusedTranslationsManifest(manifest)
        ? buildReusedTranslationParticipantLanguageKeys(manifest, translationRecords)
        : manifest.participants.flatMap((participant) =>
            manifest.targetLanguages.map((language) => `${participant.participantId}::${language}`),
        );
    const rates = Object.fromEntries(
        expectedKeys.map((key) => [key, { ok: 0, failed: 0 }]),
    ) as Record<string, { ok: number; failed: number }>;

    for (const record of normalizedRecords) {
        const key = `${record.participant_id}::${record.target_language}`;
        const entry = rates[key] ?? { ok: 0, failed: 0 };

        if (record.status === 'ok') {
            entry.ok += 1;
        } else {
            entry.failed += 1;
        }

        rates[key] = entry;
    }

    return rates;
}

function buildReusedTranslationParticipantLanguageKeys(
    manifest: RunManifestV3,
    translationRecords: TranslationArtifactRecord[],
): string[] {
    const seen = new Set(
        translationRecords.map((record) => `${record.participant_id}::${record.target_language}`),
    );

    return manifest.participants.flatMap((participant) =>
        manifest.targetLanguages
            .map((language) => `${participant.participantId}::${language}`)
            .filter((key) => seen.has(key)),
    );
}

function assertActiveContextDatasetFingerprintMatchesManifest(
    manifest: RunManifestV3,
    datasetFilePath: string,
): void {
    const activeDatasetFingerprintSha256 = computeFileSha256(datasetFilePath);

    if (manifest.datasetFingerprintSha256 !== activeDatasetFingerprintSha256) {
        throw new Error(
            `Context judge rebuild blocked: manifest dataset fingerprint ${manifest.datasetFingerprintSha256} `
            + `does not match active dataset ${activeDatasetFingerprintSha256}.`,
        );
    }
}

function buildContextArtifactFields(sample: ContextRuntimeSample): ContextArtifactFields {
    return {
        dataset_kind: 'context',
        context_turn_count: sample.contextTurnCount,
        speaker_mode: sample.speakerMode,
        context_expectation: sample.contextExpectation,
        primary_phenomenon: sample.primaryPhenomenon,
        secondary_phenomena: [...sample.secondaryPhenomena],
    };
}

function buildJudgeTemplateVariables(item: PendingJudgeWorkItem): Record<string, string> {
    if (item.contextSample) {
        return renderContextJudgeTemplateVariables(
            item.contextSample,
            item.translation,
            item.target_language_label,
        );
    }

    return {
        source: item.source,
        sourceLang: item.source_lang,
        targetLanguageCode: item.target_language,
        targetLanguageLabel: item.target_language_label,
        translation: item.translation,
    };
}

function describeBenchmarkTestCase(testCase: Condition['testCases'][number]): {
    sourceId: string;
    resultId: string | number;
    sourcePreview: string;
    sourceLang: string;
    translationInput: string;
    artifactSource: string;
    contextSample?: ContextRuntimeSample;
    contextArtifactFields?: ContextArtifactFields;
} {
    if (isContextRuntimeSample(testCase)) {
        return {
            sourceId: testCase.sampleId,
            resultId: testCase.sampleId,
            sourcePreview: testCase.currentSource.sourceText,
            sourceLang: 'Korean',
            translationInput: renderContextModelInput(testCase),
            artifactSource: testCase.currentSource.sourceText,
            contextSample: testCase,
            contextArtifactFields: buildContextArtifactFields(testCase),
        };
    }

    return {
        sourceId: String(testCase.id),
        resultId: testCase.id,
        sourcePreview: testCase.source,
        sourceLang: testCase.sourceLang,
        translationInput: testCase.source,
        artifactSource: testCase.source,
    };
}

function resolveTranslationInputForParticipant(
    runtimeInfo: ReturnType<typeof describeBenchmarkTestCase>,
    participantId: string,
): string {
    if (runtimeInfo.contextSample && isContextBlindContextBenchmarkParticipant(participantId)) {
        return runtimeInfo.contextSample.currentSource.sourceText;
    }

    return runtimeInfo.translationInput;
}

function isContextBlindContextBenchmarkParticipant(participantId: string): boolean {
    return participantId.endsWith('-nocontext')
        || participantId.endsWith('-nocontext-baseline')
        || participantId === 'google-cloud-translate-basic'
        || participantId === 'google-translate-web';
}

function buildPlaceholderJudgeScore(): JudgeScore {
    return {
        accuracy: 0,
        fluency: 0,
        tone: 0,
        format: 0,
        total: 0,
    };
}

function loadJudgeAssets(judgePromptVersion: string) {
    const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    return loadGembaAssets(projectRoot, judgePromptVersion);
}
