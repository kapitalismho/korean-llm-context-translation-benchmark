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
import { buildTranslationPromptVariables, interpolatePrompt } from './gemini.js';
import { getDeepSeekTranslationRequestFields } from './reasoning-policy.js';
import { computeCallCost } from './run-metrics.js';

type Environment = Record<string, string | undefined>;

type DeepSeekResponse = {
    choices?: Array<{
        message?: {
            content?: string | Array<{ text?: string }>;
        };
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        reasoning_tokens?: number;
    };
};

function extractProviderCodeFromBody(rawBody: string): string | undefined {
    try {
        const parsed = JSON.parse(rawBody) as {
            error?: { code?: unknown };
            code?: unknown;
        };

        if (typeof parsed.error?.code === 'string') {
            return parsed.error.code;
        }

        if (typeof parsed.code === 'string') {
            return parsed.code;
        }
    } catch {
        return undefined;
    }

    return undefined;
}

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

function buildDeepSeekChatCompletionsUrl(baseUrl: string): string {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');

    if (normalizedBaseUrl.endsWith('/chat/completions')) {
        return normalizedBaseUrl;
    }

    return `${normalizedBaseUrl}/chat/completions`;
}

function classifyDeepSeekError(rawMessage: string, httpStatus?: number): NormalizedClientErrorClass {
    const lower = rawMessage.toLowerCase();

    if (httpStatus === 402 || lower.includes('insufficient balance') || lower.includes('insufficient_balance')) {
        return 'auth';
    }

    if (httpStatus === 429 || lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('quota')) {
        return 'rate_limit';
    }

    if (httpStatus === 401 || httpStatus === 403 || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('api key')) {
        return 'auth';
    }

    if (isDeterministicBadRequestStatus(httpStatus) || lower.includes('model not found') || lower.includes('unsupported') || lower.includes('invalid request')) {
        return 'bad_request';
    }

    if (lower.includes('response did not contain') || lower.includes('response contained empty')) {
        return 'invalid_response';
    }

    if (httpStatus === 408 || lower.includes('timed out') || lower.includes('timeout')) {
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

function buildDeepSeekNormalizedError(
    rawMessage: string,
    requestTimeoutMs: number,
    options: {
        httpStatus?: number;
        providerCode?: string;
        retryAfterMs?: number;
    } = {},
): NormalizedClientError {
    const httpStatus = options.httpStatus ?? extractHttpStatus(rawMessage);
    const errorClass = classifyDeepSeekError(rawMessage, httpStatus);

    return {
        errorClass,
        retryable: isRetryableErrorClass(errorClass),
        rawMessage,
        httpStatus,
        providerCode: options.providerCode,
        retryAfterMs: options.retryAfterMs ?? extractRetryAfterMs(rawMessage),
        cooldownScope: errorClass === 'rate_limit'
            ? 'throttle_bucket'
            : errorClass === 'timeout' || errorClass === 'network' || errorClass === 'invalid_response'
                ? 'item'
                : 'none',
        requestTimeoutMs,
    };
}

export function normalizeDeepSeekError(error: unknown, requestTimeoutMs: number): NormalizedClientError {
    if (isNormalizedClientError(error)) {
        return error;
    }

    if (isAbortError(error)) {
        return buildDeepSeekNormalizedError(`Request timed out after ${requestTimeoutMs}ms`, requestTimeoutMs);
    }

    return buildDeepSeekNormalizedError(getErrorMessage(error), requestTimeoutMs);
}

export function getDeepSeekApiKey(env: Environment): string {
    const apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        throw new Error('DEEPSEEK_API_KEY not found in environment variables');
    }

    return apiKey;
}

export function extractDeepSeekContent(content: unknown): string {
    if (typeof content === 'string') {
        const result = content.trim();
        if (result) {
            return result;
        }

        throw new Error('DeepSeek response contained empty message content');
    }

    if (Array.isArray(content)) {
        const parts: string[] = [];

        for (const item of content) {
            if (typeof item === 'object' && item !== null && 'text' in item) {
                const text = (item as { text?: unknown }).text;
                if (typeof text === 'string') {
                    const trimmed = text.trim();
                    if (trimmed) {
                        parts.push(trimmed);
                    }
                }
            }
        }

        if (parts.length > 0) {
            return parts.join('\n');
        }
    }

    throw new Error('DeepSeek response did not contain message content');
}

export class DeepSeekClient implements LLMClient {
    constructor(
        private apiKey: string,
        private modelName: string = 'deepseek-v4-flash',
        private baseUrl: string = 'https://api.deepseek.com',
        private timeoutMs: number = 30000,
    ) {}

    getModelName(): string {
        return this.modelName;
    }

    getProviderName(): string {
        return 'deepseek';
    }

    getRequestTimeoutMs(): number {
        return this.timeoutMs;
    }

    async translate(
        text: string,
        systemPrompt: string,
        sourceLang: string,
        targetLang: string,
    ): Promise<TranslationResult> {
        const interpolatedPrompt = interpolatePrompt(systemPrompt, buildTranslationPromptVariables(text, sourceLang, targetLang));

        const requestBody = {
            model: this.modelName,
            messages: [
                { role: 'system', content: interpolatedPrompt },
                { role: 'user', content: text },
            ],
            ...getDeepSeekTranslationRequestFields(),
        };

        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await fetch(buildDeepSeekChatCompletionsUrl(this.baseUrl), {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw buildDeepSeekNormalizedError(
                    `DeepSeek API error ${response.status}: ${errorText}`,
                    this.getRequestTimeoutMs(),
                    {
                        httpStatus: response.status,
                        providerCode: extractProviderCodeFromBody(errorText),
                        retryAfterMs: parseRetryAfterHeader(response.headers?.get('retry-after')) ?? extractRetryAfterMs(errorText),
                    },
                );
            }

            const data = await response.json() as DeepSeekResponse;
            const output = extractDeepSeekContent(data.choices?.[0]?.message?.content);
            const latencyMs = Date.now() - startTime;
            const usage = data.usage ?? {};

            return {
                output,
                latencyMs,
                usage: computeCallCost({
                    provider: 'deepseek',
                    model: this.modelName,
                    phase: 'translation',
                    inputTokens: usage.prompt_tokens ?? null,
                    outputTokens: usage.completion_tokens ?? null,
                    reasoningTokens: usage.reasoning_tokens ?? null,
                    latencyMs,
                }, '2026-04-24'),
            };
        } catch (error) {
            throw normalizeDeepSeekError(error, this.getRequestTimeoutMs());
        } finally {
            clearTimeout(timeoutId);
        }
    }
}
