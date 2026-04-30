import assert from 'node:assert/strict';
import test from 'node:test';

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
            return typeof body === 'string' ? body : JSON.stringify(body);
        },
    };
}

async function loadGoogleTranslateBasicModule() {
    try {
        const modulePath = '../src/google-translate-basic.js';
        return await import(modulePath);
    } catch (error) {
        assert.fail(`Google Translate Basic client module missing: ${error instanceof Error ? error.message : String(error)}`);
    }
}

test('GoogleTranslateBasicClient.translate parses a successful translation response', async () => {
    const { GoogleTranslateBasicClient } = await loadGoogleTranslateBasicModule();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse({
        data: {
            translations: [{ translatedText: ' Hello world ' }],
        },
    }) as unknown as Response) as typeof fetch;

    try {
        const client = new GoogleTranslateBasicClient('gt-key', 'google-translate-basic', 'https://translation.test/language/translate/v2', 50);
        const result = await client.translate('원문', 'ignored', 'Korean', 'en');

        assert.equal(result.output, 'Hello world');
        assert.equal(result.usage.inputTokens, null);
        assert.equal(result.usage.outputTokens, null);
        assert.equal(result.usage.costStatus, 'unknown');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('GoogleTranslateBasicClient.translate sends expected query string and language mappings', async () => {
    const { GoogleTranslateBasicClient } = await loadGoogleTranslateBasicModule();
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return createJsonResponse({
            data: {
                translations: [{ translatedText: '你好' }],
            },
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new GoogleTranslateBasicClient('gt-key', 'google-translate-basic', 'https://translation.test/language/translate/v2', 50);
        await client.translate('원문', 'ignored', 'Korean', 'zh-Hans');

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://translation.test/language/translate/v2?key=gt-key');
        assert.equal(calls[0].init?.method, 'POST');
        assert.deepEqual(calls[0].init?.headers, {
            'Content-Type': 'application/json',
        });

        const body = JSON.parse(String(calls[0].init?.body));
        assert.deepEqual(body, {
            q: '원문',
            source: 'ko',
            target: 'zh-CN',
            format: 'text',
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('GoogleTranslateBasicClient exposes request timeout metadata', async () => {
    const { GoogleTranslateBasicClient } = await loadGoogleTranslateBasicModule();
    const client = new GoogleTranslateBasicClient('gt-key', 'google-translate-basic', 'https://translation.test/language/translate/v2', 50);

    assert.equal(client.getRequestTimeoutMs(), 50);
});

test('GoogleTranslateBasicClient.translate normalizes invalid response payloads', async () => {
    const { GoogleTranslateBasicClient } = await loadGoogleTranslateBasicModule();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse({
        data: {
            translations: [],
        },
    }) as unknown as Response) as typeof fetch;

    try {
        const client = new GoogleTranslateBasicClient('gt-key', 'google-translate-basic', 'https://translation.test/language/translate/v2', 50);

        await assert.rejects(
            () => client.translate('원문', 'ignored', 'Korean', 'ja'),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(normalized.errorClass, 'invalid_response');
                assert.equal(normalized.retryable, true);
                assert.equal(normalized.cooldownScope, 'item');
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('GoogleTranslateBasicClient.translate maps 429 responses to rate_limit', async () => {
    const { GoogleTranslateBasicClient } = await loadGoogleTranslateBasicModule();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse(
        { error: { message: 'Too Many Requests' } },
        {
            ok: false,
            status: 429,
            headers: {
                'retry-after': '12',
            },
        },
    ) as unknown as Response) as typeof fetch;

    try {
        const client = new GoogleTranslateBasicClient('gt-key', 'google-translate-basic', 'https://translation.test/language/translate/v2', 50);

        await assert.rejects(
            () => client.translate('원문', 'ignored', 'Korean', 'ja'),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(normalized.errorClass, 'rate_limit');
                assert.equal(normalized.retryable, true);
                assert.equal(normalized.httpStatus, 429);
                assert.equal(normalized.retryAfterMs, 12_000);
                assert.equal(normalized.cooldownScope, 'throttle_bucket');
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('GoogleTranslateBasicClient.translate maps 503 responses to server_overload', async () => {
    const { GoogleTranslateBasicClient } = await loadGoogleTranslateBasicModule();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse(
        { error: { message: 'backend unavailable' } },
        {
            ok: false,
            status: 503,
        },
    ) as unknown as Response) as typeof fetch;

    try {
        const client = new GoogleTranslateBasicClient('gt-key', 'google-translate-basic', 'https://translation.test/language/translate/v2', 50);

        await assert.rejects(
            () => client.translate('원문', 'ignored', 'Korean', 'ja'),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(normalized.errorClass, 'server_overload');
                assert.equal(normalized.retryable, true);
                assert.equal(normalized.httpStatus, 503);
                assert.equal(normalized.requestTimeoutMs, 50);
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});
