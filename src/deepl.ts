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

const DEEPL_PRO_ENDPOINT = 'https://api.deepl.com/v2/translate';
const DEEPL_FREE_ENDPOINT = 'https://api-free.deepl.com/v2/translate';
const DEEPL_REQUEST_TIMEOUT_MS = 30_000;
const DEEPL_TAGGED_CONTEXT_MODEL_INPUT_PATTERN = /^<context>\n([\s\S]*?)\n<\/context>\n\n<input>\n([\s\S]*)\n<\/input>$/;
const DEEPL_CONTEXT_MODEL_INPUT_PATTERN = /^<context>\n([\s\S]*?)\n<\/context>\n\n(?:Text to translate|Current input):\n([\s\S]+)$/;

function resolveDeepLEndpoint(apiKey: string, endpoint?: string): string {
    if (endpoint) {
        return endpoint;
    }

    return apiKey.trim().endsWith(':fx')
        ? DEEPL_FREE_ENDPOINT
        : DEEPL_PRO_ENDPOINT;
}

type DeepLResponse = {
    translations?: Array<{
        text?: unknown;
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

function classifyDeepLError(rawMessage: string, httpStatus?: number): NormalizedClientErrorClass {
    const lower = rawMessage.toLowerCase();

    if (httpStatus === 429 || httpStatus === 456 || lower.includes('quota') || lower.includes('rate limit') || lower.includes('too many requests')) {
        return 'rate_limit';
    }

    if (httpStatus === 401 || httpStatus === 403 || lower.includes('authorization') || lower.includes('auth key') || lower.includes('api key')) {
        return 'auth';
    }

    if (isDeterministicBadRequestStatus(httpStatus) || lower.includes('unsupported') || lower.includes('source_lang') || lower.includes('target_lang') || lower.includes('bad request')) {
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

function buildDeepLNormalizedError(
    rawMessage: string,
    requestTimeoutMs: number,
    options: {
        httpStatus?: number;
        retryAfterMs?: number;
    } = {},
): NormalizedClientError {
    const httpStatus = options.httpStatus ?? extractHttpStatus(rawMessage);
    const errorClass = classifyDeepLError(rawMessage, httpStatus);

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

export function normalizeDeepLError(error: unknown, requestTimeoutMs: number = DEEPL_REQUEST_TIMEOUT_MS): NormalizedClientError {
    if (isNormalizedClientError(error)) {
        return error;
    }

    if (isAbortError(error)) {
        return buildDeepLNormalizedError(`DeepL request timed out after ${requestTimeoutMs}ms`, requestTimeoutMs);
    }

    return buildDeepLNormalizedError(getErrorMessage(error), requestTimeoutMs);
}

function mapDeepLSourceLang(sourceLang: string): string | undefined {
    switch (sourceLang.trim().toLowerCase()) {
        case 'korean':
        case 'ko':
            return 'KO';
        default:
            return undefined;
    }
}

function mapDeepLTargetLang(targetLang: string): string {
    switch (targetLang.trim().toLowerCase()) {
        case 'en':
        case 'english':
            return 'EN';
        case 'ja':
        case 'japanese':
            return 'JA';
        case 'zh-hans':
        case 'chinese simplified':
            return 'ZH-HANS';
        default:
            throw new Error(`DeepL unsupported target language: ${targetLang}`);
    }
}

function extractDeepLTranslationText(response: DeepLResponse): string {
    const text = response.translations?.[0]?.text;
    if (typeof text !== 'string') {
        throw new Error('DeepL invalid response: response did not contain translations[0].text');
    }

    const output = text.trim();
    if (!output) {
        throw new Error('DeepL invalid response: response contained empty translations[0].text');
    }

    return output;
}

function extractDeepLRequestParts(text: string): {
    text: string;
    context?: string;
} {
    const match = text.match(DEEPL_TAGGED_CONTEXT_MODEL_INPUT_PATTERN) ?? text.match(DEEPL_CONTEXT_MODEL_INPUT_PATTERN);

    if (!match) {
        return { text };
    }

    const context = match[1]?.trim();
    const currentInput = match[2]?.trim();

    if (!currentInput) {
        return { text };
    }

    return context
        ? { text: currentInput, context }
        : { text: currentInput };
}

export class DeepLClient implements LLMClient {
    private readonly apiKey: string;
    private readonly modelName: string;
    private readonly endpoint: string;
    private readonly requestTimeoutMs: number;

    constructor(
        apiKey: string,
        modelName: string,
        endpoint?: string,
        requestTimeoutMs: number = DEEPL_REQUEST_TIMEOUT_MS,
    ) {
        this.apiKey = apiKey;
        this.modelName = modelName;
        this.endpoint = resolveDeepLEndpoint(apiKey, endpoint);
        this.requestTimeoutMs = requestTimeoutMs;
    }

    getModelName(): string {
        return this.modelName;
    }

    getProviderName(): string {
        return 'deepl';
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
        const requestParts = extractDeepLRequestParts(text);
        const requestBody: {
            text: string[];
            target_lang: string;
            source_lang?: string;
            context?: string;
        } = {
            text: [requestParts.text],
            target_lang: mapDeepLTargetLang(targetLang),
        };

        if (requestParts.context) {
            requestBody.context = requestParts.context;
        }

        const mappedSourceLang = mapDeepLSourceLang(sourceLang);
        if (mappedSourceLang) {
            requestBody.source_lang = mappedSourceLang;
        }

        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        try {
            const response = await fetch(this.endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `DeepL-Auth-Key ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw buildDeepLNormalizedError(
                    `DeepL API error ${response.status}: ${errorText}`,
                    this.getRequestTimeoutMs(),
                    {
                        httpStatus: response.status,
                        retryAfterMs: parseRetryAfterHeader(response.headers?.get('retry-after')) ?? extractRetryAfterMs(errorText),
                    },
                );
            }

            let data: DeepLResponse;
            try {
                data = await response.json() as DeepLResponse;
            } catch {
                throw new Error('DeepL invalid response: failed to parse JSON');
            }

            const output = extractDeepLTranslationText(data);
            const latencyMs = Date.now() - startTime;

            return {
                output,
                latencyMs,
                usage: computeCallCost({
                    provider: 'deepl',
                    model: this.modelName,
                    phase: 'translation',
                    inputTokens: null,
                    outputTokens: null,
                    reasoningTokens: null,
                    latencyMs,
                }, '2026-04-17'),
            };
        } catch (error) {
            throw normalizeDeepLError(error, this.getRequestTimeoutMs());
        } finally {
            clearTimeout(timeoutId);
        }
    }
}
