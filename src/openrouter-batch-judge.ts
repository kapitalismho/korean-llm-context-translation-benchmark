import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getErrorMessage,
    isAbortError,
    isNormalizedClientError,
    type NormalizedClientError,
    type NormalizedClientErrorClass,
} from './llm-client.js';
import { isCompleteMqmTextAnnotation, parseMqmTextJudgeResponse } from './normalize-gemba.js';
import { computeCallCost, type CallUsageMetrics } from './run-metrics.js';
import type { buildVertexJudgeRequest, JudgeResult } from './vertex-judge.js';

type JudgeRequest = ReturnType<typeof buildVertexJudgeRequest>;

const OPENROUTER_BATCH_BASE_URL = 'https://openrouter.ai/api';
/** OpenRouter rejects a single batch with more than this many lines (HTTP 413). */
const OPENROUTER_BATCH_HARD_MAX_REQUESTS = 5_000;
/**
 * Practical submit unit. Stay under the hard cap so one POST stays smaller
 * and less likely to time out; residual/retry jobs use the same chunking.
 */
const OPENROUTER_BATCH_SUBMIT_CHUNK_SIZE = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_MAX_POLL_DURATION_MS = 24 * 60 * 60 * 1000; // completion_window is 24h
const DEFAULT_MAX_RESIDUAL_SUBMIT_ROUNDS = 1;

const BATCH_TERMINAL_STATUSES = new Set(['completed', 'failed', 'expired', 'cancelled']);
const BATCH_FAILED_STATUSES = new Set(['failed', 'expired', 'cancelled']);

export interface OpenRouterBatchJudgeConfig {
    model: string; // e.g. google/gemini-3.7-flash:batch
    apiKey: string;
    apiBaseUrl?: string;
    requestTimeoutMs?: number;
    pollIntervalMs?: number;
    maxPollDurationMs?: number;
    maxResidualSubmitRounds?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

export interface OpenRouterBatchRequestEntry {
    stableKey: string;
    request: JudgeRequest;
}

export interface OpenRouterBatchPrepareInput {
    runDir: string;
    requests: OpenRouterBatchRequestEntry[];
    existingJobIds?: string[];
    onJobStatus?: (info: { jobId: string; status: string; completed: number; total: number }) => void;
    onNewJobIds?: (jobIds: string[]) => void;
}

export interface OpenRouterBatchPrepareResult {
    jobIds: string[];
    newJobIds: string[];
    jobCosts: Array<{ jobId: string; costUsd: number | null }>;
}

type BatchLineOutcome = {
    ok: true;
    rawText: string;
    usage: CallUsageMetrics;
} | {
    ok: false;
    errorMessage: string;
};

type BatchJobResponse = {
    id: string;
    status?: string;
    request_counts?: {
        total?: number;
        completed?: number;
        failed?: number;
    };
    results?: Array<{
        custom_id?: string;
        response?: {
            status_code?: number;
            body?: {
                choices?: Array<{
                    message?: { content?: string };
                }>;
                usage?: {
                    prompt_tokens?: number;
                    completion_tokens?: number;
                    reasoning?: { reasoning_tokens?: number };
                    completion_tokens_details?: { reasoning_tokens?: number };
                };
            };
        };
        error?: { message?: string } | string | null;
    }>;
    error?: { message?: string } | string | null;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        cost?: number;
    } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
    if (chunkSize <= 0) {
        throw new Error('chunkSize must be positive');
    }

    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += chunkSize) {
        chunks.push(items.slice(index, index + chunkSize));
    }

    return chunks;
}

function isOpenRouterBatchTooLargeError(httpStatus: number, rawBody: string): boolean {
    if (httpStatus === 413) {
        return true;
    }

    return rawBody.toLowerCase().includes('more than 5,000 requests');
}

