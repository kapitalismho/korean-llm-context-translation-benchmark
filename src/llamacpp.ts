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
import { parseContextModelInput } from './context-serialization.js';
import { buildTranslationPromptVariables, interpolatePrompt } from './gemini.js';
import { getLlamaCppTranslationRequestFields } from './reasoning-policy.js';
import { computeCallCost } from './run-metrics.js';

const DEFAULT_LLAMACPP_TIMEOUT_MS = 120_000;
const CHAT_LLAMACPP_SAMPLING = {
    temperature: 1,
    max_tokens: 256,
    // Do not stop on a single newline: Gemma 4 emits `<|channel>thought\n`
    // before the real answer when thinking is left on. Thinking is disabled
    // separately; this keeps a leftover thought header from becoming the
    // whole translation.
    stop: ['\n\n', '<end_of_turn>', '<eos>'],
} as const;

const COMPLETION_LLAMACPP_SAMPLING = {
    temperature: 0,
    max_tokens: 256,
    stop: ['\n\n', '\n', '<end_of_turn>', '<eos>'],
} as const;

/**
 * Model-card language names for MiLMMT-style canonical translation prompts.
 * The benchmark labels ("Chinese Simplified") differ from the names MiLMMT was
 * trained with ("Chinese (Simplified)"), so completion-mode prompts map them.
 */
const COMPLETION_LANGUAGE_NAME_MAP: Record<string, string> = {
    'Chinese Simplified': 'Chinese (Simplified)',
};

export type LlamaCppMode = 'chat' | 'completion';

export interface LlamaCppClientConfig {
    serverUrl: string;
    model: string;
    mode?: LlamaCppMode;
    requestTimeoutMs?: number;
}

