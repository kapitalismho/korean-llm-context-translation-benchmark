import {
    extractHttpStatus,
    extractRetryAfterMs,
    getErrorMessage,
    isAbortError,
    isDeterministicBadRequestStatus,
    isNormalizedClientError,
    isRetryableErrorClass,
    type LLMClient,
    type NormalizedClientError,
    type NormalizedClientErrorClass,
    type TranslationResult,
} from './llm-client.js';
import { computeCallCost } from './run-metrics.js';

const GOOGLE_WEB_DEFAULT_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const GOOGLE_WEB_REQUEST_TIMEOUT_MS = 30_000;

type GoogleWebObjectResponse = {
    sentences?: Array<{
        trans?: unknown;
    }>;
};

function parseRetryAfterHeader(retryAfter: string | null | undefined): number | undefined {
    if (!retryAfter) {
        return undefined;
    }

    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
        return Math.max(0, Math.round(seconds * 1_000));
    }

    const targetTime = Date.parse(retryAfter);
    if (!Number.isNaN(targetTime)) {
        return Math.max(0, targetTime - Date.now());
    }

    return undefined;
}

function classifyGoogleWebError(rawMessage: string, httpStatus?: number): NormalizedClientErrorClass {
    const lower = rawMessage.toLowerCase();

    if (httpStatus === 429 || lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('quota')) {
        return 'rate_limit';
    }

    if (httpStatus === 401 || httpStatus === 403 || lower.includes('forbidden')) {
        return 'auth';
    }

    if (isDeterministicBadRequestStatus(httpStatus) || lower.includes('unsupported') || lower.includes('invalid request') || lower.includes('bad request')) {
        return 'bad_request';
    }

    if (lower.includes('invalid response') || lower.includes('failed to parse json') || lower.includes('did not contain')) {
        return 'invalid_response';
    }

    if (httpStatus === 408 || lower.includes('timeout') || lower.includes('timed out')) {
        return 'timeout';
    }

    if (httpStatus === 500 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504 || lower.includes('overload') || lower.includes('unavailable') || lower.includes('internal')) {
        return 'server_overload';
    }

    if (lower.includes('network') || lower.includes('fetch failed') || lower.includes('socket') || lower.includes('econn')) {
        return 'network';
    }

    return 'unknown';
}

function buildGoogleWebNormalizedError(
    rawMessage: string,
    requestTimeoutMs: number,
    options: {
        httpStatus?: number;
        retryAfterMs?: number;
    } = {},
): NormalizedClientError {
    const httpStatus = options.httpStatus ?? extractHttpStatus(rawMessage);
    const errorClass = classifyGoogleWebError(rawMessage, httpStatus);

    return {
        errorClass,
        retryable: isRetryableErrorClass(errorClass),
        rawMessage,
        httpStatus,
        retryAfterMs: options.retryAfterMs ?? extractRetryAfterMs(rawMessage),
        cooldownScope: errorClass === 'rate_limit'
            ? 'throttle_bucket'
            : errorClass === 'timeout' || errorClass === 'network' || errorClass === 'invalid_response'
                ? 'item'
                : 'none',
        requestTimeoutMs,
    };
}

export function normalizeGoogleWebError(
    error: unknown,
    requestTimeoutMs: number = GOOGLE_WEB_REQUEST_TIMEOUT_MS,
): NormalizedClientError {
    if (isNormalizedClientError(error)) {
        return error;
    }

    if (isAbortError(error)) {
        return buildGoogleWebNormalizedError(`Google Translate web request timed out after ${requestTimeoutMs}ms`, requestTimeoutMs);
    }

    return buildGoogleWebNormalizedError(getErrorMessage(error), requestTimeoutMs);
}

function mapGoogleWebSourceLang(sourceLang: string): string {
    switch (sourceLang.trim().toLowerCase()) {
        case 'korean':
        case 'ko':
            return 'ko';
        default:
            throw new Error(`Google Translate web unsupported source language: ${sourceLang}`);
    }
}

function mapGoogleWebTargetLang(targetLang: string): string {
    switch (targetLang.trim().toLowerCase()) {
        case 'en':
        case 'english':
            return 'en';
        case 'ja':
        case 'japanese':
            return 'ja';
        case 'zh-hans':
        case 'chinese simplified':
            return 'zh-CN';
        default:
            throw new Error(`Google Translate web unsupported target language: ${targetLang}`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractGoogleWebTranslation(response: unknown): string {
    if (isRecord(response)) {
        const sentences = response.sentences;
        if (Array.isArray(sentences)) {
            const output = sentences
                .flatMap((sentence) => isRecord(sentence) && typeof sentence.trans === 'string' ? [sentence.trans] : [])
                .join('')
                .trim();

            if (output) {
                return output;
            }
        }
    }

    if (Array.isArray(response)) {
        const parts = Array.isArray(response[0]) ? response[0] : [];
        const output = parts
            .flatMap((part) => Array.isArray(part) && typeof part[0] === 'string' ? [part[0]] : [])
            .join('')
            .trim();

        if (output) {
            return output;
        }
    }

    throw new Error('Google Translate web invalid response: response did not contain translated text');
}

export class GoogleWebClient implements LLMClient {
    constructor(
        private readonly modelName: string,
        private readonly endpoint: string = GOOGLE_WEB_DEFAULT_ENDPOINT,
        private readonly requestTimeoutMs: number = GOOGLE_WEB_REQUEST_TIMEOUT_MS,
    ) {
    }

    getModelName(): string {
        return this.modelName;
    }

    getProviderName(): string {
        return 'google-web';
    }

    getRequestTimeoutMs(): number {
        return this.requestTimeoutMs;
    }

    async translate(
        text: string,
        _systemPrompt: string,
        sourceLang: string,
        targetLang: string,
    ): Promise<TranslationResult> {
        const params = new URLSearchParams({
            sl: mapGoogleWebSourceLang(sourceLang),
            tl: mapGoogleWebTargetLang(targetLang),
            q: text,
            ie: 'UTF-8',
            oe: 'UTF-8',
        });
        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        try {
            const response = await fetch(`${this.endpoint}?client=gtx&dj=1&dt=t`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                },
                body: params.toString(),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw buildGoogleWebNormalizedError(
                    `Google Translate web error ${response.status}: ${errorText}`,
                    this.getRequestTimeoutMs(),
                    {
                        httpStatus: response.status,
                        retryAfterMs: parseRetryAfterHeader(response.headers?.get('retry-after')) ?? extractRetryAfterMs(errorText),
                    },
                );
            }

            let data: unknown;
            try {
                data = await response.json();
            } catch {
                throw new Error('Google Translate web invalid response: failed to parse JSON');
            }

            const output = extractGoogleWebTranslation(data);
            const latencyMs = Date.now() - startTime;

            return {
                output,
                latencyMs,
                usage: computeCallCost({
                    provider: 'google-web',
                    model: this.modelName,
                    phase: 'translation',
                    inputTokens: null,
                    outputTokens: null,
                    reasoningTokens: null,
                    latencyMs,
                }, '2026-04-17'),
            };
        } catch (error) {
            throw normalizeGoogleWebError(error, this.getRequestTimeoutMs());
        } finally {
            clearTimeout(timeoutId);
        }
    }
}
