import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { OpenRouterClient, extractOpenRouterContent, getOpenRouterApiKey } from '../src/openrouter.js';
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

test('extractOpenRouterContent handles string payloads', () => {
    assert.equal(extractOpenRouterContent(' translated '), 'translated');
});

test('extractOpenRouterContent rejects whitespace-only string payloads', () => {
    assert.throws(
        () => extractOpenRouterContent('   '),
        /OpenRouter response contained empty message content/
    );
});

test('extractOpenRouterContent handles array payloads', () => {
    assert.equal(
        extractOpenRouterContent([{ text: '한 줄' }, { text: '두 줄' }]),
        '한 줄\n두 줄'
    );
});

test('getOpenRouterApiKey reads OPENROUTER_API_KEY from env object', () => {
    assert.equal(getOpenRouterApiKey({ OPENROUTER_API_KEY: 'key-123' }), 'key-123');
});

test('OpenRouterClient.translate sends expected request and parses response', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];
    const chineseRules = readFileSync(new URL('../data/prompt-rules/target-language/chinese.md', import.meta.url), 'utf8').trim();

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return createJsonResponse({
            choices: [
                {
                    message: {
                        content: [{ text: ' 첫째 줄 ' }, { text: '둘째 줄' }],
                    },
                },
            ],
            usage: {
                prompt_tokens: 13,
                completion_tokens: 6,
                reasoning_tokens: 0,
            },
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new OpenRouterClient('o-key', 'google/gemma-4-26b-a4b-it', 'https://openrouter.test/chat/completions', 50);
        const result = await client.translate('원문', 'System ${sourceName} -> ${targetName}: ${text}\n${targetLanguageRules}\nExamples:${translationExamples}', 'Korean', 'Chinese Traditional');

        assert.equal(result.output, '첫째 줄\n둘째 줄');
        assert.equal(result.usage.inputTokens, 13);
        assert.equal(result.usage.outputTokens, 6);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://openrouter.test/chat/completions');
        assert.deepEqual(calls[0].init?.headers, {
            Authorization: 'Bearer o-key',
            'Content-Type': 'application/json',
        });

        const body = JSON.parse(String(calls[0].init?.body));
        assert.equal(body.model, 'google/gemma-4-26b-a4b-it');
        assert.deepEqual(body.messages, [
            {
                role: 'system',
                content: [
                    'System Korean -> Chinese Traditional: 원문',
                    chineseRules,
                    'Examples:',
                ].join('\n'),
            },
            {
                role: 'user',
                content: '원문',
            },
        ]);
        assert.deepEqual(body.reasoning, { enabled: false });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('OpenRouterClient.translate can move serialized context into the system message', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return createJsonResponse({
            choices: [
                {
                    message: {
                        content: 'You should try it on.',
                    },
                },
            ],
            usage: {
                prompt_tokens: 31,
                completion_tokens: 6,
                reasoning_tokens: 0,
            },
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new OpenRouterClient(
            'o-key',
            'deepseek/deepseek-v4-flash',
            'https://openrouter.test/chat/completions',
            50,
            'system-context',
        );
        await client.translate(
            '<context>\n[Speaker 1, 8s ago] 저기 걸려있는 모자 진짜 귀엽다.\n</context>\n\n<input>\n한번 써봐\n</input>',
            'System ${sourceName} -> ${targetName}: ${text}',
            'Korean',
            'English',
        );

        const body = JSON.parse(String(calls[0].init?.body));
        assert.equal(body.model, 'deepseek/deepseek-v4-flash');
        assert.deepEqual(body.messages, [
            {
                role: 'system',
                content: [
                    'System Korean -> English: 한번 써봐',
                    '',
                    '<context>',
                    '[Speaker 1, 8s ago] 저기 걸려있는 모자 진짜 귀엽다.',
                    '</context>',
                ].join('\n'),
            },
            {
                role: 'user',
                content: '한번 써봐',
            },
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('OpenRouterClient.translate keeps compatibility with legacy Text to translate context labels', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return createJsonResponse({
            choices: [
                {
                    message: {
                        content: 'You should try it on.',
                    },
                },
            ],
            usage: {
                prompt_tokens: 31,
                completion_tokens: 6,
                reasoning_tokens: 0,
            },
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new OpenRouterClient(
            'o-key',
            'deepseek/deepseek-v4-flash',
            'https://openrouter.test/chat/completions',
            50,
            'system-context',
        );
        await client.translate(
            '<context>\n[Speaker 1, 8s ago] 저기 걸려있는 모자 진짜 귀엽다.\n</context>\n\nText to translate:\n한번 써봐',
            'System ${sourceName} -> ${targetName}: ${text}',
            'Korean',
            'English',
        );

        const body = JSON.parse(String(calls[0].init?.body));
        assert.deepEqual(body.messages, [
            {
                role: 'system',
                content: [
                    'System Korean -> English: 한번 써봐',
                    '',
                    '<context>',
                    '[Speaker 1, 8s ago] 저기 걸려있는 모자 진짜 귀엽다.',
                    '</context>',
                ].join('\n'),
            },
            {
                role: 'user',
                content: '한번 써봐',
            },
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('OpenRouterClient.translate keeps compatibility with legacy Current input context labels', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string | URL | Request; init: RequestInit | undefined }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url, init });
        return createJsonResponse({
            choices: [
                {
                    message: {
                        content: 'You should try it on.',
                    },
                },
            ],
            usage: {
                prompt_tokens: 31,
                completion_tokens: 6,
                reasoning_tokens: 0,
            },
        }) as unknown as Response;
    }) as typeof fetch;

    try {
        const client = new OpenRouterClient(
            'o-key',
            'deepseek/deepseek-v4-flash',
            'https://openrouter.test/chat/completions',
            50,
            'system-context',
        );
        await client.translate(
            '<context>\n[Speaker 1, 8s ago] 저기 걸려있는 모자 진짜 귀엽다.\n</context>\n\nCurrent input:\n한번 써봐',
            'System ${sourceName} -> ${targetName}: ${text}',
            'Korean',
            'English',
        );

        const body = JSON.parse(String(calls[0].init?.body));
        assert.deepEqual(body.messages, [
            {
                role: 'system',
                content: [
                    'System Korean -> English: 한번 써봐',
                    '',
                    '<context>',
                    '[Speaker 1, 8s ago] 저기 걸려있는 모자 진짜 귀엽다.',
                    '</context>',
                ].join('\n'),
            },
            {
                role: 'user',
                content: '한번 써봐',
            },
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('OpenRouterClient exposes request timeout metadata', () => {
    const client = new OpenRouterClient('o-key', 'google/gemma-4-26b-a4b-it', 'https://openrouter.test/chat/completions', 50);

    assert.equal(client.getRequestTimeoutMs(), 50);
});

test('OpenRouterClient.translate throws a single-attempt normalized invalid_response error', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;

    globalThis.fetch = (async () => {
        calls += 1;
        return createJsonResponse({
            choices: [
                {
                    message: {
                        content: '   ',
                    },
                },
            ],
            usage: {
                prompt_tokens: 9,
                completion_tokens: 3,
                reasoning_tokens: 0,
            },
        }) as unknown as Response;
    }) as typeof fetch;
    console.warn = () => {};

    try {
        await assert.rejects(
            () => new OpenRouterClient('o-key', 'google/gemma-4-26b-a4b-it', 'https://openrouter.test/chat/completions', 50)
                .translate('text', 'prompt', 'English', 'Japanese'),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(calls, 1);
                assert.equal(normalized.errorClass, 'invalid_response');
                assert.equal(normalized.retryable, true);
                assert.equal(normalized.requestTimeoutMs, 50);
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('OpenRouterClient.translate maps deterministic 409 request errors to bad_request', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => createJsonResponse(
        { error: { code: 'conflict' } },
        {
            ok: false,
            status: 409,
        },
    ) as unknown as Response) as typeof fetch;

    try {
        const client = new OpenRouterClient('o-key', 'google/gemma-4-26b-a4b-it', 'https://openrouter.test/chat/completions', 50);

        await assert.rejects(
            () => client.translate('text', 'prompt', 'English', 'Japanese'),
            (error: unknown) => {
                const normalized = error as NormalizedClientError;
                assert.equal(normalized.errorClass, 'bad_request');
                assert.equal(normalized.retryable, false);
                assert.equal(normalized.httpStatus, 409);
                return true;
            },
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});
