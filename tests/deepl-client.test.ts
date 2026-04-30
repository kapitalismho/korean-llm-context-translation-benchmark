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

async function loadDeepLModule() {
    try {
        const modulePath = '../src/deepl.js';
        return await import(modulePath);
    } catch (error) {
        assert.fail(`DeepL client module missing: ${error instanceof Error ? error.message : String(error)}`);
    }
}

test('DeepLClient.translate parses a successful translation response', async () => {
    const { DeepLClient } = await loadDeepLModule();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse({
        translations: [{ text: ' Hello world ' }],
    }) as unknown as Response) as typeof fetch;

    try {
        const client = new DeepLClient('d-key', 'deepl-api', 'https://api.deepl.test/v2/translate', 50);
        const result = await client.translate('원문', 'ignored', 'Korean', 'en');

        assert.equal(result.output, 'Hello world');
        assert.equal(result.usage.inputTokens, null);
        assert.equal(result.usage.outputTokens, null);
        assert.equal(result.usage.costStatus, 'unknown');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DeepLClient.translate sends expected headers and language mappings', async () => {
    const { DeepLClient } = await loadDeepLModule();
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return createJsonResponse({
            translations: [{ text: '你好' }],
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new DeepLClient('d-key', 'deepl-api', 'https://api.deepl.test/v2/translate', 50);
        await client.translate('원문', 'ignored', 'Korean', 'zh-Hans');

        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://api.deepl.test/v2/translate');
        assert.deepEqual(calls[0].init?.headers, {
            Authorization: 'DeepL-Auth-Key d-key',
            'Content-Type': 'application/json',
        });

        const body = JSON.parse(String(calls[0].init?.body));
        assert.deepEqual(body, {
            text: ['원문'],
            source_lang: 'KO',
            target_lang: 'ZH-HANS',
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DeepLClient.translate extracts prior turns into the DeepL context parameter for context-aware benchmark inputs', async () => {
    const { DeepLClient } = await loadDeepLModule();
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return createJsonResponse({
            translations: [{ text: 'What time is it there?' }],
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new DeepLClient('d-key', 'deepl-api', 'https://api.deepl.test/v2/translate', 50);
        await client.translate(
            '<context>\n[other, 18s ago] 어 안녕\n[self, 6s ago] 지금 막 들어왔어\n</context>\n\n<input>\n거기 몇시야?\n</input>',
            'ignored',
            'Korean',
            'en',
        );

        const body = JSON.parse(String(calls[0].init?.body));
        assert.deepEqual(body, {
            text: ['거기 몇시야?'],
            context: '[other, 18s ago] 어 안녕\n[self, 6s ago] 지금 막 들어왔어',
            source_lang: 'KO',
            target_lang: 'EN',
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DeepLClient.translate keeps compatibility with legacy Text to translate context labels', async () => {
    const { DeepLClient } = await loadDeepLModule();
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return createJsonResponse({
            translations: [{ text: 'What time is it there?' }],
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new DeepLClient('d-key', 'deepl-api', 'https://api.deepl.test/v2/translate', 50);
        await client.translate(
            '<context>\n[other, 18s ago] 어 안녕\n[self, 6s ago] 지금 막 들어왔어\n</context>\n\nText to translate:\n거기 몇시야?',
            'ignored',
            'Korean',
            'en',
        );

        const body = JSON.parse(String(calls[0].init?.body));
        assert.deepEqual(body, {
            text: ['거기 몇시야?'],
            context: '[other, 18s ago] 어 안녕\n[self, 6s ago] 지금 막 들어왔어',
            source_lang: 'KO',
            target_lang: 'EN',
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DeepLClient.translate keeps compatibility with legacy Current input context labels', async () => {
    const { DeepLClient } = await loadDeepLModule();
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return createJsonResponse({
            translations: [{ text: 'What time is it there?' }],
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new DeepLClient('d-key', 'deepl-api', 'https://api.deepl.test/v2/translate', 50);
        await client.translate(
            '<context>\n[other, 18s ago] 어 안녕\n[self, 6s ago] 지금 막 들어왔어\n</context>\n\nCurrent input:\n거기 몇시야?',
            'ignored',
            'Korean',
            'en',
        );

        const body = JSON.parse(String(calls[0].init?.body));
        assert.deepEqual(body, {
            text: ['거기 몇시야?'],
            context: '[other, 18s ago] 어 안녕\n[self, 6s ago] 지금 막 들어왔어',
            source_lang: 'KO',
            target_lang: 'EN',
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DeepLClient exposes request timeout metadata', async () => {
    const { DeepLClient } = await loadDeepLModule();
    const client = new DeepLClient('d-key', 'deepl-api', 'https://api.deepl.test/v2/translate', 50);

    assert.equal(client.getRequestTimeoutMs(), 50);
});

test('DeepLClient auto-selects the Free API endpoint for :fx auth keys', async () => {
    const { DeepLClient } = await loadDeepLModule();
    const client = new DeepLClient('d-key:fx', 'deepl-api');

    assert.equal(client['endpoint'], 'https://api-free.deepl.com/v2/translate');
});

test('DeepLClient keeps the Pro API endpoint for non-Free auth keys', async () => {
    const { DeepLClient } = await loadDeepLModule();
    const client = new DeepLClient('d-key', 'deepl-api');

    assert.equal(client['endpoint'], 'https://api.deepl.com/v2/translate');
});

test('DeepLClient.translate maps deterministic request errors to bad_request', async () => {
    const { DeepLClient } = await loadDeepLModule();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse(
        { message: 'target_lang is invalid' },
        {
            ok: false,
            status: 400,
        },
    ) as unknown as Response) as typeof fetch;

    try {
        const client = new DeepLClient('d-key', 'deepl-api', 'https://api.deepl.test/v2/translate', 50);

        await assert.rejects(
            () => client.translate('원문', 'ignored', 'Korean', 'en'),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(normalized.errorClass, 'bad_request');
                assert.equal(normalized.retryable, false);
                assert.equal(normalized.httpStatus, 400);
                assert.equal(normalized.requestTimeoutMs, 50);
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DeepLClient.translate normalizes invalid response payloads', async () => {
    const { DeepLClient } = await loadDeepLModule();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse({
        translations: [],
    }) as unknown as Response) as typeof fetch;

    try {
        const client = new DeepLClient('d-key', 'deepl-api', 'https://api.deepl.test/v2/translate', 50);

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
