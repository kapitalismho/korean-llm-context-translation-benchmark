import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DeepSeekClient, extractDeepSeekContent } from '../src/deepseek.js';
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

test('extractDeepSeekContent handles array payloads', () => {
    assert.equal(
        extractDeepSeekContent([{ text: ' 첫째 줄 ' }, { text: '둘째 줄' }]),
        '첫째 줄\n둘째 줄',
    );
});

test('DeepSeekClient.translate sends official API request and records usage', async () => {
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
                prompt_tokens: 1000,
                completion_tokens: 200,
                reasoning_tokens: 7,
            },
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new DeepSeekClient('d-key', 'deepseek-v4-flash', 'https://deepseek.test', 75);
        const result = await client.translate('원문', 'System ${sourceName} -> ${targetName}: ${text}\n${targetLanguageRules}\n${translationExamples}', 'Korean', 'Japanese');

        assert.equal(client.getProviderName(), 'deepseek');
        assert.equal(client.getRequestTimeoutMs(), 75);
        assert.equal(result.output, '번역 결과');
        assert.equal(result.usage.inputTokens, 1000);
        assert.equal(result.usage.outputTokens, 200);
        assert.equal(result.usage.reasoningTokens, 7);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://deepseek.test/chat/completions');
        assert.deepEqual(calls[0].init?.headers, {
            Authorization: 'Bearer d-key',
            'Content-Type': 'application/json',
        });

        const body = JSON.parse(String(calls[0].init?.body));
        assert.equal(body.model, 'deepseek-v4-flash');
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
        assert.deepEqual(body.thinking, { type: 'disabled' });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DeepSeekClient.translate trims trailing slash from custom base URL', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return createJsonResponse({
            choices: [
                {
                    message: {
                        content: '번역 결과',
                    },
                },
            ],
            usage: {},
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new DeepSeekClient('d-key', 'deepseek-v4-flash', 'https://deepseek.test/', 75);
        await client.translate('원문', 'System ${text}', 'Korean', 'Japanese');

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://deepseek.test/chat/completions');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DeepSeekClient.translate does not duplicate chat completions endpoint in custom base URL', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return createJsonResponse({
            choices: [
                {
                    message: {
                        content: '번역 결과',
                    },
                },
            ],
            usage: {},
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new DeepSeekClient('d-key', 'deepseek-v4-flash', 'https://deepseek.test/chat/completions', 75);
        await client.translate('원문', 'System ${text}', 'Korean', 'Japanese');

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://deepseek.test/chat/completions');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DeepSeekClient.translate preserves official 429 error metadata', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;

    globalThis.fetch = (async () => {
        calls += 1;
        return createJsonResponse(
            { error: { code: 'rate_limit_exceeded', message: 'Too many requests' } },
            {
                ok: false,
                status: 429,
                headers: {
                    'retry-after': '12',
                },
            },
        ) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new DeepSeekClient('d-key', 'deepseek-v4-flash', 'https://deepseek.test', 75);

        await assert.rejects(
            () => client.translate('원문', 'System ${text}', 'Korean', 'Japanese'),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(calls, 1);
                assert.equal(normalized.errorClass, 'rate_limit');
                assert.equal(normalized.retryable, true);
                assert.equal(normalized.httpStatus, 429);
                assert.equal(normalized.retryAfterMs, 12_000);
                assert.equal(normalized.providerCode, 'rate_limit_exceeded');
                assert.equal(normalized.cooldownScope, 'throttle_bucket');
                assert.equal(normalized.requestTimeoutMs, 75);
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DeepSeekClient.translate maps insufficient balance 402 errors to auth', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse(
        { error: { code: 'insufficient_balance', message: 'Insufficient Balance' } },
        {
            ok: false,
            status: 402,
        },
    ) as unknown as Response) as typeof fetch;

    try {
        const client = new DeepSeekClient('d-key', 'deepseek-v4-flash', 'https://deepseek.test', 75);

        await assert.rejects(
            () => client.translate('원문', 'System ${text}', 'Korean', 'Japanese'),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(normalized.errorClass, 'auth');
                assert.equal(normalized.retryable, false);
                assert.equal(normalized.httpStatus, 402);
                assert.equal(normalized.providerCode, 'insufficient_balance');
                assert.equal(normalized.cooldownScope, 'none');
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DeepSeekClient.translate maps deterministic request errors to bad_request', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse(
        { error: { code: 'invalid_request_error', message: 'Invalid request' } },
        {
            ok: false,
            status: 400,
        },
    ) as unknown as Response) as typeof fetch;

    try {
        const client = new DeepSeekClient('d-key', 'deepseek-v4-flash', 'https://deepseek.test', 75);

        await assert.rejects(
            () => client.translate('원문', 'System ${text}', 'Korean', 'Japanese'),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(normalized.errorClass, 'bad_request');
                assert.equal(normalized.retryable, false);
                assert.equal(normalized.httpStatus, 400);
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});
