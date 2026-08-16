import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    extractHttpStatus,
    extractRetryAfterMs,
    getErrorMessage,
    isAbortError,
    isDeterministicBadRequestStatus,
    isNormalizedClientError,
    isRetryableErrorClass,
    type LLMClient,
    type NormalizedClientError,
    type NormalizedClientErrorClass,
    type TranslationResult,
} from './llm-client.js';
import { computeCallCost } from './run-metrics.js';

const PAPAGO_BRIDGE_SCRIPT_PATH = fileURLToPath(new URL('../scripts/papago-bridge.py', import.meta.url));
const PAPAGO_WORK_DIR = fileURLToPath(new URL('../output/papago/', import.meta.url));
const PAPAGO_CLIENT_DEFAULT_TIMEOUT_MS = 90_000;
const PAPAGO_BRIDGE_RESTART_BACKOFF_MS = 2_000;
const PAPAGO_STDERR_TAIL_LINES = 30;

const PAPAGO_CONTEXT_INPUT_PATTERN = /^<context>\n([\s\S]*?)\n<\/context>\n\n<input>\n([\s\S]*)\n<\/input>$/;
const PAPAGO_ALT_CONTEXT_PATTERN = /^<context>\n([\s\S]*?)\n<\/context>\n\n(?:Text to translate|Current input):\n([\s\S]+)$/;

const PAPAGO_ERROR_CLASSES = new Set<NormalizedClientErrorClass>([
    'rate_limit',
    'timeout',
    'server_overload',
    'network',
    'invalid_response',
    'auth',
    'bad_request',
    'unknown',
]);

type PapagoBridgeErrorBody = {
    class?: unknown;
    message?: unknown;
    retryAfterMs?: unknown;
};

type PapagoBridgeResponse = {
    id?: unknown;
    ok?: unknown;
    result?: unknown;
    error?: PapagoBridgeErrorBody;
};

type PapagoTranslateResult = {
    translatedText?: unknown;
    latencyMs?: unknown;
};

