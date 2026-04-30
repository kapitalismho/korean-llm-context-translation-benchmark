import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
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
import { getGeminiTranslationThinkingConfig } from './reasoning-policy.js';
import { computeCallCost } from './run-metrics.js';

// Re-export for backward compatibility
export type { TranslationResult } from './llm-client.js';

// Supported languages for translation
export const SUPPORTED_LANGUAGES = ['Korean', 'Japanese', 'English', 'Chinese Simplified'];

const GEMINI_REQUEST_TIMEOUT_MS = 30_000;

export type GeminiTranslationBackend = 'api' | 'vertex';

export interface GeminiClientConfig {
    backend?: GeminiTranslationBackend;
    project?: string;
    location?: string;
}

function extractGeminiProviderCode(rawMessage: string): string | undefined {
    const match = rawMessage.match(/\b(RESOURCE_EXHAUSTED|UNAUTHENTICATED|PERMISSION_DENIED|INVALID_ARGUMENT|NOT_FOUND|DEADLINE_EXCEEDED|UNAVAILABLE|INTERNAL)\b/i);
    return match?.[1]?.toUpperCase();
}

function classifyGeminiError(rawMessage: string, httpStatus?: number): NormalizedClientErrorClass {
    const lower = rawMessage.toLowerCase();

    if (httpStatus === 429 || lower.includes('resource_exhausted') || lower.includes('rate limit') || lower.includes('quota')) {
        return 'rate_limit';
    }

    if (httpStatus === 401 || httpStatus === 403 || lower.includes('unauthenticated') || lower.includes('permission denied') || lower.includes('api key')) {
        return 'auth';
    }

    if (isDeterministicBadRequestStatus(httpStatus) || lower.includes('invalid argument') || lower.includes('model not found') || lower.includes('unsupported')) {
        return 'bad_request';
    }

    if (lower.includes('response contained empty') || lower.includes('response did not contain') || lower.includes('invalid response')) {
        return 'invalid_response';
    }

    if (httpStatus === 408 || lower.includes('deadline exceeded') || lower.includes('timeout') || lower.includes('timed out')) {
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

export function normalizeGeminiError(
    error: unknown,
    requestTimeoutMs: number = GEMINI_REQUEST_TIMEOUT_MS,
): NormalizedClientError {
    if (isAbortError(error)) {
        return {
            errorClass: 'timeout',
            retryable: true,
            rawMessage: `Gemini request timed out after ${requestTimeoutMs}ms`,
            cooldownScope: 'item',
            requestTimeoutMs,
        };
    }

    if (isNormalizedClientError(error)) {
        return error;
    }

    const rawMessage = getErrorMessage(error);
    const httpStatus = extractHttpStatus(rawMessage);
    const errorClass = classifyGeminiError(rawMessage, httpStatus);

    return {
        errorClass,
        retryable: isRetryableErrorClass(errorClass),
        rawMessage,
        httpStatus,
        providerCode: extractGeminiProviderCode(rawMessage),
        retryAfterMs: extractRetryAfterMs(rawMessage),
        cooldownScope: errorClass === 'rate_limit'
            ? 'throttle_bucket'
            : errorClass === 'timeout' || errorClass === 'network' || errorClass === 'invalid_response'
                ? 'item'
                : 'none',
        requestTimeoutMs,
    };
}

/**
 * Interpolate prompt template with actual values
 * Replaces ${variable} placeholders with corresponding values
 */
export function interpolatePrompt(
    template: string,
    variables: Record<string, string>
): string {
    return template.replace(/\$\{(\w+)\}/g, (match, key) => {
        return variables[key] !== undefined ? variables[key] : match;
    });
}

const TARGET_LANGUAGE_RULES_BASE_URL = new URL('../data/prompt-rules/target-language/', import.meta.url);
const TRANSLATION_EXAMPLES_BASE_URL = new URL('../data/prompt-examples/language-pair/', import.meta.url);

function readTargetLanguageRulesFile(fileName: string): string {
    return readFileSync(new URL(fileName, TARGET_LANGUAGE_RULES_BASE_URL), 'utf8').trim();
}

const TARGET_LANGUAGE_RULES = {
    chinese: readTargetLanguageRulesFile('chinese.md'),
    japanese: readTargetLanguageRulesFile('japanese.md'),
    english: readTargetLanguageRulesFile('english.md'),
    korean: readTargetLanguageRulesFile('korean.md'),
} as const;

function readTranslationExamplesFile(fileName: string): string {
    return readFileSync(new URL(fileName, TRANSLATION_EXAMPLES_BASE_URL), 'utf8').trim();
}

const TRANSLATION_EXAMPLES: Record<string, string> = Object.fromEntries([
    'korean-to-english',
    'korean-to-japanese',
    'korean-to-chinese-simplified',
    'chinese-simplified-to-korean',
    'chinese-simplified-to-english',
    'chinese-simplified-to-japanese',
    'japanese-to-korean',
    'japanese-to-english',
    'japanese-to-chinese-simplified',
    'english-to-korean',
    'english-to-japanese',
    'english-to-chinese-simplified',
].map((pairKey) => [pairKey, readTranslationExamplesFile(`${pairKey}.md`)]));

const FALLBACK_TRANSLATION_EXAMPLES = readTranslationExamplesFile('fallback.md');

function getTranslationExampleLanguageSlug(languageName: string): string | undefined {
    const normalizedLanguageName = languageName.trim().toLowerCase();

    if (normalizedLanguageName === 'korean') {
        return 'korean';
    }

    if (normalizedLanguageName === 'english') {
        return 'english';
    }

    if (normalizedLanguageName === 'japanese') {
        return 'japanese';
    }

    if (normalizedLanguageName === 'chinese simplified' || normalizedLanguageName === 'zh-hans') {
        return 'chinese-simplified';
    }

    return undefined;
}

export function getTargetLanguageRules(targetName: string): string {
    const normalizedTargetName = targetName.trim().toLowerCase();

    if (normalizedTargetName.startsWith('chinese')) {
        return TARGET_LANGUAGE_RULES.chinese;
    }

    if (normalizedTargetName === 'japanese') {
        return TARGET_LANGUAGE_RULES.japanese;
    }

    if (normalizedTargetName === 'english') {
        return TARGET_LANGUAGE_RULES.english;
    }

    if (normalizedTargetName === 'korean') {
        return TARGET_LANGUAGE_RULES.korean;
    }

    return '';
}

export function getTranslationExamples(sourceName: string, targetName: string): string {
    const sourceSlug = getTranslationExampleLanguageSlug(sourceName);
    const targetSlug = getTranslationExampleLanguageSlug(targetName);

    if (sourceSlug !== undefined && targetSlug !== undefined) {
        const exactExamples = TRANSLATION_EXAMPLES[`${sourceSlug}-to-${targetSlug}`];

        if (exactExamples !== undefined) {
            return exactExamples;
        }
    }

    if (targetSlug === 'english') {
        return FALLBACK_TRANSLATION_EXAMPLES;
    }

    return '';
}

export function buildTranslationPromptVariables(
    text: string,
    sourceName: string,
    targetName: string,
): Record<string, string> {
    return {
        sourceName,
        targetName,
        text,
        supported_languages: SUPPORTED_LANGUAGES.join(', '),
        targetLanguageRules: getTargetLanguageRules(targetName),
        translationExamples: getTranslationExamples(sourceName, targetName),
    };
}

export class GeminiClient implements LLMClient {
    private ai: GoogleGenAI;
    private modelName: string;
    private requestTimeoutMs: number;

    constructor(
        apiKey: string,
        modelName: string = 'gemini-3-flash-preview',
        requestTimeoutMs: number = GEMINI_REQUEST_TIMEOUT_MS,
        config: GeminiClientConfig = {},
    ) {
        if (config.backend === 'vertex') {
            if (!config.project) {
                throw new Error('GOOGLE_CLOUD_PROJECT is required for Vertex Gemini translation backend.');
            }

            if (!config.location) {
                throw new Error('GOOGLE_CLOUD_LOCATION is required for Vertex Gemini translation backend.');
            }

            this.ai = new GoogleGenAI({
                vertexai: true,
                project: config.project,
                location: config.location,
                apiVersion: 'v1',
            });
        } else {
            this.ai = new GoogleGenAI({ apiKey, vertexai: false });
        }

        this.modelName = modelName;
        this.requestTimeoutMs = requestTimeoutMs;
    }

    getModelName(): string {
        return this.modelName;
    }

    getProviderName(): string {
        return 'gemini';
    }

    getRequestTimeoutMs(): number {
        return this.requestTimeoutMs;
    }

    async translate(
        text: string,
        systemPrompt: string,
        sourceLang: string,
        targetLang: string
    ): Promise<TranslationResult> {
        // Interpolate variables in the system prompt
        const interpolatedPrompt = interpolatePrompt(systemPrompt, buildTranslationPromptVariables(text, sourceLang, targetLang));

        const startTime = Date.now();
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, this.getRequestTimeoutMs());

        try {
            const response = await this.ai.models.generateContent({
                model: this.modelName,
                contents: text,
                config: {
                    systemInstruction: interpolatedPrompt,
                    thinkingConfig: getGeminiTranslationThinkingConfig(this.modelName) as any,
                    abortSignal: controller.signal,
                    httpOptions: {
                        timeout: this.getRequestTimeoutMs(),
                    },
                },
            });

            const output = (response.text ?? '').trim();
            if (!output) {
                throw new Error('Gemini response contained empty text');
            }

            const latencyMs = Date.now() - startTime;
            const usageMetadata = (response as Record<string, any>).usageMetadata ?? {};

            return {
                output,
                latencyMs,
                usage: computeCallCost({
                    provider: 'gemini',
                    model: this.modelName,
                    phase: 'translation',
                    inputTokens: usageMetadata.promptTokenCount ?? null,
                    outputTokens: usageMetadata.candidatesTokenCount ?? null,
                    reasoningTokens: usageMetadata.thoughtsTokenCount ?? null,
                    latencyMs,
                }, '2026-04-17'),
            };
        } catch (error) {
            throw normalizeGeminiError(error, this.getRequestTimeoutMs());
        } finally {
            clearTimeout(timeoutId);
        }
    }
}
