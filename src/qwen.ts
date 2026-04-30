import {
    extractHttpStatus,
    extractRetryAfterMs,
    getErrorMessage,
    isDeterministicBadRequestStatus,
    isAbortError,
    isNormalizedClientError,
    isRetryableErrorClass,
    type LLMClient,
    type NormalizedClientError,
    type NormalizedClientErrorClass,
    type TranslationResult,
} from './llm-client.js';
import { buildTranslationPromptVariables, interpolatePrompt } from './gemini.js';
import { getQwenTranslationRequestFields } from './reasoning-policy.js';
import { computeCallCost } from './run-metrics.js';

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

function classifyQwenError(rawMessage: string, httpStatus?: number): NormalizedClientErrorClass {
    const lower = rawMessage.toLowerCase();

    if (httpStatus === 429 || lower.includes('rate limit') || lower.includes('quota')) {
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

function buildQwenNormalizedError(
    rawMessage: string,
    requestTimeoutMs: number,
    options: {
        httpStatus?: number;
        providerCode?: string;
        retryAfterMs?: number;
    } = {},
): NormalizedClientError {
    const httpStatus = options.httpStatus ?? extractHttpStatus(rawMessage);
    const errorClass = classifyQwenError(rawMessage, httpStatus);

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

export function normalizeQwenError(error: unknown, requestTimeoutMs: number): NormalizedClientError {
    if (isNormalizedClientError(error)) {
        return error;
    }

    if (isAbortError(error)) {
        return buildQwenNormalizedError(`Request timed out after ${requestTimeoutMs}ms`, requestTimeoutMs);
    }

    return buildQwenNormalizedError(getErrorMessage(error), requestTimeoutMs);
}

/**
 * DashScope (Alibaba Cloud) OpenAI-compatible API client for Qwen models.
 * Based on the patterns from qwen_async.py.
 */
export class QwenClient implements LLMClient {
    private apiKey: string;
    private modelName: string;
    private baseUrl: string;
    private timeout: number;

    constructor(
        apiKey: string,
        modelName: string = 'qwen3.5-flash',
        baseUrl: string = 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        timeout: number = 30000
    ) {
        this.apiKey = apiKey;
        this.modelName = modelName;
        this.baseUrl = baseUrl;
        this.timeout = timeout;
    }

    getModelName(): string {
        return this.modelName;
    }

    getProviderName(): string {
        return 'qwen';
    }

    getRequestTimeoutMs(): number {
        return this.timeout;
    }

    async translate(
        text: string,
        systemPrompt: string,
        sourceLang: string,
        targetLang: string
    ): Promise<TranslationResult> {
        const interpolatedPrompt = interpolatePrompt(systemPrompt, buildTranslationPromptVariables(text, sourceLang, targetLang));

        const requestBody = {
            model: this.modelName,
            messages: [
                { role: 'system', content: interpolatedPrompt },
                { role: 'user', content: text },
            ],
            ...getQwenTranslationRequestFields(),
        };

        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw buildQwenNormalizedError(
                    `DashScope API error ${response.status}: ${errorText}`,
                    this.getRequestTimeoutMs(),
                    {
                        httpStatus: response.status,
                        providerCode: extractProviderCodeFromBody(errorText),
                        retryAfterMs: parseRetryAfterHeader(response.headers?.get('retry-after')) ?? extractRetryAfterMs(errorText),
                    },
                );
            }

            const data = await response.json() as {
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

            const choices = data.choices ?? [];
            if (choices.length === 0) {
                throw new Error('DashScope response did not contain choices');
            }

            const content = choices[0].message?.content;
            const output = this.extractContent(content);
            const latencyMs = Date.now() - startTime;
            const usage = data.usage ?? {};

            return {
                output,
                latencyMs,
                usage: computeCallCost({
                    provider: 'qwen',
                    model: this.modelName,
                    phase: 'translation',
                    inputTokens: usage.prompt_tokens ?? null,
                    outputTokens: usage.completion_tokens ?? null,
                    reasoningTokens: usage.reasoning_tokens ?? null,
                    latencyMs,
                }, '2026-04-17'),
            };
        } catch (error) {
            throw normalizeQwenError(error, this.getRequestTimeoutMs());
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Extract message content from DashScope response.
     * Handles both string and array content formats (matching qwen_async.py logic).
     */
    private extractContent(content: unknown): string {
        if (typeof content === 'string') {
            const result = content.trim();
            if (result) return result;
            throw new Error('DashScope response contained empty message content');
        }

        if (Array.isArray(content)) {
            const parts: string[] = [];
            for (const item of content) {
                if (typeof item === 'object' && item !== null && 'text' in item) {
                    const text = (item as { text?: string }).text;
                    if (typeof text === 'string' && text.trim()) {
                        parts.push(text.trim());
                    }
                }
            }
            if (parts.length > 0) return parts.join('\n');
        }

        throw new Error('DashScope response did not contain message content');
    }

    /**
     * Verify that a DashScope API key is valid.
     */
    static async verifyApiKey(
        apiKey: string,
        baseUrl: string = 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: string = 'qwen3.5-flash'
    ): Promise<boolean> {
        if (!apiKey) return false;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            const response = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: 'ping' }],
                    ...getQwenTranslationRequestFields(),
                    max_tokens: 1,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);
            return response.ok;
        } catch {
            return false;
        }
    }
}