type PendingBridgeRequest = {
    resolve: (response: PapagoBridgeResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
};

type BridgeProcessRef = {
    alive: boolean;
    proc: ChildProcessWithoutNullStreams;
    pending: Map<number, PendingBridgeRequest>;
    nextId: number;
    stdoutBuffer: string;
    stderrTail: string[];
    deadUntil: number;
};

type BridgeConfig = {
    pythonCommand: string;
    bridgeScriptPath: string;
    workDir: string;
    requestTimeoutMs: number;
};

/**
 * Shared bridge processes: all PapagoClient instances with the same
 * (python, script, workDir) configuration share ONE python process so that
 * pacing/circuit-breaker state is global instead of per-client.
 */
const bridgeProcesses = new Map<string, BridgeProcessRef>();
let exitCleanupRegistered = false;

function classifyPapagoError(rawMessage: string, httpStatus?: number): NormalizedClientErrorClass {
    const lower = rawMessage.toLowerCase();

    if (httpStatus === 429 || lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('cooldown')) {
        return 'rate_limit';
    }

    if (httpStatus === 401 || httpStatus === 403 || lower.includes('forbidden') || lower.includes('rejected request') || lower.includes('permission')) {
        return 'auth';
    }

    if (isDeterministicBadRequestStatus(httpStatus) || lower.includes('unsupported') || lower.includes('invalid request') || lower.includes('bad request')) {
        return 'bad_request';
    }

    if (lower.includes('invalid response') || lower.includes('empty translatedtext') || lower.includes('did not contain')) {
        return 'invalid_response';
    }

    if (httpStatus === 408 || lower.includes('timeout') || lower.includes('timed out')) {
        return 'timeout';
    }

    if (httpStatus === 500 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504 || lower.includes('overload') || lower.includes('unavailable') || lower.includes('internal')) {
        return 'server_overload';
    }

    if (lower.includes('network') || lower.includes('socket') || lower.includes('econn') || lower.includes('exited') || lower.includes('failed to start') || lower.includes('restarting')) {
        return 'network';
    }

    return 'unknown';
}

function buildPapagoNormalizedError(
    rawMessage: string,
    requestTimeoutMs: number,
    options: {
        errorClass?: NormalizedClientErrorClass;
        httpStatus?: number;
        retryAfterMs?: number;
    } = {},
): NormalizedClientError {
    const httpStatus = options.httpStatus ?? extractHttpStatus(rawMessage);
    const errorClass = options.errorClass ?? classifyPapagoError(rawMessage, httpStatus);

    return {
        errorClass,
        // auth (401/403) means Papago blocked the request; the bridge enters
        // a cooldown, so a later retry is expected to succeed.
        retryable: errorClass === 'auth' ? true : isRetryableErrorClass(errorClass),
        rawMessage,
        httpStatus,
        retryAfterMs: options.retryAfterMs ?? extractRetryAfterMs(rawMessage),
        cooldownScope: errorClass === 'rate_limit' || errorClass === 'auth'
            ? 'throttle_bucket'
            : errorClass === 'timeout' || errorClass === 'network' || errorClass === 'invalid_response'
                ? 'item'
                : 'none',
        requestTimeoutMs,
    };
}

function buildPapagoBridgeNormalizedError(
    errorBody: PapagoBridgeErrorBody | undefined,
    requestTimeoutMs: number,
): NormalizedClientError {
    const message = typeof errorBody?.message === 'string' && errorBody.message.length > 0
        ? errorBody.message
        : 'unknown bridge error';
    const rawClass = typeof errorBody?.class === 'string' ? errorBody.class : 'unknown';
    const errorClass: NormalizedClientErrorClass = PAPAGO_ERROR_CLASSES.has(rawClass as NormalizedClientErrorClass)
        ? rawClass as NormalizedClientErrorClass
        : 'unknown';
    const rawRetryAfterMs = errorBody?.retryAfterMs;
    const retryAfterMs = typeof rawRetryAfterMs === 'number' && Number.isFinite(rawRetryAfterMs) && rawRetryAfterMs > 0
        ? Math.round(rawRetryAfterMs)
        : undefined;

    return buildPapagoNormalizedError(
        `Papago: ${message}`,
        requestTimeoutMs,
        { errorClass, retryAfterMs },
    );
}

export function normalizePapagoError(
    error: unknown,
    requestTimeoutMs: number = PAPAGO_CLIENT_DEFAULT_TIMEOUT_MS,
): NormalizedClientError {
    if (isNormalizedClientError(error)) {
        return error;
    }

    if (isAbortError(error)) {
        return buildPapagoNormalizedError(
            `Papago bridge request timed out after ${requestTimeoutMs}ms`,
            requestTimeoutMs,
        );
    }

    return buildPapagoNormalizedError(getErrorMessage(error), requestTimeoutMs);
}

function mapPapagoSourceLang(sourceLang: string): string {
    switch (sourceLang.trim().toLowerCase()) {
        case 'korean':
        case 'ko':
            return 'ko';
        case 'english':
        case 'en':
            return 'en';
        case 'japanese':
        case 'ja':
            return 'ja';
        case 'zh-hans':
        case 'zh-cn':
        case 'chinese simplified':
            return 'zh-CN';
        case 'zh-tw':
        case 'zh-hant':
        case 'chinese traditional':
            return 'zh-TW';
        case 'spanish':
        case 'es':
            return 'es';
        case 'french':
        case 'fr':
            return 'fr';
        case 'german':
        case 'de':
            return 'de';
        case 'russian':
        case 'ru':
            return 'ru';
        case 'portuguese':
        case 'pt':
            return 'pt';
        case 'italian':
        case 'it':
            return 'it';
        case 'vietnamese':
        case 'vi':
            return 'vi';
        case 'thai':
        case 'th':
            return 'th';
        case 'indonesian':
        case 'id':
            return 'id';
        case 'hindi':
        case 'hi':
            return 'hi';
        case 'arabic':
        case 'ar':
            return 'ar';
        default:
            throw new Error(`Papago unsupported source language: ${sourceLang}`);
    }
}

function mapPapagoTargetLang(targetLang: string): string {
    switch (targetLang.trim().toLowerCase()) {
        case 'ko':
        case 'korean':
            return 'ko';
        case 'en':
        case 'english':
            return 'en';
        case 'ja':
        case 'japanese':
            return 'ja';
        case 'zh-hans':
        case 'zh-cn':
        case 'chinese simplified':
            return 'zh-CN';
        case 'zh-tw':
        case 'zh-hant':
        case 'chinese traditional':
            return 'zh-TW';
        case 'es':
        case 'spanish':
            return 'es';
        case 'fr':
        case 'french':
            return 'fr';
        case 'de':
        case 'german':
            return 'de';
        case 'ru':
        case 'russian':
            return 'ru';
        case 'pt':
        case 'portuguese':
            return 'pt';
        case 'it':
        case 'italian':
            return 'it';
        case 'vi':
        case 'vietnamese':
            return 'vi';
        case 'th':
        case 'thai':
            return 'th';
        case 'id':
        case 'indonesian':
            return 'id';
        case 'hi':
        case 'hindi':
            return 'hi';
        case 'ar':
        case 'arabic':
            return 'ar';
        default:
            throw new Error(`Papago unsupported target language: ${targetLang}`);
    }
}

/** Strip the benchmark context wrapper so Papago only translates the input. */
function extractPapagoRequestParts(text: string): { text: string } {
    const match = text.match(PAPAGO_CONTEXT_INPUT_PATTERN) ?? text.match(PAPAGO_ALT_CONTEXT_PATTERN);

    if (!match) {
        return { text };
    }

    const currentInput = match[2]?.trim();

    if (!currentInput) {
        return { text };
    }

    return { text: currentInput };
}

function extractPapagoTranslation(result: PapagoTranslateResult): string {
    const text = result.translatedText;
    if (typeof text !== 'string') {
        throw new Error('Papago invalid response: bridge result did not contain translatedText');
    }

    const output = text.trim();
    if (!output) {
        throw new Error('Papago invalid response: bridge result contained empty translatedText');
    }

    return output;
}

function bridgeKey(config: BridgeConfig): string {
    return JSON.stringify([config.pythonCommand, config.bridgeScriptPath, config.workDir]);
}

function pushStderrTail(ref: BridgeProcessRef, chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
        if (!line) {
            continue;
        }
        ref.stderrTail.push(line);
        if (ref.stderrTail.length > PAPAGO_STDERR_TAIL_LINES) {
            ref.stderrTail.shift();
        }
    }
}

