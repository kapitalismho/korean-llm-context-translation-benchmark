import { GoogleGenAI } from '@google/genai';
import {
    extractHttpStatus,
    extractRetryAfterMs,
    getErrorMessage,
    isAbortError,
    isDeterministicBadRequestStatus,
    isNormalizedClientError,
    isRetryableErrorClass,
    type NormalizedClientError,
    type NormalizedClientErrorClass,
} from './llm-client.js';
import { getVertexJudgeThinkingConfig } from './reasoning-policy.js';
import {
    executeWithRetries,
    type ExecuteWithRetriesInput,
} from './retry-executor.js';
import { computeCallCost, type CallUsageMetrics } from './run-metrics.js';

const VERTEX_JUDGE_REQUEST_TIMEOUT_MS = 90_000;

function extractVertexProviderCode(rawMessage: string): string | undefined {
    const match = rawMessage.match(/\b(RESOURCE_EXHAUSTED|UNAUTHENTICATED|PERMISSION_DENIED|INVALID_ARGUMENT|NOT_FOUND|DEADLINE_EXCEEDED|UNAVAILABLE|INTERNAL)\b/i);
    return match?.[1]?.toUpperCase();
}

function classifyVertexJudgeError(rawMessage: string, httpStatus?: number): NormalizedClientErrorClass {
    const lower = rawMessage.toLowerCase();

    if (httpStatus === 429 || lower.includes('resource_exhausted') || lower.includes('rate limit') || lower.includes('quota')) {
        return 'rate_limit';
    }

    if (httpStatus === 401 || httpStatus === 403 || lower.includes('unauthenticated') || lower.includes('permission denied')) {
        return 'auth';
    }

    if (isDeterministicBadRequestStatus(httpStatus) || lower.includes('invalid argument') || lower.includes('invalid response schema') || lower.includes('unsupported')) {
        return 'bad_request';
    }

    if (lower.includes('response contained empty') || lower.includes('response did not contain') || lower.includes('invalid response')) {
        return 'invalid_response';
    }

    if (httpStatus === 408 || lower.includes('deadline exceeded') || lower.includes('timed out') || lower.includes('timeout')) {
        return 'timeout';
    }

    if (httpStatus === 500 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504 || lower.includes('unavailable') || lower.includes('overload') || lower.includes('internal')) {
        return 'server_overload';
    }

    if (lower.includes('network') || lower.includes('socket') || lower.includes('econn') || lower.includes('fetch failed')) {
        return 'network';
    }

    return 'unknown';
}

export function normalizeVertexJudgeError(
    error: unknown,
    requestTimeoutMs: number = VERTEX_JUDGE_REQUEST_TIMEOUT_MS,
): NormalizedClientError {
    if (isAbortError(error)) {
        return {
            errorClass: 'timeout',
            retryable: true,
            rawMessage: `Vertex judge request timed out after ${requestTimeoutMs}ms`,
            cooldownScope: 'item',
            requestTimeoutMs,
        };
    }

    if (isNormalizedClientError(error)) {
        return error;
    }

    const rawMessage = getErrorMessage(error);
    const httpStatus = extractHttpStatus(rawMessage);
    const errorClass = classifyVertexJudgeError(rawMessage, httpStatus);

    return {
        errorClass,
        retryable: isRetryableErrorClass(errorClass),
        rawMessage,
        httpStatus,
        providerCode: extractVertexProviderCode(rawMessage),
        retryAfterMs: extractRetryAfterMs(rawMessage),
        cooldownScope: errorClass === 'rate_limit'
            ? 'throttle_bucket'
            : errorClass === 'timeout' || errorClass === 'network' || errorClass === 'invalid_response'
                ? 'item'
                : 'none',
        requestTimeoutMs,
    };
}

export interface VertexJudgeConfig {
    project: string;
    location: string;
    model: string;
    requestTimeoutMs?: number;
}

export interface VertexJudgeRequestInput {
    model: string;
    systemPrompt: string;
    fewShotMessages: Array<{
        role: string;
        parts: Array<{ text: string }>;
    }>;
    userPromptTemplate: string;
    responseSchema: unknown;
    templateVariables: Record<string, string>;
}

const JUDGE_TEMPLATE_VARIABLE_PATTERN = /\$\{([^}]+)\}/g;

function normalizeTemplateVariableValue(value: string): string {
    return value
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/```/g, '``\\`');
}

function interpolateJudgeTemplate(template: string, values: Record<string, string>): string {
    const missingKeys = [...new Set(
        [...template.matchAll(JUDGE_TEMPLATE_VARIABLE_PATTERN)]
            .map((match) => match[1])
            .filter((key) => !(key in values)),
    )];

    if (missingKeys.length > 0) {
        throw new Error(`Missing template variables: ${missingKeys.join(', ')}`);
    }

    return template.replace(JUDGE_TEMPLATE_VARIABLE_PATTERN, (_match, key) => {
        return normalizeTemplateVariableValue(values[key]);
    });
}