function serializeChatMessages(request: JudgeRequest): string {
    const config = request.config as Record<string, unknown> | undefined;
    const systemInstruction = typeof config?.systemInstruction === 'string'
        ? config.systemInstruction.trim()
        : '';
    const messages: Array<{ role: string; content: string }> = [];

    if (systemInstruction.length > 0) {
        messages.push({ role: 'system', content: systemInstruction });
    }

    for (const message of request.contents) {
        const role = message.role === 'model' ? 'assistant' : message.role;
        messages.push({ role, content: message.parts.map((part) => part.text).join('\n') });
    }

    return JSON.stringify(messages);
}

/**
 * Content-addressed custom id suffixed with a stable-key hash so that two cells
 * with byte-identical judge prompts (e.g. identical translations from different
 * participants) still get distinct ids. The `j2-` prefix versions the scheme so
 * a future scheme change is detectable; the persisted custom-id map is the
 * authoritative correlation source on resume across code versions.
 */
function deriveCustomId(request: JudgeRequest, stableKey: string): string {
    const contentHash = createHash('sha256').update(serializeChatMessages(request)).digest('hex').slice(0, 24);
    const keyHash = createHash('sha256').update(stableKey).digest('hex').slice(0, 8);
    return `j2-${contentHash}-${keyHash}`;
}

/**
 * Fail closed on resume when a submission attempt has no recorded job covering
 * its custom ids. This is the lost-response case: the POST may have been
 * accepted by OpenRouter but the response (with the job id) was never seen, so
 * the job id was never persisted. Resubmitting would double-submit paid lines.
 *
 * Recovery is manual by design: check the OpenRouter batch dashboard for the
 * custom ids, record any existing job id in the run manifest
 * (openRouterBatchJobIds), or delete judge-batch-submission-attempts.jsonl if
 * the job was never accepted.
 */
function assertNoOrphanedSubmissionAttempts(runDir: string, recordedJobIds: string[]): void {
    const attemptsPath = path.join(runDir, 'judge-batch-submission-attempts.jsonl');

    if (!fs.existsSync(attemptsPath)) {
        return;
    }

    const parsedAttempts = fs.readFileSync(attemptsPath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { attemptedAt?: unknown; customIds?: unknown; rejected?: unknown })
        .filter((attempt) => Array.isArray(attempt.customIds) && attempt.customIds.every((id): id is string => typeof id === 'string'));

    const rejectedCustomIds = new Set<string>();
    for (const attempt of parsedAttempts) {
        if (attempt.rejected === true) {
            for (const customId of attempt.customIds as string[]) {
                rejectedCustomIds.add(customId);
            }
        }
    }

    const attempts = parsedAttempts.filter((attempt) => attempt.rejected !== true);

    if (attempts.length === 0) {
        return;
    }

    const coveredCustomIds = new Set<string>(rejectedCustomIds);

    for (const jobId of recordedJobIds) {
        const artifactPath = path.join(runDir, `judge-batch-${jobId}.json`);

        if (!fs.existsSync(artifactPath)) {
            continue;
        }

        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as { requests?: unknown };

        if (Array.isArray(artifact.requests)) {
            for (const request of artifact.requests) {
                const customId = (request as { custom_id?: unknown }).custom_id;
                if (typeof customId === 'string') {
                    coveredCustomIds.add(customId);
                }
            }
        }
    }

    const orphanedAttempt = attempts.find((attempt) => {
        const customIds = attempt.customIds as string[];
        return customIds.some((customId) => !coveredCustomIds.has(customId));
    });

    if (orphanedAttempt !== undefined) {
        const customIds = (orphanedAttempt.customIds as string[]).slice(0, 5).join(', ');
        throw new Error(
            `Cannot resume openrouter-batch judging: submission attempt(s) at ${orphanedAttempt.attemptedAt ?? 'unknown time'} (custom ids: ${customIds}...) have no recorded batch job covering them. The submit response may have been lost after OpenRouter accepted the job. Do not resubmit — check the OpenRouter batch dashboard for these custom ids, record any existing job id in the run manifest openRouterBatchJobIds, or delete judge-batch-submission-attempts.jsonl only if the job was never accepted.`,
        );
    }
}

