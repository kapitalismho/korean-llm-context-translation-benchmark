import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { QwenClient } from '../src/qwen.js';
import type { NormalizedClientError } from '../src/llm-client.js';

type MockJsonResponse = {
    ok: boolean;
    status: number;
    headers?: {
        get(name: string): string | null;
    };
    json(): Promise<unknown>;
    text(): Promise<string>;
};

function createJsonResponse(
    body: unknown,
    init: {
        ok?: boolean;
        status?: number;
        headers?: Record<string, string>;
    } = {},
): MockJsonResponse {
    const headers = new Map(
        Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );

    return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        headers: {
            get(name: string) {
                return headers.get(name.toLowerCase()) ?? null;
            },
        },
        async json() {
            return body;
        },
        async text() {
            return JSON.stringify(body);
        },
    };
}

test('QwenClient.translate sends enable_thinking false in the request body', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];
    const japaneseRules = readFileSync(new URL('../data/prompt-rules/target-language/japanese.md', import.meta.url), 'utf8').trim();
    const koreanToJapaneseExamples = readFileSync(new URL('../data/prompt-examples/language-pair/korean-to-japanese.md', import.meta.url), 'utf8').trim();

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return createJsonResponse({
            choices: [
                {
                    message: {
                        content: ' 번역 결과 ',
                    },
                },
            ],
            usage: {
                prompt_tokens: 11,
                completion_tokens: 5,
                reasoning_tokens: 0,
            },
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new QwenClient('q-key', 'qwen3.5-flash', 'https://dashscope.test/v1', 50);
        const result = await client.translate('원문', 'System ${sourceName} -> ${targetName}: ${text}\n${targetLanguageRules}\n${translationExamples}', 'Korean', 'Japanese');

        assert.equal(result.output, '번역 결과');
        assert.equal(calls.length, 1);

        const body = JSON.parse(String(calls[0].init?.body));
        assert.equal(body.model, 'qwen3.5-flash');
        assert.deepEqual(body.messages, [
            {
                role: 'system',
                content: [
                    'System Korean -> Japanese: 원문',
                    japaneseRules,
                    koreanToJapaneseExamples,
                ].join('\n'),
            },
            {
                role: 'user',
                content: '원문',
            },
        ]);
        assert.equal(body.enable_thinking, false);
        assert.equal(result.usage.inputTokens, 11);
        assert.equal(result.usage.outputTokens, 5);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('QwenClient exposes request timeout metadata', () => {
    const client = new QwenClient('q-key', 'qwen3.5-flash', 'https://dashscope.test/v1', 50);

    assert.equal(client.getRequestTimeoutMs(), 50);
});

test('QwenClient.translate throws a single-attempt normalized error', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;

    globalThis.fetch = (async () => {
        calls += 1;
        return createJsonResponse(
            { error: { code: 'rate_limit_exceeded' } },
            {
                ok: false,
                status: 429,
                headers: {
                    'retry-after': '15',
                },
            },
        ) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new QwenClient('q-key', 'qwen3.5-flash', 'https://dashscope.test/v1', 50);

        await assert.rejects(
            () => client.translate('원문', 'System ${text}', 'Korean', 'Japanese'),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(calls, 1);
                assert.equal(normalized.errorClass, 'rate_limit');
                assert.equal(normalized.retryable, true);
                assert.equal(normalized.httpStatus, 429);
                assert.equal(normalized.retryAfterMs, 15_000);
                assert.equal(normalized.cooldownScope, 'throttle_bucket');
                assert.equal(normalized.requestTimeoutMs, 50);
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('QwenClient.translate maps deterministic 415 request errors to bad_request', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse(
        { error: { code: 'unsupported_media_type' } },
        {
            ok: false,
            status: 415,
        },
    ) as unknown as Response) as typeof fetch;

    try {
        const client = new QwenClient('q-key', 'qwen3.5-flash', 'https://dashscope.test/v1', 50);

        await assert.rejects(
            () => client.translate('원문', 'System ${text}', 'Korean', 'Japanese'),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(normalized.errorClass, 'bad_request');
                assert.equal(normalized.retryable, false);
                assert.equal(normalized.httpStatus, 415);
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});
