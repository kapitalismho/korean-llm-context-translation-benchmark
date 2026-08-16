import { execFile as nodeExecFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

import type { NormalizedClientError, NormalizedClientErrorClass } from './llm-client.js';
import { parseMqmTextJudgeResponse } from './normalize-gemba.js';
import type { CallUsageMetrics } from './run-metrics.js';
import type { buildVertexJudgeRequest, JudgeResult } from './vertex-judge.js';

type JudgeRequest = ReturnType<typeof buildVertexJudgeRequest>;

export type GeminiCliExecFile = (
  file: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface GeminiCliGembaJudgeConfig {
  model: string;
  cliBin?: string;
  requestTimeoutMs?: number;
  execFile?: GeminiCliExecFile;
}

const DEFAULT_GEMINI_CLI_BIN = 'gemini';
const DEFAULT_GEMINI_CLI_TIMEOUT_MS = 120_000;
const execFileAsync = promisify(nodeExecFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function defaultExecFile(
  file: string,
  args: string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(file, args, {
    ...options,
    encoding: 'utf8',
  });

  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function createGeminiCliJudgeError(
  errorClass: NormalizedClientErrorClass,
  rawMessage: string,
  retryable: boolean,
  requestTimeoutMs: number,
): Error & NormalizedClientError {
  const error = new Error(rawMessage) as Error & NormalizedClientError;
  error.errorClass = errorClass;
  error.retryable = retryable;
  error.rawMessage = rawMessage;
  error.cooldownScope = errorClass === 'rate_limit'
    ? 'throttle_bucket'
    : errorClass === 'timeout' || errorClass === 'network' || errorClass === 'invalid_response'
      ? 'item'
      : 'none';
  error.requestTimeoutMs = requestTimeoutMs;
  return error;
}

function normalizeGeminiCliJudgeError(error: unknown, requestTimeoutMs: number): Error & NormalizedClientError {
  if (isRecord(error) && typeof error.rawMessage === 'string' && typeof error.errorClass === 'string') {
    return error as unknown as Error & NormalizedClientError;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('timed out') || lower.includes('timeout')) {
    return createGeminiCliJudgeError('timeout', message, true, requestTimeoutMs);
  }
  if (lower.includes('rate limit') || lower.includes('quota') || lower.includes('resource_exhausted')) {
    return createGeminiCliJudgeError('rate_limit', message, true, requestTimeoutMs);
  }
  if (lower.includes('unauthorized') || lower.includes('unauthenticated') || lower.includes('permission denied')) {
    return createGeminiCliJudgeError('auth', message, false, requestTimeoutMs);
  }
  if (lower.includes('enoent') || lower.includes('not found')) {
    return createGeminiCliJudgeError('bad_request', message, false, requestTimeoutMs);
  }
  if (lower.includes('network') || lower.includes('econn') || lower.includes('fetch failed')) {
    return createGeminiCliJudgeError('network', message, true, requestTimeoutMs);
  }

  return createGeminiCliJudgeError('unknown', message, true, requestTimeoutMs);
}

function getTextFromMessage(message: JudgeRequest['contents'][number]): string {
  return message.parts.map((part) => part.text).join('\n');
}

export function buildGeminiCliJudgePrompt(request: JudgeRequest): string {
  const config = request.config as Record<string, unknown> | undefined;
  const systemInstruction = typeof config?.systemInstruction === 'string'
    ? config.systemInstruction.trim()
    : '';
  const fewShotMessages = request.contents.slice(0, -1);
  const taskMessage = request.contents.at(-1);
  const parts: string[] = [];

  if (systemInstruction.length > 0) {
    parts.push(['System instructions:', systemInstruction].join('\n'));
  }

  parts.push([
    'Return the annotation in exactly this text format:',
    '',
    'Critical:',
    'no-error | <MQM class> - "<translated span>"',
    'Major:',
    'no-error | <MQM class> - "<translated span>"',
    'Minor:',
    'no-error | <MQM class> - "<translated span>"',
    'contextBehavior: used_correctly | missed_required_context | ignored_irrelevant_context | misused_context | unclear',
    '',
    '- List each error under its severity heading (Critical:, Major:, Minor:).',
    '- Write error lines as <MQM class> - "<translated span>".',
    '- Write no-error under a heading that has no errors.',
    '- End with the contextBehavior line.',
    '- Do not return JSON, Markdown, prose, or extra sections.',
  ].join('\n'));

  if (fewShotMessages.length > 0) {
    parts.push([
      'Examples:',
      ...fewShotMessages.map((message) => {
        const label = message.role === 'model' ? 'Judge' : 'User';
        return `${label}:\n${getTextFromMessage(message)}`;
      }),
    ].join('\n\n'));
  }

  if (!taskMessage) {
    throw new Error('Gemini CLI judge request has no task message.');
  }

  parts.push([
    'Task:',
    getTextFromMessage(taskMessage),
  ].join('\n'));

  return parts.join('\n\n');
}

function unknownUsage(model: string, latencyMs: number): CallUsageMetrics {
  return {
    provider: 'gemini-cli',
    model,
    phase: 'judge',
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    latencyMs,
    costStatus: 'unknown',
    computedCostUsd: null,
  };
}

export class GeminiCliGembaJudge {
  private readonly cliBin: string;
  private readonly execFile: GeminiCliExecFile;

  constructor(private readonly config: GeminiCliGembaJudgeConfig) {
    this.cliBin = config.cliBin ?? DEFAULT_GEMINI_CLI_BIN;
    this.execFile = config.execFile ?? defaultExecFile;
  }

  private getRequestTimeoutMs(): number {
    return this.config.requestTimeoutMs ?? DEFAULT_GEMINI_CLI_TIMEOUT_MS;
  }

  async preflight(): Promise<void> {
    try {
      await this.execFile(this.cliBin, ['--version'], {
        timeout: this.getRequestTimeoutMs(),
        windowsHide: true,
      });
    } catch (error) {
      throw normalizeGeminiCliJudgeError(error, this.getRequestTimeoutMs());
    }
  }

  buildFailureUsage(_request: JudgeRequest, _error: NormalizedClientError): CallUsageMetrics {
    return unknownUsage(this.config.model, 0);
  }

  async judge(request: JudgeRequest): Promise<JudgeResult> {
    const startTime = Date.now();
    const prompt = buildGeminiCliJudgePrompt(request);

    try {
      const { stdout, stderr } = await this.execFile(this.cliBin, [
        '-m',
        this.config.model,
        '--output-format',
        'text',
        '--skip-trust',
        '-p',
        prompt,
      ], {
        timeout: this.getRequestTimeoutMs(),
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          NO_COLOR: '1',
        },
      });
      const rawOutput = stdout.trim();

      if (!rawOutput) {
        throw createGeminiCliJudgeError(
          'invalid_response',
          `Invalid Gemini CLI judge response: empty stdout${stderr.trim() ? `; stderr: ${stderr.trim()}` : ''}`,
          true,
          this.getRequestTimeoutMs(),
        );
      }

      try {
        // Validate the MQM text annotation shape; the runner normalizes the raw text.
        parseMqmTextJudgeResponse(rawOutput);
        const latencyMs = Date.now() - startTime;

        return {
          rawText: rawOutput,
          usage: unknownUsage(this.config.model, latencyMs),
        };
      } catch (error) {
        throw createGeminiCliJudgeError(
          'invalid_response',
          `Invalid Gemini CLI judge response: ${(error as Error).message}`,
          true,
          this.getRequestTimeoutMs(),
        );
      }
    } catch (error) {
      throw normalizeGeminiCliJudgeError(error, this.getRequestTimeoutMs());
    }
  }
}