export function resolveVertexJudgeConfig(
    env: Record<string, string | undefined>,
    model: string,
): VertexJudgeConfig {
    if (env.GOOGLE_GENAI_USE_VERTEXAI !== 'true') {
        throw new Error('GOOGLE_GENAI_USE_VERTEXAI must be set to true.');
    }

    const project = env.GOOGLE_CLOUD_PROJECT;
    if (!project) {
        throw new Error('GOOGLE_CLOUD_PROJECT is required.');
    }

    const location = env.GOOGLE_CLOUD_LOCATION;
    if (!location) {
        throw new Error('GOOGLE_CLOUD_LOCATION is required.');
    }

    const effectiveLocation = model === 'gemini-3.1-pro-preview'
        || model === 'gemini-3.1-pro-preview-customtools'
        ? 'global'
        : location;

    return {
        project,
        location: effectiveLocation,
        model,
    };
}

export function buildVertexJudgeRequest(input: VertexJudgeRequestInput) {
    const userPrompt = interpolateJudgeTemplate(input.userPromptTemplate, input.templateVariables);

    return {
        model: input.model,
        contents: [
            ...input.fewShotMessages,
            {
                role: 'user',
                parts: [
                    {
                        text: userPrompt,
                    },
                ],
            },
        ],
        config: {
            temperature: 0,
            systemInstruction: input.systemPrompt,
            responseMimeType: 'application/json',
            responseJsonSchema: input.responseSchema,
            thinkingConfig: getVertexJudgeThinkingConfig(input.model) as any,
        },
    };
}

export interface JudgeResult {
    rawText: string;
    usage: CallUsageMetrics;
}

export class VertexGembaJudge {
    private ai: GoogleGenAI;

    constructor(private readonly config: VertexJudgeConfig) {
        this.ai = new GoogleGenAI({
            vertexai: true,
            project: config.project,
            location: config.location,
            apiVersion: 'v1',
        });
    }

    private getRequestTimeoutMs(): number {
        return this.config.requestTimeoutMs ?? VERTEX_JUDGE_REQUEST_TIMEOUT_MS;
    }

    async preflight(): Promise<void> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, this.getRequestTimeoutMs());

        try {
            await this.ai.models.generateContent({
                model: this.config.model,
                contents: 'Return {"ok":true}',
                config: {
                    temperature: 0,
                    responseMimeType: 'application/json',
                    responseJsonSchema: {
                        type: 'object',
                        properties: {
                            ok: {
                                type: 'boolean',
                            },
                        },
                        required: ['ok'],
                    },
                    abortSignal: controller.signal,
                    httpOptions: {
                        timeout: this.getRequestTimeoutMs(),
                    },
                },
            });
        } catch (error) {
            throw normalizeVertexJudgeError(error, this.getRequestTimeoutMs());
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async judge(request: ReturnType<typeof buildVertexJudgeRequest>): Promise<JudgeResult> {
        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, this.getRequestTimeoutMs());
        const requestConfig = request.config as Record<string, unknown> | undefined;

        try {
            const response = await this.ai.models.generateContent({
                ...request,
                config: {
                    ...(requestConfig ?? {}),
                    abortSignal: controller.signal,
                    httpOptions: {
                        ...((requestConfig?.httpOptions as Record<string, unknown> | undefined) ?? {}),
                        timeout: this.getRequestTimeoutMs(),
                    },
                },
            });
            const rawText = (response.text ?? '').trim();
            if (!rawText) {
                throw new Error('Vertex judge response contained empty text');
            }

            const latencyMs = Date.now() - startTime;
            const usageMetadata = (response as Record<string, any>).usageMetadata ?? {};

            return {
                rawText,
                usage: computeCallCost({
                    provider: 'vertex',
                    model: this.config.model,
                    phase: 'judge',
                    inputTokens: usageMetadata.promptTokenCount ?? null,
                    outputTokens: usageMetadata.candidatesTokenCount ?? null,
                    reasoningTokens: usageMetadata.thoughtsTokenCount ?? null,
                    latencyMs,
                }, '2026-04-17'),
            };
        } catch (error) {
            throw normalizeVertexJudgeError(error, this.getRequestTimeoutMs());
        } finally {
            clearTimeout(timeoutId);
        }
    }
}

export type JudgeRetryExecutorOptions = Pick<ExecuteWithRetriesInput<JudgeResult>, 'now' | 'random' | 'sleep' | 'onFailure'>;

type RetryableJudge = {
    judge(request: ReturnType<typeof buildVertexJudgeRequest>): Promise<JudgeResult>;
    buildFailureUsage?: (
        request: ReturnType<typeof buildVertexJudgeRequest>,
        error: NormalizedClientError,
    ) => CallUsageMetrics;
};

export async function judgeWithRetries(
    judge: RetryableJudge,
    request: ReturnType<typeof buildVertexJudgeRequest>,
    maxAttempts: number = 4,
    retryOptions: JudgeRetryExecutorOptions = {},
) {
    try {
        const result = await executeWithRetries({
            maxAttempts,
            operation: () => judge.judge(request),
            classify: normalizeVertexJudgeError,
            ...retryOptions,
        });

        return {
            ok: true,
            ...result,
        };
    } catch (error) {
        const normalized = normalizeVertexJudgeError(error);

        return {
            ok: false,
            rawText: normalized.rawMessage,
            usage: judge.buildFailureUsage?.(request, normalized) ?? computeCallCost({
                provider: 'vertex',
                model: request.model,
                phase: 'judge',
                inputTokens: null,
                outputTokens: null,
                latencyMs: 0,
            }, '2026-04-17'),
        };
    }
}
