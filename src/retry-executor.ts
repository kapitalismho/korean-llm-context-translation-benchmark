import type { NormalizedClientError } from './llm-client.js';

const RETRY_BACKOFF_DELAYS_MS = [0, 2_000, 5_000, 10_000, 20_000];
const THROTTLE_BUCKET_FAILURE_WINDOW_MS = 60_000;
const DEFAULT_THROTTLE_BUCKET_COOLDOWN_MS = 30_000;

export interface RetryExecutorThrottleBucketCooldown {
    triggered: true;
    reason: 'provider_signal' | 'retry_after' | 'failure_streak';
    delayMs: number;
}

export interface RetryExecutorFailureEvent {
    attempt: number;
    maxAttempts: number;
    normalizedError: NormalizedClientError;
    invalidResponseStreak: number;
    retryDelayMs: number | null;
    willRetry: boolean;
    recentRetryableThrottleFailures: number;
    throttleBucketCooldown: RetryExecutorThrottleBucketCooldown | null;
}

export interface ExecuteWithRetriesInput<T> {
    maxAttempts: number;
    operation: () => Promise<T>;
    classify: (error: unknown) => NormalizedClientError;
    now?: () => number;
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onFailure?: (event: RetryExecutorFailureEvent) => void | Promise<void>;
}

function getBaseDelayMs(attempt: number): number {
    return RETRY_BACKOFF_DELAYS_MS[attempt] ?? RETRY_BACKOFF_DELAYS_MS[RETRY_BACKOFF_DELAYS_MS.length - 1];
}

function getRetryDelayMs(
    attempt: number,
    random: () => number,
    retryAfterMs?: number,
): number {
    const baseDelayMs = getBaseDelayMs(attempt);
    const jitteredDelayMs = Math.round(baseDelayMs * (0.8 + (random() * 0.4)));
    return Math.max(jitteredDelayMs, retryAfterMs ?? 0);
}

function trimFailureWindow(recentFailures: number[], now: number) {
    while (recentFailures.length > 0 && now - recentFailures[0] > THROTTLE_BUCKET_FAILURE_WINDOW_MS) {
        recentFailures.shift();
    }
}

function getThrottleBucketCooldown(
    normalizedError: NormalizedClientError,
    recentRetryableThrottleFailures: number,
): RetryExecutorThrottleBucketCooldown | null {
    const retryAfterMs = normalizedError.retryAfterMs ?? 0;
    const delayMs = Math.max(DEFAULT_THROTTLE_BUCKET_COOLDOWN_MS, retryAfterMs);

    if (normalizedError.cooldownScope === 'throttle_bucket') {
        return {
            triggered: true,
            reason: 'provider_signal',
            delayMs,
        };
    }

    if (retryAfterMs >= 10_000) {
        return {
            triggered: true,
            reason: 'retry_after',
            delayMs,
        };
    }

    if (recentRetryableThrottleFailures >= 3) {
        return {
            triggered: true,
            reason: 'failure_streak',
            delayMs,
        };
    }

    return null;
}

export async function executeWithRetries<T>(input: ExecuteWithRetriesInput<T>): Promise<T> {
    const now = input.now ?? Date.now;
    const random = input.random ?? Math.random;
    const sleep = input.sleep ?? (async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });

    let invalidResponseStreak = 0;
    const recentRetryableThrottleFailures: number[] = [];

    for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
        try {
            return await input.operation();
        } catch (error) {
            const normalized = input.classify(error);
            invalidResponseStreak = normalized.errorClass === 'invalid_response'
                ? invalidResponseStreak + 1
                : 0;

            const failureTime = now();
            if (normalized.retryable && (normalized.errorClass === 'rate_limit' || normalized.errorClass === 'server_overload')) {
                recentRetryableThrottleFailures.push(failureTime);
                trimFailureWindow(recentRetryableThrottleFailures, failureTime);
            } else {
                trimFailureWindow(recentRetryableThrottleFailures, failureTime);
            }

            const willRetry = normalized.retryable
                && attempt < input.maxAttempts
                && invalidResponseStreak < 2;
            const retryDelayMs = willRetry
                ? getRetryDelayMs(attempt, random, normalized.retryAfterMs)
                : null;
            const throttleBucketCooldown = getThrottleBucketCooldown(
                normalized,
                recentRetryableThrottleFailures.length,
            );

            await input.onFailure?.({
                attempt,
                maxAttempts: input.maxAttempts,
                normalizedError: normalized,
                invalidResponseStreak,
                retryDelayMs,
                willRetry,
                recentRetryableThrottleFailures: recentRetryableThrottleFailures.length,
                throttleBucketCooldown,
            });

            if (!willRetry) {
                throw normalized;
            }

            await sleep(retryDelayMs ?? 0);
        }
    }

    throw new Error('executeWithRetries exhausted without returning or throwing');
}
