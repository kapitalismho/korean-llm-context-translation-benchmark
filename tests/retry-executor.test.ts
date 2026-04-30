import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedClientError } from '../src/llm-client.js';
import {
    executeWithRetries,
    type RetryExecutorFailureEvent,
} from '../src/retry-executor.js';

function createNormalizedError(
    overrides: Partial<NormalizedClientError> = {},
): NormalizedClientError {
    return {
        errorClass: 'unknown',
        retryable: true,
        rawMessage: 'boom',
        cooldownScope: 'none',
        requestTimeoutMs: 30_000,
        ...overrides,
    };
}

function passthrough(error: unknown): NormalizedClientError {
    return error as NormalizedClientError;
}

test('executeWithRetries honors Retry-After over the classified base delay', async () => {
    const delays: number[] = [];
    let attempts = 0;

    await assert.rejects(async () => executeWithRetries({
        maxAttempts: 2,
        now: () => 0,
        random: () => 0.5,
        sleep: async (ms) => {
            delays.push(ms);
        },
        classify: passthrough,
        operation: async () => {
            attempts += 1;
            throw createNormalizedError({
                errorClass: 'rate_limit',
                retryable: true,
                rawMessage: '429',
                retryAfterMs: 12_000,
                cooldownScope: 'throttle_bucket',
            });
        },
    }));

    assert.equal(attempts, 2);
    assert.deepEqual(delays, [12_000]);
});

test('executeWithRetries uses injected random jitter for retry delays', async () => {
    const delays: number[] = [];
    let attempts = 0;

    const result = await executeWithRetries({
        maxAttempts: 2,
        random: () => 1,
        sleep: async (ms) => {
            delays.push(ms);
        },
        classify: passthrough,
        operation: async () => {
            attempts += 1;
            if (attempts === 1) {
                throw createNormalizedError({
                    errorClass: 'network',
                    retryable: true,
                    rawMessage: 'socket hang up',
                    cooldownScope: 'item',
                });
            }

            return 'ok';
        },
    });

    assert.equal(result, 'ok');
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [2_400]);
});

test('executeWithRetries stops after a second consecutive invalid_response', async () => {
    const delays: number[] = [];
    let attempts = 0;

    await assert.rejects(
        () => executeWithRetries({
            maxAttempts: 5,
            random: () => 0.5,
            sleep: async (ms) => {
                delays.push(ms);
            },
            classify: passthrough,
            operation: async () => {
                attempts += 1;
                throw createNormalizedError({
                    errorClass: 'invalid_response',
                    retryable: true,
                    rawMessage: `invalid-${attempts}`,
                    cooldownScope: 'item',
                });
            },
        }),
        (error: unknown) => {
            const normalized = error as NormalizedClientError;
            assert.equal(normalized.errorClass, 'invalid_response');
            assert.equal(normalized.rawMessage, 'invalid-2');
            return true;
        },
    );

    assert.equal(attempts, 2);
    assert.deepEqual(delays, [2_000]);
});

test('executeWithRetries reports throttle-bucket cooldown triggers after repeated overloads', async () => {
    const events: RetryExecutorFailureEvent[] = [];
    const timestamps = [0, 1_000, 2_000, 3_000];
    let attempts = 0;
    let nowCalls = 0;

    await assert.rejects(() => executeWithRetries({
        maxAttempts: 4,
        now: () => timestamps[Math.min(nowCalls++, timestamps.length - 1)],
        random: () => 0.5,
        sleep: async () => {},
        classify: passthrough,
        onFailure: (event) => {
            events.push(event);
        },
        operation: async () => {
            attempts += 1;
            throw createNormalizedError({
                errorClass: 'server_overload',
                retryable: true,
                rawMessage: `503 overload ${attempts}`,
                cooldownScope: 'none',
            });
        },
    }));

    assert.equal(attempts, 4);
    assert.equal(events[2]?.throttleBucketCooldown?.triggered, true);
    assert.equal(events[2]?.throttleBucketCooldown?.reason, 'failure_streak');
    assert.equal(events[2]?.throttleBucketCooldown?.delayMs, 30_000);
});