function stderrTailMessage(ref: BridgeProcessRef): string {
    if (ref.stderrTail.length === 0) {
        return '';
    }

    return `; bridge stderr tail: ${ref.stderrTail.join(' | ')}`;
}

function handleBridgeLine(ref: BridgeProcessRef, line: string): void {
    let message: PapagoBridgeResponse;
    try {
        message = JSON.parse(line) as PapagoBridgeResponse;
    } catch {
        pushStderrTail(ref, `non-JSON stdout line: ${line.slice(0, 200)}`);
        return;
    }

    if (typeof message.id !== 'number') {
        return;
    }

    const pending = ref.pending.get(message.id);
    if (!pending) {
        return; // timed out or already handled
    }

    ref.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message);
}

function markBridgeDead(ref: BridgeProcessRef, reason: string): void {
    if (!ref.alive) {
        return;
    }

    ref.alive = false;
    ref.deadUntil = Date.now() + PAPAGO_BRIDGE_RESTART_BACKOFF_MS;

    for (const pending of ref.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
    }
    ref.pending.clear();
}

function registerExitCleanup(): void {
    if (exitCleanupRegistered) {
        return;
    }

    exitCleanupRegistered = true;
    process.once('exit', () => {
        for (const ref of bridgeProcesses.values()) {
            if (ref.alive) {
                try {
                    ref.proc.kill();
                } catch {
                    // already gone
                }
            }
        }
    });
}

function spawnBridgeProcess(config: BridgeConfig): BridgeProcessRef {
    const ref: BridgeProcessRef = {
        alive: true,
        proc: null as unknown as ChildProcessWithoutNullStreams,
        pending: new Map(),
        nextId: 1,
        stdoutBuffer: '',
        stderrTail: [],
        deadUntil: 0,
    };

    let proc: ChildProcessWithoutNullStreams;
    try {
        proc = spawn(config.pythonCommand, [config.bridgeScriptPath], {
            cwd: ensureWorkDir(config.workDir),
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env,
            windowsHide: true,
        });
    } catch (error) {
        ref.alive = false;
        ref.deadUntil = Date.now() + PAPAGO_BRIDGE_RESTART_BACKOFF_MS;
        throw new Error(`papago bridge failed to spawn: ${getErrorMessage(error)}`);
    }
    ref.proc = proc;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
        ref.stdoutBuffer += chunk;
        let newlineIndex: number;
        while ((newlineIndex = ref.stdoutBuffer.indexOf('\n')) >= 0) {
            const line = ref.stdoutBuffer.slice(0, newlineIndex).trim();
            ref.stdoutBuffer = ref.stdoutBuffer.slice(newlineIndex + 1);
            if (line) {
                handleBridgeLine(ref, line);
            }
        }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
        pushStderrTail(ref, chunk);
    });

    proc.on('error', (error) => {
        markBridgeDead(ref, `papago bridge failed to start: ${error.message}${stderrTailMessage(ref)}`);
    });

    proc.on('exit', (code, signal) => {
        markBridgeDead(
            ref,
            `papago bridge exited (code=${code}, signal=${signal ?? 'none'})${stderrTailMessage(ref)}`,
        );
    });

    registerExitCleanup();
    return ref;
}

