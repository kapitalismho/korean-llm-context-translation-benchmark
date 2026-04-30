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

async function loadGoogleWebModule() {
    try {
        const modulePath = '../src/google-web.js';
        return await import(modulePath);
    } catch (error) {
        assert.fail(`Google web client module missing: ${error instanceof Error ? error.message : String(error)}`);
    }
}

test('GoogleWebClient.translate parses array-based translation responses', async () => {
    const { GoogleWebClient } = await loadGoogleWebModule();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse([
        [
            ['Hello ', '원문'],
            ['world', '추가'],
        ],
        null,
        'ko',
    ]) as unknown as Response) as typeof fetch;

    try {
        const client = new GoogleWebClient('google-translate-web', 'https://translate.test/translate_a/single', 50);
        const result = await client.translate('원문', 'ignored', 'Korean', 'en');

        assert.equal(result.output, 'Hello world');
        assert.equal(result.usage.inputTokens, null);
        assert.equal(result.usage.outputTokens, null);
        assert.equal(result.usage.costStatus, 'unknown');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('GoogleWebClient.translate sends expected form body and language mappings', async () => {
    const { GoogleWebClient } = await loadGoogleWebModule();
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return createJsonResponse({
            sentences: [{ trans: '你好' }],
            src: 'ko',
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new GoogleWebClient('google-translate-web', 'https://translate.test/translate_a/single', 50);
        await client.translate('원문', 'ignored', 'Korean', 'zh-Hans');

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://translate.test/translate_a/single?client=gtx&dj=1&dt=t');
        assert.equal(calls[0].init?.method, 'POST');
        assert.deepEqual(calls[0].init?.headers, {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        });

        const body = new URLSearchParams(String(calls[0].init?.body));
        assert.equal(body.get('sl'), 'ko');
        assert.equal(body.get('tl'), 'zh-CN');
        assert.equal(body.get('q'), '원문');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('GoogleWebClient exposes request timeout metadata', async () => {
    const { GoogleWebClient } = await loadGoogleWebModule();
    const client = new GoogleWebClient('google-translate-web', 'https://translate.test/translate_a/single', 50);

    assert.equal(client.getRequestTimeoutMs(), 50);
});

test('GoogleWebClient.translate normalizes invalid response payloads', async () => {
    const { GoogleWebClient } = await loadGoogleWebModule();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse({
        sentences: [],
    }) as unknown as Response) as typeof fetch;

    try {
        const client = new GoogleWebClient('google-translate-web', 'https://translate.test/translate_a/single', 50);

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

test('GoogleWebClient.translate maps 429 responses to rate_limit', async () => {
    const { GoogleWebClient } = await loadGoogleWebModule();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse(
        'Too Many Requests',
        {
            ok: false,
            status: 429,
            headers: {
                'retry-after': '12',
            },
        },
    ) as unknown as Response) as typeof fetch;

    try {
        const client = new GoogleWebClient('google-translate-web', 'https://translate.test/translate_a/single', 50);

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