type LlamaCppResponse = {
    choices?: Array<{
        text?: string;
        message?: {
            content?: string;
        };
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
};

function buildLlamaCppNormalizedError(
    rawMessage: string,
    requestTimeoutMs: number,
    options: {
        httpStatus?: number;
        retryAfterMs?: number;
    } = {},
): NormalizedClientError {
    const httpStatus = options.httpStatus ?? extractHttpStatus(rawMessage);
    const errorClass = classifyLlamaCppError(rawMessage, httpStatus);

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

function classifyLlamaCppError(rawMessage: string, httpStatus?: number): NormalizedClientErrorClass {
    const lower = rawMessage.toLowerCase();

    if (httpStatus === 429 || lower.includes('rate limit') || lower.includes('too many requests')) {
        return 'rate_limit';
    }

    if (httpStatus === 401 || httpStatus === 403 || lower.includes('unauthorized') || lower.includes('forbidden')) {
        return 'auth';
    }

    if (isDeterministicBadRequestStatus(httpStatus) || lower.includes('invalid request') || lower.includes('unsupported')) {
        return 'bad_request';
    }

    if (lower.includes('response did not contain') || lower.includes('response contained empty')) {
        return 'invalid_response';
    }

    if (httpStatus === 408 || lower.includes('timed out') || lower.includes('timeout')) {
        return 'timeout';
    }

    if (httpStatus === 500 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504
        || lower.includes('overload') || lower.includes('unavailable') || lower.includes('internal')) {
        return 'server_overload';
    }

    if (lower.includes('network') || lower.includes('socket') || lower.includes('econn')
        || lower.includes('fetch failed') || lower.includes('connection refused')) {
        return 'network';
    }

    return 'unknown';
}

export function normalizeLlamaCppError(error: unknown, requestTimeoutMs: number): NormalizedClientError {
    if (isNormalizedClientError(error)) {
        return error;
    }

    if (isAbortError(error)) {
        return buildLlamaCppNormalizedError(`llama.cpp request timed out after ${requestTimeoutMs}ms`, requestTimeoutMs);
    }

    return buildLlamaCppNormalizedError(getErrorMessage(error), requestTimeoutMs);
}

function extractLlamaCppContent(response: LlamaCppResponse): string {
    const choice = response.choices?.[0];
    const content = choice?.message?.content ?? choice?.text;

    if (typeof content === 'string' && content.trim().length > 0) {
        const trimmed = content.trim();

        if (trimmed === '<|channel>thought' || trimmed.startsWith('<|channel>')) {
            throw new Error(`llama.cpp response contained empty text (thought channel leaked: ${trimmed.slice(0, 80)})`);
        }

        return trimmed;
    }

    throw new Error('llama.cpp response contained empty text');
}

function mapCompletionLanguageName(languageName: string): string {
    return COMPLETION_LANGUAGE_NAME_MAP[languageName] ?? languageName;
}

export class LlamaCppClient implements LLMClient {
    private readonly serverUrl: string;
    private readonly mode: LlamaCppMode;

    constructor(private readonly config: LlamaCppClientConfig) {
        this.serverUrl = config.serverUrl.replace(/\/+$/, '');
        this.mode = config.mode ?? 'chat';
    }

    getModelName(): string {
        return this.config.model;
    }

    getProviderName(): string {
        return 'llamacpp';
    }

    getRequestTimeoutMs(): number {
        return this.config.requestTimeoutMs ?? DEFAULT_LLAMACPP_TIMEOUT_MS;
    }

    async translate(
        text: string,
        systemPrompt: string,
        sourceLang: string,
        targetLang: string,
    ): Promise<TranslationResult> {
        if (this.mode === 'completion') {
            return this.translateCompletion(text, systemPrompt, sourceLang, targetLang);
        }

        return this.translateChat(text, systemPrompt, sourceLang, targetLang);
    }

    private async translateChat(
        text: string,
        systemPrompt: string,
        sourceLang: string,
        targetLang: string,
    ): Promise<TranslationResult> {
        // Mirrors the Gemini client: the user message carries the full
        // serialized context+input block; the system prompt carries the policy.
        const userContent = text;
        const interpolatedPrompt = interpolatePrompt(
            systemPrompt,
            buildTranslationPromptVariables(userContent, sourceLang, targetLang),
        );

        const requestBody = {
            model: this.config.model,
            messages: [
                { role: 'system', content: interpolatedPrompt },
                { role: 'user', content: userContent },
            ],
            ...CHAT_LLAMACPP_SAMPLING,
            ...getLlamaCppTranslationRequestFields(),
        };

        return this.execute(`${this.serverUrl}/v1/chat/completions`, requestBody, 'translation');
    }

    private async translateCompletion(
        text: string,
        systemPrompt: string,
        sourceLang: string,
        targetLang: string,
    ): Promise<TranslationResult> {
        const parsed = parseContextModelInput(text);
        const currentSource = parsed?.currentSource ?? text;
        const contextTurns = parsed?.contextTurns ?? '';
        const mappedSourceName = mapCompletionLanguageName(sourceLang);
        const mappedTargetName = mapCompletionLanguageName(targetLang);
        const variables = {
            ...buildTranslationPromptVariables(currentSource, mappedSourceName, mappedTargetName),
            currentSource,
            contextTurns,
        };
        const prompt = interpolatePrompt(systemPrompt, variables);

        const requestBody = {
            model: this.config.model,
            prompt,
            ...COMPLETION_LLAMACPP_SAMPLING,
        };

        return this.execute(`${this.serverUrl}/v1/completions`, requestBody, 'translation');
    }

    private async execute(
        url: string,
        requestBody: Record<string, unknown>,
        phase: 'translation',
    ): Promise<TranslationResult> {
        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.getRequestTimeoutMs());

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw buildLlamaCppNormalizedError(
                    `llama.cpp API error ${response.status}: ${errorText}`,
                    this.getRequestTimeoutMs(),
                    {
                        httpStatus: response.status,
                        retryAfterMs: parseRetryAfterHeader(response.headers?.get('retry-after')),
                    },
                );
            }

            const data = await response.json() as LlamaCppResponse;
            const output = extractLlamaCppContent(data);
            const latencyMs = Date.now() - startTime;
            const usage = data.usage ?? {};

            return {
                output,
                latencyMs,
                usage: computeCallCost({
                    provider: 'llamacpp',
                    model: this.config.model,
                    phase,
                    inputTokens: usage.prompt_tokens ?? null,
                    outputTokens: usage.completion_tokens ?? null,
                    reasoningTokens: null,
                    latencyMs,
                }, '2026-08-14'),
            };
        } catch (error) {
            throw normalizeLlamaCppError(error, this.getRequestTimeoutMs());
        } finally {
            clearTimeout(timeoutId);
        }
    }
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