function ensureWorkDir(workDir: string): string {
    mkdirSync(workDir, { recursive: true });
    return workDir;
}

function ensureBridgeProcess(config: BridgeConfig): BridgeProcessRef {
    const key = bridgeKey(config);
    const existing = bridgeProcesses.get(key);

    if (existing) {
        if (existing.alive) {
            return existing;
        }

        const waitMs = existing.deadUntil - Date.now();
        if (waitMs > 0) {
            throw new Error(`papago bridge is restarting; retry in ${Math.ceil(waitMs / 1_000)}s`);
        }

        bridgeProcesses.delete(key);
    }

    const ref = spawnBridgeProcess(config);
    bridgeProcesses.set(key, ref);
    return ref;
}

function requestBridge(
    ref: BridgeProcessRef,
    method: string,
    params: unknown,
    requestTimeoutMs: number,
): Promise<PapagoBridgeResponse> {
    const id = ref.nextId;
    ref.nextId += 1;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ref.pending.delete(id);
            reject(new Error(`papago bridge request ${method} timed out after ${requestTimeoutMs}ms`));
        }, requestTimeoutMs);

        ref.pending.set(id, { resolve, reject, timer });
        ref.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
}

function bridgeRequest(config: BridgeConfig, method: string, params: unknown): Promise<PapagoBridgeResponse> {
    const ref = ensureBridgeProcess(config);
    return requestBridge(ref, method, params, config.requestTimeoutMs);
}

export type PapagoClientOptions = {
    modelName: string;
    pythonCommand?: string;
    bridgeScriptPath?: string;
    workDir?: string;
    requestTimeoutMs?: number;
};

export class PapagoClient implements LLMClient {
    private readonly modelName: string;
    private readonly bridgeConfig: BridgeConfig;

    constructor(options: PapagoClientOptions) {
        this.modelName = options.modelName;
        this.bridgeConfig = {
            pythonCommand: options.pythonCommand ?? 'python',
            bridgeScriptPath: options.bridgeScriptPath ?? PAPAGO_BRIDGE_SCRIPT_PATH,
            workDir: options.workDir ?? PAPAGO_WORK_DIR,
            requestTimeoutMs: options.requestTimeoutMs ?? PAPAGO_CLIENT_DEFAULT_TIMEOUT_MS,
        };
    }

    getModelName(): string {
        return this.modelName;
    }

    getProviderName(): string {
        return 'papago';
    }

    getRequestTimeoutMs(): number {
        return this.bridgeConfig.requestTimeoutMs;
    }

    async translate(
        text: string,
        _systemPrompt: string,
        sourceLang: string,
        targetLang: string,
    ): Promise<TranslationResult> {
        const requestParts = extractPapagoRequestParts(text);
        const source = mapPapagoSourceLang(sourceLang);
        const target = mapPapagoTargetLang(targetLang);
        const startTime = Date.now();

        try {
            const response = await bridgeRequest(this.bridgeConfig, 'translate', {
                text: requestParts.text,
                source,
                target,
            });

            if (!response.ok) {
                throw buildPapagoBridgeNormalizedError(response.error, this.getRequestTimeoutMs());
            }

            const result = response.result as PapagoTranslateResult;
            const output = extractPapagoTranslation(result);
            const latencyMs = typeof result.latencyMs === 'number' && result.latencyMs > 0
                ? result.latencyMs
                : Date.now() - startTime;

            return {
                output,
                latencyMs,
                usage: computeCallCost({
                    provider: 'papago',
                    model: this.modelName,
                    phase: 'translation',
                    inputTokens: null,
                    outputTokens: null,
                    reasoningTokens: null,
                    latencyMs,
                }, '2026-08-15'),
            };
        } catch (error) {
            throw normalizePapagoError(error, this.getRequestTimeoutMs());
        }
    }
}
