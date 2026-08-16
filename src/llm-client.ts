import type { ContextRuntimeSample } from './context-benchmark-types.js';
import type { LlamaCppMode } from './llamacpp.js';
import type { CallUsageMetrics } from './run-metrics.js';

/**
 * Common interface for LLM translation clients.
 * All providers (Gemini, Qwen, etc.) must implement this interface.
 */

export interface TranslationResult {
    output: string;
    latencyMs: number;
    usage: CallUsageMetrics;
}

export type TranslationMessageLayout = 'default' | 'system-context';

export type NormalizedClientErrorClass =
    | 'rate_limit'
    | 'timeout'
    | 'server_overload'
    | 'network'
    | 'invalid_response'
    | 'auth'
    | 'bad_request'
    | 'unknown';

export type RetryCooldownScope = 'item' | 'throttle_bucket' | 'none';

export interface NormalizedClientError {
    errorClass: NormalizedClientErrorClass;
    retryable: boolean;
    rawMessage: string;
    httpStatus?: number;
    providerCode?: string;
    retryAfterMs?: number;
    cooldownScope: RetryCooldownScope;
    requestTimeoutMs: number;
}

const NORMALIZED_ERROR_CLASSES = new Set<NormalizedClientErrorClass>([
    'rate_limit',
    'timeout',
    'server_overload',
    'network',
    'invalid_response',
    'auth',
    'bad_request',
    'unknown',
]);

const COOLDOWN_SCOPES = new Set<RetryCooldownScope>([
    'item',
    'throttle_bucket',
    'none',
]);

const DETERMINISTIC_BAD_REQUEST_STATUSES = new Set([
    400,
    404,
    409,
    410,
    413,
    415,
    422,
    423,
]);

const HTTP_STATUS_PATTERN = /\b(400|401|403|404|408|409|410|413|415|422|423|429|500|502|503|504)\b/;
const RETRY_AFTER_PATTERN = /retry(?:-|\s)?after[:\s]+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?)?/i;

export function isNormalizedClientError(error: unknown): error is NormalizedClientError {
    if (typeof error !== 'object' || error === null) {
        return false;
    }

    const candidate = error as Record<string, unknown>;
    return typeof candidate.rawMessage === 'string'
        && typeof candidate.retryable === 'boolean'
        && typeof candidate.requestTimeoutMs === 'number'
        && typeof candidate.errorClass === 'string'
        && NORMALIZED_ERROR_CLASSES.has(candidate.errorClass as NormalizedClientErrorClass)
        && typeof candidate.cooldownScope === 'string'
        && COOLDOWN_SCOPES.has(candidate.cooldownScope as RetryCooldownScope);
}

export function isAbortError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'name' in error
        && (error as { name?: unknown }).name === 'AbortError';
}

export function isRetryableErrorClass(errorClass: NormalizedClientErrorClass): boolean {
    return errorClass === 'rate_limit'
        || errorClass === 'timeout'
        || errorClass === 'server_overload'
        || errorClass === 'network'
        || errorClass === 'invalid_response'
        || errorClass === 'unknown';
}

export function getErrorMessage(error: unknown): string {
    if (isNormalizedClientError(error)) {
        return error.rawMessage;
    }

    if (error instanceof Error) {
        return error.toString();
    }

    return String(error);
}

export function extractHttpStatus(rawMessage: string): number | undefined {
    const match = rawMessage.match(HTTP_STATUS_PATTERN);
    return match ? Number(match[1]) : undefined;
}

export function extractRetryAfterMs(rawMessage: string): number | undefined {
    const match = rawMessage.match(RETRY_AFTER_PATTERN);
    if (!match) {
        return undefined;
    }

    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) {
        return undefined;
    }

    const unit = match[2]?.toLowerCase();
    if (!unit || unit === 's' || unit === 'sec' || unit === 'secs' || unit === 'second' || unit === 'seconds') {
        return Math.round(amount * 1_000);
    }

    return Math.round(amount);
}

export function isDeterministicBadRequestStatus(httpStatus: number | undefined): boolean {
    return httpStatus !== undefined && DETERMINISTIC_BAD_REQUEST_STATUSES.has(httpStatus);
}

export interface LLMClient {
    getModelName(): string;
    getProviderName(): string;
    getRequestTimeoutMs(): number;
    translate(
        text: string,
        systemPrompt: string,
        sourceLang: string,
        targetLang: string
    ): Promise<TranslationResult>;
}

export type Provider = 'gemini' | 'qwen' | 'openrouter' | 'deepseek' | 'deepl' | 'google-translate-basic' | 'google-web' | 'llamacpp' | 'papago';

/**
 * Defers client construction until the first actual call. Reused participants
 * (for example DeepL/Google rows whose cells are all copied by a fork) never
 * construct a client, so missing provider credentials for fully-reused rows
 * cannot abort the run.
 */
export class LazyClient implements LLMClient {
    private cached: LLMClient | null = null;

    constructor(private readonly factory: () => LLMClient) {}

    private get(): LLMClient {
        if (this.cached === null) {
            this.cached = this.factory();
        }

        return this.cached;
    }

    getModelName(): string {
        return this.get().getModelName();
    }

    getProviderName(): string {
        return this.get().getProviderName();
    }

    getRequestTimeoutMs(): number {
        return this.get().getRequestTimeoutMs();
    }

    async translate(
        text: string,
        systemPrompt: string,
        sourceLang: string,
        targetLang: string,
    ): Promise<TranslationResult> {
        return this.get().translate(text, systemPrompt, sourceLang, targetLang);
    }
}

/** A single test condition: model + prompt + data combination */
export interface Condition {
    label: string;           // Display label: "A", "B", "C", etc.
    provider: Provider;
    model: string;
    promptFile: string;      // Prompt file path
    promptFingerprintSha256?: string;
    prompt: string;          // Loaded prompt content
    dataFile: string;        // Test data file path
    testCases: BenchmarkTestCase[];   // Loaded test cases
    client: LLMClient;       // Initialized client
    messageLayout?: TranslationMessageLayout;
    llamaCppServerUrl?: string;
    llamaCppMode?: LlamaCppMode;
}

export interface SentenceTestCase {
    id: number;
    source: string;
    sourceLang: string;
    targetLangs: string[];
    category?: string;
}

export type TestCase = SentenceTestCase;

export type BenchmarkTestCase = SentenceTestCase | ContextRuntimeSample;
