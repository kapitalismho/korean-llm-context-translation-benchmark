import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildVertexJudgeRequest,
    judgeWithRetries,
    resolveVertexJudgeConfig,
    VertexGembaJudge,
} from '../src/vertex-judge.js';
import type { NormalizedClientError } from '../src/llm-client.js';

const SENTENCE_TEMPLATE_VARIABLES = {
    source: '안녕하세요',
    sourceLang: 'Korean',
    targetLanguageCode: 'en',
    targetLanguageLabel: 'English',
    translation: 'Hello there',
};

test('resolveVertexJudgeConfig requires Vertex env vars', () => {
    assert.throws(() => resolveVertexJudgeConfig({}, 'gemini-2.5-flash'));
});

test('resolveVertexJudgeConfig routes gemini-3.1-pro-preview to global', () => {
    const config = resolveVertexJudgeConfig({
        GOOGLE_GENAI_USE_VERTEXAI: 'true',
        GOOGLE_CLOUD_PROJECT: 'demo-project',
        GOOGLE_CLOUD_LOCATION: 'us-central1',
    }, 'gemini-3.1-pro-preview');

    assert.equal(config.location, 'global');
});

test('buildVertexJudgeRequest uses structured JSON output', () => {
    const request = buildVertexJudgeRequest({
        model: 'gemini-2.5-flash',
        systemPrompt: 'judge prompt',
        fewShotMessages: [
            {
                role: 'user',
                parts: [{ text: 'example user' }],
            },
            {
                role: 'model',
                parts: [{ text: '{"has_no_error":true,"errors":[]}' }],
            },
        ],
        userPromptTemplate: '${sourceLang} source:\n```$\{source}```\n${targetLanguageLabel} translation:\n```$\{translation}```\n\nBased on the source segment and machine translation surrounded with triple backticks, identify error types in the translation and classify them.\n\nReturn the result as JSON with this structure:\n{}',
        responseSchema: { type: 'object' },
        templateVariables: SENTENCE_TEMPLATE_VARIABLES,
    });

    assert.equal(request.model, 'gemini-2.5-flash');
    assert.deepEqual(request.contents, [
        {
            role: 'user',
            parts: [
                {
                    text: 'example user',
                },
            ],
        },
        {
            role: 'model',
            parts: [
                {
                    text: '{"has_no_error":true,"errors":[]}',
                },
            ],
        },
        {
            role: 'user',
            parts: [
                {
                    text: 'Korean source:\n```안녕하세요```\nEnglish translation:\n```Hello there```\n\nBased on the source segment and machine translation surrounded with triple backticks, identify error types in the translation and classify them.\n\nReturn the result as JSON with this structure:\n{}',
                },
            ],
        },
    ]);
    assert.equal(request.config?.temperature, 0);
    assert.equal(request.config?.responseMimeType, 'application/json');
    assert.deepEqual((request.config as Record<string, unknown>)?.thinkingConfig, { thinkingBudget: -1 });
});

test('buildVertexJudgeRequest interpolates arbitrary template variables', () => {
    const request = buildVertexJudgeRequest({
        model: 'gemini-3.1-pro-preview',
        systemPrompt: 'You are a judge.',
        fewShotMessages: [],
        userPromptTemplate: 'Target language: ${targetLanguageLabel}\nContext (oldest to newest):\n${contextBlock}\n\nCurrent source:\n${currentSource}\n\nCandidate translation:\n${translation}',
        responseSchema: { type: 'object' },
        templateVariables: {
            targetLanguageLabel: 'English',
            contextBlock: '1. [other] 어 안녕',
            currentSource: '거기 몇시야?',
            translation: 'What time is it there?',
        },
    });

    assert.match(request.contents[0].parts[0].text, /Context \(oldest to newest\):/);
    assert.match(request.contents[0].parts[0].text, /1\. \[other\] 어 안녕/);
    assert.match(request.contents[0].parts[0].text, /What time is it there\?/);
});

test('buildVertexJudgeRequest throws when template variables are missing', () => {
    assert.throws(
        () => buildVertexJudgeRequest({
            model: 'gemini-2.5-flash',
            systemPrompt: 'judge prompt',
            fewShotMessages: [],
            userPromptTemplate: 'Current source:\n```$\{currentSource}```\nCandidate translation:\n```$\{translation}```',
            responseSchema: { type: 'object' },
            templateVariables: {
                currentSource: '안녕하세요',
            },
        }),
        /Missing template variables: translation/i,
    );
});

