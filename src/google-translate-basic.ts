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

const GOOGLE_TRANSLATE_BASIC_DEFAULT_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const GOOGLE_TRANSLATE_BASIC_REQUEST_TIMEOUT_MS = 30_000;

type GoogleTranslateBasicResponse = {
    data?: {
        translations?: Array<{
            translatedText?: unknown;
        }>;
    };
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

function classifyGoogleTranslateBasicError(rawMessage: string, httpStatus?: number): NormalizedClientErrorClass {
    const lower = rawMessage.toLowerCase();

    if (httpStatus === 429 || lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('quota')) {
        return 'rate_limit';
    }

    if (httpStatus === 401 || httpStatus === 403 || lower.includes('forbidden') || lower.includes('api key') || lower.includes('permission')) {
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

function buildGoogleTranslateBasicNormalizedError(
    rawMessage: string,
    requestTimeoutMs: number,
    options: {
        httpStatus?: number;
        retryAfterMs?: number;
    } = {},
): NormalizedClientError {
    const httpStatus = options.httpStatus ?? extractHttpStatus(rawMessage);
    const errorClass = classifyGoogleTranslateBasicError(rawMessage, httpStatus);

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

export function normalizeGoogleTranslateBasicError(
    error: unknown,
    requestTimeoutMs: number = GOOGLE_TRANSLATE_BASIC_REQUEST_TIMEOUT_MS,
): NormalizedClientError {
    if (isNormalizedClientError(error)) {
        return error;
    }

    if (isAbortError(error)) {
        return buildGoogleTranslateBasicNormalizedError(
            `Google Cloud Translation Basic request timed out after ${requestTimeoutMs}ms`,
            requestTimeoutMs,
        );
    }

    return buildGoogleTranslateBasicNormalizedError(getErrorMessage(error), requestTimeoutMs);
}

function mapGoogleTranslateBasicSourceLang(sourceLang: string): string {
    switch (sourceLang.trim().toLowerCase()) {
        case 'korean':
        case 'ko':
            return 'ko';
        default:
            throw new Error(`Google Cloud Translation Basic unsupported source language: ${sourceLang}`);
    }
}

function mapGoogleTranslateBasicTargetLang(targetLang: string): string {
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
            throw new Error(`Google Cloud Translation Basic unsupported target language: ${targetLang}`);
    }
}

function extractGoogleTranslateBasicTranslationText(response: GoogleTranslateBasicResponse): string {
    const text = response.data?.translations?.[0]?.translatedText;
    if (typeof text !== 'string') {
        throw new Error('Google Cloud Translation Basic invalid response: response did not contain data.translations[0].translatedText');
    }

    const output = text.trim();
    if (!output) {
        throw new Error('Google Cloud Translation Basic invalid response: response contained empty data.translations[0].translatedText');
    }

    return output;
}

export class GoogleTranslateBasicClient implements LLMClient {
    constructor(
        private readonly apiKey: string,
        private readonly modelName: string,
        private readonly endpoint: string = GOOGLE_TRANSLATE_BASIC_DEFAULT_ENDPOINT,
        private readonly requestTimeoutMs: number = GOOGLE_TRANSLATE_BASIC_REQUEST_TIMEOUT_MS,
    ) {
    }

    getModelName(): string {
        return this.modelName;
    }

    getProviderName(): string {
        return 'google-translate-basic';
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
        const requestBody = {
            q: text,
            source: mapGoogleTranslateBasicSourceLang(sourceLang),
            target: mapGoogleTranslateBasicTargetLang(targetLang),
            format: 'text',
        };
        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        try {
            const response = await fetch(`${this.endpoint}?key=${encodeURIComponent(this.apiKey)}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw buildGoogleTranslateBasicNormalizedError(
                    `Google Cloud Translation Basic error ${response.status}: ${errorText}`,
                    this.getRequestTimeoutMs(),
                    {
                        httpStatus: response.status,
                        retryAfterMs: parseRetryAfterHeader(response.headers?.get('retry-after')) ?? extractRetryAfterMs(errorText),
                    },
                );
            }

            let data: GoogleTranslateBasicResponse;
            try {
                data = await response.json() as GoogleTranslateBasicResponse;
            } catch {
                throw new Error('Google Cloud Translation Basic invalid response: failed to parse JSON');
            }

            const output = extractGoogleTranslateBasicTranslationText(data);
            const latencyMs = Date.now() - startTime;

            return {
                output,
                latencyMs,
                usage: computeCallCost({
                    provider: 'google-translate-basic',
                    model: this.modelName,
                    phase: 'translation',
                    inputTokens: null,
                    outputTokens: null,
                    reasoningTokens: null,
                    latencyMs,
                }, '2026-04-19'),
            };
        } catch (error) {
            throw normalizeGoogleTranslateBasicError(error, this.getRequestTimeoutMs());
        } finally {
            clearTimeout(timeoutId);
        }
    }
}