function loadPersistedCustomIdMap(runDir: string): Map<string, string> | null {    const mapPath = path.join(runDir, 'judge-batch-custom-ids.json');

    if (!fs.existsSync(mapPath)) {
        return null;
    }

    try {
        const records = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as Array<{ custom_id?: unknown; stable_key?: unknown }>;
        const map = new Map<string, string>();
        const customIds = new Set<string>();

        for (const record of records) {
            if (typeof record.custom_id !== 'string' || record.custom_id.trim().length === 0
                || typeof record.stable_key !== 'string' || record.stable_key.trim().length === 0) {
                return null; // malformed record: fail closed
            }

            if (customIds.has(record.custom_id)) {
                return null; // same custom id mapped to multiple stable keys: fail closed
            }

            customIds.add(record.custom_id);

            if (map.has(record.stable_key) && map.get(record.stable_key) !== record.custom_id) {
                return null; // inconsistent map: fail closed
            }

            map.set(record.stable_key, record.custom_id);
        }

        return map;
    } catch {
        return null;
    }
}

function classifyBatchError(rawMessage: string): NormalizedClientErrorClass {
    const lower = rawMessage.toLowerCase();

    if (lower.includes('unauthorized') || lower.includes('api key') || lower.includes('forbidden')) {
        return 'auth';
    }

    if (lower.includes('not found') || lower.includes('invalid request') || lower.includes('unsupported') || lower.includes('model')) {
        return 'bad_request';
    }

    if (lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('quota')) {
        return 'rate_limit';
    }

    if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('abort')) {
        return 'timeout';
    }

    if (lower.includes('network') || lower.includes('fetch failed') || lower.includes('econn') || lower.includes('socket')) {
        return 'network';
    }

    return 'unknown';
}

function buildBatchNormalizedError(rawMessage: string, requestTimeoutMs: number): Error & NormalizedClientError {
    const errorClass = classifyBatchError(rawMessage);
    const error = new Error(rawMessage) as Error & NormalizedClientError;
    error.errorClass = errorClass;
    error.retryable = false;
    error.rawMessage = rawMessage;
    error.cooldownScope = 'none';
    error.requestTimeoutMs = requestTimeoutMs;
    return error;
}

function extractErrorMessage(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }

    if (isRecord(value) && typeof value.message === 'string') {
        return value.message;
    }

    return JSON.stringify(value);
}

function unknownUsage(model: string): CallUsageMetrics {
    return {
        provider: 'openrouter-batch',
        model: toMetricsModelId(model),
        phase: 'judge',
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        latencyMs: 0,
        costStatus: 'unknown',
        computedCostUsd: null,
    };
}

/**
 * The `:batch` suffix is a routing/endpoint detail; cost metrics identify the
 * base model so pricing lookup keys stay canonical.
 */
function toMetricsModelId(model: string): string {
    return model.replace(/:batch$/, '');
}

export class OpenRouterBatchGembaJudge {
    private readonly apiBaseUrl: string;
    private readonly requestTimeoutMs: number;
    private readonly pollIntervalMs: number;
    private readonly maxPollDurationMs: number;
    private readonly maxResidualSubmitRounds: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private outcomesByCustomId = new Map<string, BatchLineOutcome>();
    private customIdByStableKey = new Map<string, string>();
    private customIdByContentHash = new Map<string, string>();