test('buildVertexJudgeRequest normalizes interpolated values for fenced prompt text', () => {
    const request = buildVertexJudgeRequest({
        model: 'gemini-2.5-flash',
        systemPrompt: 'judge prompt',
        fewShotMessages: [],
        userPromptTemplate: 'Context (oldest to newest):\n${contextBlock}\n\nCurrent source:\n```$\{currentSource}```\n\nCandidate translation:\n```$\{translation}```',
        responseSchema: { type: 'object' },
        templateVariables: {
            contextBlock: '1. [other] 모자 ``` 진짜 예쁘다.\r\n2. [self] 맞아',
            currentSource: '한번 ``` 써봐\r\n다시',
            translation: 'Try ``` it on',
        },
    });

    const promptText = request.contents[0].parts[0].text;
    assert.match(promptText, /1\. \[other\] 모자 ``\\` 진짜 예쁘다\.\n2\. \[self\] 맞아/);
    assert.match(promptText, /```한번 ``\\` 써봐\n다시```/);
    assert.match(promptText, /```Try ``\\` it on```/);
});

test('buildVertexJudgeRequest uses high thinking for prefixed gemini-3 models', () => {
    const request = buildVertexJudgeRequest({
        model: 'projects/demo/locations/us-central1/publishers/google/models/gemini-3-flash-preview',
        systemPrompt: 'judge prompt',
        fewShotMessages: [],
        userPromptTemplate: '${sourceLang} source:\n```$\{source}```\n${targetLanguageLabel} translation:\n```$\{translation}```',
        responseSchema: { type: 'object' },
        templateVariables: SENTENCE_TEMPLATE_VARIABLES,
    });

    assert.deepEqual((request.config as Record<string, unknown>)?.thinkingConfig, { thinkingLevel: 'high' });
});

test('buildVertexJudgeRequest uses high thinking for gemini-3.1-pro-preview', () => {
    const request = buildVertexJudgeRequest({
        model: 'gemini-3.1-pro-preview',
        systemPrompt: 'judge prompt',
        fewShotMessages: [],
        userPromptTemplate: '${sourceLang} source:\n```$\{source}```\n${targetLanguageLabel} translation:\n```$\{translation}```',
        responseSchema: { type: 'object' },
        templateVariables: SENTENCE_TEMPLATE_VARIABLES,
    });

    assert.deepEqual((request.config as Record<string, unknown>)?.thinkingConfig, { thinkingLevel: 'high' });
});

test('VertexGembaJudge.judge throws normalized single-attempt errors', async () => {
    const judge = new VertexGembaJudge({
        project: 'demo-project',
        location: 'global',
        model: 'gemini-2.5-flash',
    });
    const ai = judge['ai'];
    const originalGenerateContent = ai.models.generateContent;
    let calls = 0;

    ai.models.generateContent = (async () => {
        calls += 1;
        throw new Error('503 backend overloaded');
    }) as unknown as typeof ai.models.generateContent;

    try {
        await assert.rejects(
            () => judge.judge(buildVertexJudgeRequest({
                model: 'gemini-2.5-flash',
                systemPrompt: 'judge prompt',
                fewShotMessages: [],
                userPromptTemplate: '${sourceLang}: ${source}\n${targetLanguageLabel}: ${translation}',
                responseSchema: { type: 'object' },
                templateVariables: SENTENCE_TEMPLATE_VARIABLES,
            })),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(calls, 1);
                assert.equal(normalized.errorClass, 'server_overload');
                assert.equal(normalized.retryable, true);
                assert.equal(normalized.requestTimeoutMs, 90_000);
                return true;
            },
        );
    } finally {
        ai.models.generateContent = originalGenerateContent;
    }
});

test('VertexGembaJudge.judge maps deterministic 410 request errors to bad_request', async () => {
    const judge = new VertexGembaJudge({
        project: 'demo-project',
        location: 'global',
        model: 'gemini-2.5-flash',
    });
    const ai = judge['ai'];
    const originalGenerateContent = ai.models.generateContent;

    ai.models.generateContent = (async () => {
        throw new Error('410 gone');
    }) as unknown as typeof ai.models.generateContent;

    try {
        await assert.rejects(
            () => judge.judge(buildVertexJudgeRequest({
                model: 'gemini-2.5-flash',
                systemPrompt: 'judge prompt',
                fewShotMessages: [],
                userPromptTemplate: '${sourceLang}: ${source}\n${targetLanguageLabel}: ${translation}',
                responseSchema: { type: 'object' },
                templateVariables: SENTENCE_TEMPLATE_VARIABLES,
            })),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(normalized.errorClass, 'bad_request');
                assert.equal(normalized.retryable, false);
                assert.equal(normalized.httpStatus, 410);
                return true;
            },
        );
    } finally {
        ai.models.generateContent = originalGenerateContent;
    }
});

test('VertexGembaJudge.judge enforces the configured SDK timeout', async () => {
    const judge = new VertexGembaJudge({
        project: 'demo-project',
        location: 'global',
        model: 'gemini-2.5-flash',
        requestTimeoutMs: 5,
    });
    const ai = judge['ai'];
    const originalGenerateContent = ai.models.generateContent;
    let capturedRequest: Record<string, any> | undefined;

    ai.models.generateContent = (((request: Record<string, any>) => {
        capturedRequest = request;

        return new Promise((_, reject) => {
            const signal = request.config?.abortSignal as AbortSignal | undefined;
            signal?.addEventListener('abort', () => {
                const error = new Error('sdk aborted');
                (error as Error & { name: string }).name = 'AbortError';
                reject(error);
            }, { once: true });
        });
    }) as unknown as typeof ai.models.generateContent);

    try {
        await assert.rejects(
            () => judge.judge(buildVertexJudgeRequest({
                model: 'gemini-2.5-flash',
                systemPrompt: 'judge prompt',
                fewShotMessages: [],
                userPromptTemplate: '${sourceLang}: ${source}\n${targetLanguageLabel}: ${translation}',
                responseSchema: { type: 'object' },
                templateVariables: SENTENCE_TEMPLATE_VARIABLES,
            })),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(capturedRequest?.config?.httpOptions?.timeout, 5);
                assert.equal(typeof capturedRequest?.config?.abortSignal?.aborted, 'boolean');
                assert.equal(normalized.errorClass, 'timeout');
                assert.equal(normalized.retryable, true);
                assert.equal(normalized.requestTimeoutMs, 5);
                assert.match(normalized.rawMessage, /timed out after 5ms/i);
                return true;
            },
        );
    } finally {
        ai.models.generateContent = originalGenerateContent;
    }
});

test('judgeWithRetries retries retryable errors through the shared executor', async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await judgeWithRetries(
        {
            judge: async () => {
                attempts += 1;
                if (attempts < 3) {
                    throw new Error('429 retry after 7 seconds');
                }

                return {
                    rawText: '{"has_no_error":true,"errors":[]}',
                    usage: {
                        provider: 'vertex',
                        model: 'gemini-3.1-pro-preview',
                        phase: 'judge',
                        inputTokens: 10,
                        outputTokens: 5,
                        latencyMs: 1,
                        costStatus: 'estimated',
                        computedCostUsd: 0.01,
                    },
                };
            },
        },
        {} as ReturnType<typeof buildVertexJudgeRequest>,
        3,
        {
            random: () => 0.5,
            sleep: async (ms) => {
                delays.push(ms);
            },
        },
    );

    assert.equal(attempts, 3);
    assert.equal(result.ok, true);
    assert.equal(result.usage.inputTokens, 10);
    assert.deepEqual(delays, [7_000, 7_000]);
});

test('judgeWithRetries preserves the failure result contract after retry exhaustion', async () => {
    const delays: number[] = [];

    const result = await judgeWithRetries(
        {
            judge: async () => {
                throw new Error('400 invalid response schema');
            },
        },
        {
            model: 'gemini-2.5-flash',
        } as ReturnType<typeof buildVertexJudgeRequest>,
        2,
        {
            random: () => 0.5,
            sleep: async (ms) => {
                delays.push(ms);
            },
        },
    );

    assert.equal(result.ok, false);
    assert.match(result.rawText, /400 invalid response schema/);
    assert.equal(result.usage.provider, 'vertex');
    assert.equal(result.usage.model, 'gemini-2.5-flash');
    assert.equal(result.usage.phase, 'judge');
    assert.equal(result.usage.inputTokens, null);
    assert.equal(result.usage.outputTokens, null);
    assert.equal(result.usage.latencyMs, 0);
    assert.deepEqual(delays, []);
});
