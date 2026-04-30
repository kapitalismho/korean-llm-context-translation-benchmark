import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { GeminiClient } from '../src/gemini.js';
import type { NormalizedClientError } from '../src/llm-client.js';

test('GeminiClient keeps participant Gemini on the Gemini API when Vertex env vars are set', () => {
    const originalUseVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI;
    const originalProject = process.env.GOOGLE_CLOUD_PROJECT;
    const originalLocation = process.env.GOOGLE_CLOUD_LOCATION;

    process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
    process.env.GOOGLE_CLOUD_PROJECT = 'demo-project';
    process.env.GOOGLE_CLOUD_LOCATION = 'us-central1';

    try {
        const client = new GeminiClient('fake-key');
        const ai = client['ai'];

        assert.equal(ai.vertexai, false);
        assert.equal(ai['apiClient'].isVertexAI(), false);
    } finally {
        restoreEnv('GOOGLE_GENAI_USE_VERTEXAI', originalUseVertex);
        restoreEnv('GOOGLE_CLOUD_PROJECT', originalProject);
        restoreEnv('GOOGLE_CLOUD_LOCATION', originalLocation);
    }
});

test('GeminiClient.translate applies minimal thinking config for gemini-3 translation calls', async () => {
  const client = new GeminiClient('fake-key', 'gemini-3-flash-preview');
  const ai = client['ai'];
  const originalGenerateContent = ai.models.generateContent;
  const japaneseRules = readFileSync(new URL('../data/prompt-rules/target-language/japanese.md', import.meta.url), 'utf8').trim();
  const koreanToJapaneseExamples = readFileSync(new URL('../data/prompt-examples/language-pair/korean-to-japanese.md', import.meta.url), 'utf8').trim();
  let capturedRequest: Record<string, any> | undefined;

  ai.models.generateContent = (async (request: Record<string, any>) => {
    capturedRequest = request;
        return {
            text: 'translated',
            usageMetadata: {
                promptTokenCount: 12,
                candidatesTokenCount: 4,
                thoughtsTokenCount: 2,
            },
        };
    }) as unknown as typeof ai.models.generateContent;

    try {
        const result = await client.translate('원문', 'System ${text}\n${targetLanguageRules}\n${translationExamples}', 'Korean', 'Japanese');

        assert.equal(result.output, 'translated');
        assert.equal(result.usage.inputTokens, 12);
        assert.equal(result.usage.outputTokens, 4);
        assert.equal(result.usage.reasoningTokens, 2);
        assert.equal(capturedRequest?.contents, '원문');
        assert.equal(capturedRequest?.config?.systemInstruction, [
            'System 원문',
            japaneseRules,
            koreanToJapaneseExamples,
        ].join('\n'));
        assert.deepEqual(capturedRequest?.config?.thinkingConfig, { thinkingLevel: 'minimal' });
    } finally {
        ai.models.generateContent = originalGenerateContent;
    }
});

test('GeminiClient exposes request timeout metadata', () => {
    const client = new GeminiClient('fake-key');

    assert.equal(client.getRequestTimeoutMs(), 30_000);
});

test('GeminiClient supports an explicit Vertex translation backend while keeping gemini provider identity', async () => {
    const client = new GeminiClient('', 'gemini-3-flash-preview', 30_000, {
        backend: 'vertex',
        project: 'demo-project',
        location: 'us-central1',
    });
    const ai = client['ai'];
    const originalGenerateContent = ai.models.generateContent;

    ai.models.generateContent = (async () => ({
        text: 'translated',
        usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 2,
        },
    })) as unknown as typeof ai.models.generateContent;

    try {
        const result = await client.translate('원문', 'System ${text}', 'Korean', 'Japanese');

        assert.equal(client.getProviderName(), 'gemini');
        assert.equal(ai.vertexai, true);
        assert.equal(ai['apiClient'].isVertexAI(), true);
        assert.equal(result.usage.provider, 'gemini');
        assert.equal(result.usage.model, 'gemini-3-flash-preview');
        assert.equal(result.usage.costStatus, 'estimated');
    } finally {
        ai.models.generateContent = originalGenerateContent;
    }
});

test('GeminiClient.translate throws a single-attempt normalized error', async () => {
    const client = new GeminiClient('fake-key', 'gemini-3-flash-preview');
    const ai = client['ai'];
    const originalGenerateContent = ai.models.generateContent;
    let calls = 0;

    ai.models.generateContent = (async () => {
        calls += 1;
        throw new Error('429 RESOURCE_EXHAUSTED: retry after 12 seconds');
    }) as unknown as typeof ai.models.generateContent;

    try {
        await assert.rejects(
            () => client.translate('원문', 'System ${text}', 'Korean', 'Japanese'),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(calls, 1);
                assert.equal(normalized.errorClass, 'rate_limit');
                assert.equal(normalized.retryable, true);
                assert.equal(normalized.retryAfterMs, 12_000);
                assert.equal(normalized.cooldownScope, 'throttle_bucket');
                assert.equal(normalized.requestTimeoutMs, 30_000);
                return true;
            },
        );
    } finally {
        ai.models.generateContent = originalGenerateContent;
    }
});

test('GeminiClient.translate maps deterministic 413 request errors to bad_request', async () => {
    const client = new GeminiClient('fake-key', 'gemini-3-flash-preview');
    const ai = client['ai'];
    const originalGenerateContent = ai.models.generateContent;

    ai.models.generateContent = (async () => {
        throw new Error('413 payload too large');
    }) as unknown as typeof ai.models.generateContent;

    try {
        await assert.rejects(
            () => client.translate('원문', 'System ${text}', 'Korean', 'Japanese'),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(normalized.errorClass, 'bad_request');
                assert.equal(normalized.retryable, false);
                assert.equal(normalized.httpStatus, 413);
                return true;
            },
        );
    } finally {
        ai.models.generateContent = originalGenerateContent;
    }
});

test('GeminiClient.translate enforces the configured SDK timeout', async () => {
    const client = new GeminiClient('fake-key', 'gemini-3-flash-preview', 5);
    const ai = client['ai'];
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
            () => client.translate('원문', 'System ${text}', 'Korean', 'Japanese'),
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

function restoreEnv(name: 'GOOGLE_GENAI_USE_VERTEXAI' | 'GOOGLE_CLOUD_PROJECT' | 'GOOGLE_CLOUD_LOCATION', value: string | undefined) {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}