    constructor(private readonly config: OpenRouterBatchJudgeConfig) {
        this.apiBaseUrl = (config.apiBaseUrl ?? OPENROUTER_BATCH_BASE_URL).replace(/\/+$/, '');
        this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        this.maxPollDurationMs = config.maxPollDurationMs ?? DEFAULT_MAX_POLL_DURATION_MS;
        this.maxResidualSubmitRounds = config.maxResidualSubmitRounds ?? DEFAULT_MAX_RESIDUAL_SUBMIT_ROUNDS;
        this.now = config.now ?? Date.now;
        this.sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    async preflight(): Promise<void> {
        if (!this.config.apiKey) {
            throw new Error('OPENROUTER_API_KEY is required for the openrouter-batch judge backend');
        }

        if (!this.config.model) {
            throw new Error('A judge model (e.g. google/gemini-3.7-flash:batch) is required for the openrouter-batch judge backend');
        }
    }

    /**
     * Endpoint identity recorded in the run manifest so resume validates that
     * the same batch endpoint/model is still in use.
     */
    getEndpointIdentity(): { apiBaseUrl: string; model: string } {
        return { apiBaseUrl: this.apiBaseUrl, model: this.config.model };
    }

    buildFailureUsage(_request: JudgeRequest, _error: NormalizedClientError): CallUsageMetrics {
        return unknownUsage(this.config.model);
    }

    /**
     * Submit (or re-poll on resume) the batch job(s) for the given requests and
     * await completion. Failed/missing lines are resubmitted for up to
     * maxResidualSubmitRounds additional jobs; lines still failing afterwards
     * surface as per-line judge failures via judgeItem/judge.
     *
     * Job-level failure states (failed/expired/cancelled) are treated as
     * unresolved lines and resubmitted rather than aborting the run. Poll-budget
     * exhaustion and transport/submission errors propagate so the caller can
     * resume safely: job ids are persisted before polling, so a later resume
     * re-polls the same job instead of double-submitting.
     */
    async prepareBatch(input: OpenRouterBatchPrepareInput): Promise<OpenRouterBatchPrepareResult> {
        // Reconcile with the persisted map so resume works across custom-id
        // scheme versions: a persisted id wins over a freshly derived one.
        // Fail closed when jobs already exist but the map is missing, malformed,
        // or does not cover every request: deriving fresh ids for lines that are
        // already inside a completed job would double-submit them.
        const persistedMap = loadPersistedCustomIdMap(input.runDir);
        if (persistedMap === null && (input.existingJobIds?.length ?? 0) > 0) {
            throw new Error('Cannot resume openrouter-batch judging: judge-batch-custom-ids.json is missing, malformed, or inconsistent while batch job ids are recorded. Do not resubmit — recover the map or manually reconcile the manifest before resuming to avoid double submission.');
        }

        assertNoOrphanedSubmissionAttempts(input.runDir, input.existingJobIds ?? []);

        const customIdByStableKey = new Map<string, string>();
        const customIdByContentHash = new Map<string, string>();

        for (const entry of input.requests) {
            const persistedId = persistedMap?.get(entry.stableKey);
            const customId = persistedId ?? deriveCustomId(entry.request, entry.stableKey);
            const contentHash = createHash('sha256').update(serializeChatMessages(entry.request)).digest('hex');

            if (persistedMap !== null && persistedId === undefined) {
                throw new Error(`Cannot resume openrouter-batch judging: persisted custom-id map does not cover stable key ${entry.stableKey} while batch job ids are recorded. Refusing to derive a fresh id to avoid double submission.`);
            }

            const previous = customIdByStableKey.get(entry.stableKey);
            if (previous !== undefined && previous !== customId) {
                throw new Error(`Duplicate stableKey in batch prepare: ${entry.stableKey}`);
            }

            const previousContent = customIdByContentHash.get(contentHash);
            if (previousContent === undefined) {
                customIdByContentHash.set(contentHash, customId);
            }

            customIdByStableKey.set(entry.stableKey, customId);
        }

        this.customIdByStableKey = customIdByStableKey;
        this.customIdByContentHash = customIdByContentHash;
        this.persistCustomIdMap(input.runDir, input.requests, customIdByStableKey);

        const jobIds = [...(input.existingJobIds ?? [])];
        const newJobIds: string[] = [];
        const jobCosts: Array<{ jobId: string; costUsd: number | null }> = [];
        const merged = new Map<string, BatchLineOutcome>();

        const publishJobIds = () => {
            input.onNewJobIds?.(jobIds);
        };

        for (const jobId of jobIds) {
            const result = await this.awaitJob(input.runDir, jobId, input.onJobStatus);
            jobCosts.push({ jobId, costUsd: result.usage?.cost ?? null });
            if (result.status !== 'completed') {
                // Terminal failure state: treat every line of this job as
                // unresolved so the residual rounds resubmit them.
                continue;
            }

            for (const [customId, outcome] of result.outcomes) {
                merged.set(customId, outcome);
            }
        }

        const missingEntries = () => input.requests.filter((entry) => {
            const customId = customIdByStableKey.get(entry.stableKey) ?? deriveCustomId(entry.request, entry.stableKey);
            const outcome = merged.get(customId);
            return outcome === undefined || !outcome.ok;
        });

        // Initial submission of every request not already resolved by an existing job.
        const submitAndAwaitChunks = async (entries: OpenRouterBatchRequestEntry[]): Promise<void> => {
            for (const chunk of chunkArray(entries, OPENROUTER_BATCH_SUBMIT_CHUNK_SIZE)) {
                const jobId = await this.submitJob(input.runDir, chunk, customIdByStableKey);
                jobIds.push(jobId);
                newJobIds.push(jobId);
                publishJobIds();

                const result = await this.awaitJob(input.runDir, jobId, input.onJobStatus);
                jobCosts.push({ jobId, costUsd: result.usage?.cost ?? null });
                if (result.status === 'completed') {
                    for (const [customId, outcome] of result.outcomes) {
                        merged.set(customId, outcome);
                    }
                }
            }
        };

        // Initial submission of every request not already resolved by an existing job.
        const initialMissing = missingEntries();
        if (initialMissing.length > 0) {
            await submitAndAwaitChunks(initialMissing);
        }

        // Residual rounds resubmit only the lines that failed or went missing.
        let remainingRounds = this.maxResidualSubmitRounds;

        while (remainingRounds > 0) {
            const residual = missingEntries();
            if (residual.length === 0) {
                break;
            }

            await submitAndAwaitChunks(residual);
            remainingRounds -= 1;
        }

        this.outcomesByCustomId = merged;
        return { jobIds, newJobIds, jobCosts };
    }

    /**
     * Primary per-item resolution used by the runner: unambiguous stable-key lookup.
     * Returns the same shape as judgeWithRetries so the per-item processing path
     * is shared with the interactive backends.
     */
    async judgeItem(stableKey: string): Promise<{ ok: boolean; rawText: string; usage: CallUsageMetrics }> {
        const customId = this.customIdByStableKey.get(stableKey);
        const outcome = customId === undefined ? undefined : this.outcomesByCustomId.get(customId);

        if (outcome === undefined) {
            return {
                ok: false,
                rawText: `OpenRouter batch result is missing for ${stableKey} (line absent from every completed job)`,
                usage: unknownUsage(this.config.model),
            };
        }

        if (!outcome.ok) {
            return {
                ok: false,
                rawText: `OpenRouter batch line failed: ${outcome.errorMessage}`,
                usage: unknownUsage(this.config.model),
            };
        }

        return {
            ok: true,
            rawText: outcome.rawText,
            usage: outcome.usage,
        };
    }

    async judge(request: JudgeRequest): Promise<JudgeResult> {
        const contentHash = createHash('sha256').update(serializeChatMessages(request)).digest('hex');
        const customId = this.customIdByContentHash.get(contentHash);
        const outcome = customId === undefined ? undefined : this.outcomesByCustomId.get(customId);

        if (outcome === undefined) {
            throw buildBatchNormalizedError(
                'OpenRouter batch result is missing for this judge request (line absent from every completed job)',
                this.requestTimeoutMs,
            );
        }

        if (!outcome.ok) {
            throw buildBatchNormalizedError(
                `OpenRouter batch line failed: ${outcome.errorMessage}`,
                this.requestTimeoutMs,
            );
        }

        return {
            rawText: outcome.rawText,
            usage: outcome.usage,
        };
    }

    private async submitJob(
        runDir: string,
        entries: OpenRouterBatchRequestEntry[],
        customIdByStableKey: Map<string, string>,
    ): Promise<string> {
        if (entries.length > OPENROUTER_BATCH_HARD_MAX_REQUESTS) {
            throw new Error(
                `OpenRouter batch submit refused ${entries.length} lines locally (hard max ${OPENROUTER_BATCH_HARD_MAX_REQUESTS}). This is a chunking bug.`,
            );
        }

        const requests = entries.map((entry) => ({
            custom_id: customIdByStableKey.get(entry.stableKey) ?? deriveCustomId(entry.request, entry.stableKey),
            body: { messages: JSON.parse(serializeChatMessages(entry.request)) as Array<{ role: string; content: string }> },
        }));

        const seenCustomIds = new Set<string>();
        for (const request of requests) {
            if (seenCustomIds.has(request.custom_id)) {
                throw new Error(`Duplicate custom_id in batch submission: ${request.custom_id}`);
            }

            seenCustomIds.add(request.custom_id);
        }

        // Persist the submission attempt before the POST so a lost response can
        // be correlated (custom ids + timestamp) from the dashboard.
        this.persistSubmissionAttempt(runDir, requests);

        // Field order matters: endpoint/model must serialize before requests.
        // Reasoning is NOT sent explicitly: the OpenRouter catalog entry for
        // google/gemini-3.7-flash:batch documents mandatory reasoning with
        // default effort medium, which matches the frozen judge contract
        // (reasoning level: medium). No temperature field is sent (batch
        // compatibility), and no provider-side JSON schema is used.
        const body = {
            endpoint: '/v1/chat/completions',
            model: this.config.model,
            requests,
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        try {
            const response = await fetch(`${this.apiBaseUrl}/beta/batches`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.config.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            const rawBody = await response.text();

            if (!response.ok) {
                if (isOpenRouterBatchTooLargeError(response.status, rawBody)) {
                    this.persistSubmissionRejection(runDir, requests, response.status, rawBody);
                    throw buildBatchNormalizedError(
                        `OpenRouter batch submit error ${response.status}: ${rawBody}`,
                        this.requestTimeoutMs,
                    );
                }

                throw buildBatchNormalizedError(
                    `OpenRouter batch submit error ${response.status}: ${rawBody}`,
                    this.requestTimeoutMs,
                );
            }

            const parsed = JSON.parse(rawBody) as BatchJobResponse;
            if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
                throw buildBatchNormalizedError(
                    'OpenRouter batch submit response did not contain a job id',
                    this.requestTimeoutMs,
                );
            }

            this.persistJobCompletion(runDir, parsed.id, {
                requests,
                submittedAt: new Date().toISOString(),
                status: 'submitted',
            });
            return parsed.id;
        } catch (error) {
            if (error instanceof Error && isNormalizedClientError(error)) {
                throw error;
            }

            throw buildBatchNormalizedError(
                `${getErrorMessage(error)}. The submission may or may not have been accepted by OpenRouter; check the OpenRouter batch dashboard for these custom ids and, if a job exists, record its id in the run manifest openRouterBatchJobIds before resuming to avoid double submission`,
                this.requestTimeoutMs,
            );
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private persistSubmissionAttempt(runDir: string, requests: Array<{ custom_id: string; body: unknown }>): void {
        const attemptsPath = path.join(runDir, 'judge-batch-submission-attempts.jsonl');
        fs.appendFileSync(
            attemptsPath,
            `${JSON.stringify({ attemptedAt: new Date().toISOString(), customIds: requests.map((request) => request.custom_id) })}\n`,
        );
    }

    private persistSubmissionRejection(
        runDir: string,
        requests: Array<{ custom_id: string; body: unknown }>,
        httpStatus: number,
        rawBody: string,
    ): void {
        const attemptsPath = path.join(runDir, 'judge-batch-submission-attempts.jsonl');
        fs.appendFileSync(
            attemptsPath,
            `${JSON.stringify({
                attemptedAt: new Date().toISOString(),
                customIds: requests.map((request) => request.custom_id),
                rejected: true,
                httpStatus,
                reason: rawBody.slice(0, 500),
            })}\n`,
        );
    }

    private async getJob(jobId: string): Promise<BatchJobResponse> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        try {
            const response = await fetch(`${this.apiBaseUrl}/beta/batches/${encodeURIComponent(jobId)}`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.config.apiKey}`,
                },
                signal: controller.signal,
            });

            const rawBody = await response.text();

            if (response.status === 404) {
                // OpenRouter can 404 for a few seconds after a successful
                // submit before the job is readable. Treat as not-ready.
                return {
                    id: jobId,
                    status: 'not_found',
                    error: rawBody,
                };
            }

            if (!response.ok) {
                throw buildBatchNormalizedError(
                    `OpenRouter batch poll error ${response.status}: ${rawBody}`,
                    this.requestTimeoutMs,
                );
            }

            return JSON.parse(rawBody) as BatchJobResponse;
        } catch (error) {
            if (isAbortError(error)) {
                throw buildBatchNormalizedError(
                    `OpenRouter batch poll timed out after ${this.requestTimeoutMs}ms`,
                    this.requestTimeoutMs,
                );
            }

            if (error instanceof Error && isNormalizedClientError(error)) {
                throw error;
            }

            throw buildBatchNormalizedError(getErrorMessage(error), this.requestTimeoutMs);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private async awaitJob(
        runDir: string,
        jobId: string,
        onJobStatus?: OpenRouterBatchPrepareInput['onJobStatus'],
    ): Promise<{ status: string; outcomes: Map<string, BatchLineOutcome>; usage: BatchJobResponse['usage'] }> {
        const startedAt = this.now();

        for (;;) {
            const job = await this.getJob(jobId);
            const status = job.status ?? 'unknown';
            const counts = job.request_counts ?? {};
            const total = counts.total ?? 0;
            const completed = (counts.completed ?? 0) + (counts.failed ?? 0);
            onJobStatus?.({ jobId, status, completed, total });

            if (status === 'not_found') {
                if (this.now() - startedAt > this.maxPollDurationMs) {
                    throw buildBatchNormalizedError(
                        `OpenRouter batch job ${jobId} stayed missing (404) for the ${Math.round(this.maxPollDurationMs / 60_000)}min poll budget; check the dashboard before resubmitting`,
                        this.requestTimeoutMs,
                    );
                }

                await this.sleep(this.pollIntervalMs);
                continue;
            }

            if (status === 'completed') {
                this.persistJobCompletion(runDir, jobId, {
                    status: 'completed',
                    completedAt: new Date().toISOString(),
                    requestCounts: job.request_counts ?? null,
                    usage: job.usage ?? null,
                });
                return { status, outcomes: this.extractOutcomes(job), usage: job.usage ?? null };
            }

            if (BATCH_FAILED_STATUSES.has(status)) {
                const message = extractErrorMessage(job.error) || `job ended with status ${status}`;
                this.persistJobCompletion(runDir, jobId, {
                    status,
                    failedAt: new Date().toISOString(),
                    error: message,
                });
                // Terminal failure state: not a transport error; lines are
                // resubmitted by the caller's residual logic.
                return { status, outcomes: new Map(), usage: null };
            }

            if (BATCH_TERMINAL_STATUSES.has(status)) {
                throw buildBatchNormalizedError(
                    `OpenRouter batch job ${jobId} ended with unexpected terminal status ${status}`,
                    this.requestTimeoutMs,
                );
            }

            if (this.now() - startedAt > this.maxPollDurationMs) {
                throw buildBatchNormalizedError(
                    `OpenRouter batch job ${jobId} did not complete within the ${Math.round(this.maxPollDurationMs / 60_000)}min poll budget; resume with --resume to re-poll the recorded job id`,
                    this.requestTimeoutMs,
                );
            }

            await this.sleep(this.pollIntervalMs);
        }
    }

    private extractOutcomes(job: BatchJobResponse): Map<string, BatchLineOutcome> {
        const outcomes = new Map<string, BatchLineOutcome>();
        const seenCustomIds = new Set<string>();

        for (const item of job.results ?? []) {
            const customId = item.custom_id;
            if (customId === undefined) {
                continue;
            }

            if (seenCustomIds.has(customId)) {
                outcomes.set(customId, { ok: false, errorMessage: 'duplicate result line for this custom id' });
                continue;
            }

            seenCustomIds.add(customId);

            const hasError = item.error !== null && item.error !== undefined;
            const hasResponse = item.response !== null && item.response !== undefined;

            if (hasError && hasResponse) {
                outcomes.set(customId, { ok: false, errorMessage: 'result contains both response and error' });
                continue;
            }

            if (hasError) {
                outcomes.set(customId, { ok: false, errorMessage: extractErrorMessage(item.error) });
                continue;
            }

            const statusCode = item.response?.status_code;
            if (statusCode !== undefined && (statusCode < 200 || statusCode >= 300)) {
                outcomes.set(customId, { ok: false, errorMessage: `response status ${statusCode}` });
                continue;
            }

            const content = item.response?.body?.choices?.[0]?.message?.content ?? '';

            try {
                if (!isCompleteMqmTextAnnotation(content)) {
                    throw new Error('annotation is incomplete (missing severity sections, malformed error line, or missing trailing contextBehavior line)');
                }

                parseMqmTextJudgeResponse(content);
                const usage = item.response?.body?.usage;
                outcomes.set(customId, {
                    ok: true,
                    rawText: content,
                    usage: computeCallCost({
                        provider: 'openrouter-batch',
                        model: toMetricsModelId(this.config.model),
                        phase: 'judge',
                        inputTokens: usage?.prompt_tokens ?? null,
                        outputTokens: usage?.completion_tokens ?? null,
                        reasoningTokens: usage?.reasoning?.reasoning_tokens
                            ?? usage?.completion_tokens_details?.reasoning_tokens
                            ?? null,
                        latencyMs: 0,
                    }, '2026-08-14'),
                });
            } catch (error) {
                outcomes.set(customId, {
                    ok: false,
                    errorMessage: `invalid MQM annotation: ${getErrorMessage(error)}`,
                });
            }
        }

        return outcomes;
    }

    private persistCustomIdMap(
        runDir: string,
        entries: OpenRouterBatchRequestEntry[],
        customIdByStableKey: Map<string, string>,
    ): void {
        fs.writeFileSync(
            path.join(runDir, 'judge-batch-custom-ids.json'),
            `${JSON.stringify(entries.map((entry) => ({
                custom_id: customIdByStableKey.get(entry.stableKey) ?? deriveCustomId(entry.request, entry.stableKey),
                stable_key: entry.stableKey,
            })), null, 2)}\n`,
        );
    }

    private persistJobCompletion(runDir: string, jobId: string, patch: Record<string, unknown>): void {
        const artifactPath = path.join(runDir, `judge-batch-${jobId}.json`);
        const existing = fs.existsSync(artifactPath)
            ? JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>
            : {};
        fs.writeFileSync(
            artifactPath,
            `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`,
        );
    }
}
