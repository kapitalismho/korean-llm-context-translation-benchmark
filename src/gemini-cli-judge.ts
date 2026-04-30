import { execFile as nodeExecFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

import {
  CONTEXT_BEHAVIORS,
  MQM_ERROR_CLASSES,
  type ContextBehavior,
  type MqmErrorClass,
  type NormalizedJudgeError,
} from './benchmark-types.js';
import type { NormalizedClientError, NormalizedClientErrorClass } from './llm-client.js';
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

export interface GeminiCliJudgeKeyValueParseOptions {
  requireContextBehavior?: boolean;
  requireExplanation?: boolean;
}

export interface GeminiCliJudgePayload {
  has_no_error: boolean;
  errors: NormalizedJudgeError[];
  contextBehavior?: ContextBehavior;
}

const DEFAULT_GEMINI_CLI_BIN = 'gemini';
const DEFAULT_GEMINI_CLI_TIMEOUT_MS = 120_000;
const execFileAsync = promisify(nodeExecFile);
const SEVERITIES = ['minor', 'major', 'critical'] as const;
const ERROR_FIELD_PATTERN = /^error\.(\d+)\.(severity|class|target_span_text|source_span_text|explanation)$/;

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

function extractJudgeBlock(rawText: string): string {
  const beginIndex = rawText.indexOf('BEGIN_JUDGE');
  const endIndex = rawText.indexOf('END_JUDGE', beginIndex + 'BEGIN_JUDGE'.length);

  if (beginIndex < 0 || endIndex < 0) {
    throw new Error('Gemini CLI judge response must contain BEGIN_JUDGE and END_JUDGE markers.');
  }

  return rawText.slice(beginIndex + 'BEGIN_JUDGE'.length, endIndex).trim();
}

function parseBoolean(value: string, fieldName: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  throw new Error(`${fieldName} must be true or false.`);
}

function parseErrorCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error('error_count must be a non-negative integer.');
  }

  return Number(value);
}

function parseSeverity(value: string): NormalizedJudgeError['severity'] {
  if ((SEVERITIES as readonly string[]).includes(value)) {
    return value as NormalizedJudgeError['severity'];
  }

  throw new Error(`Invalid severity: ${value}`);
}

function parseMqmClass(value: string): MqmErrorClass {
  if ((MQM_ERROR_CLASSES as readonly string[]).includes(value)) {
    return value as MqmErrorClass;
  }

  throw new Error(`Invalid MQM class: ${value}`);
}

function parseContextBehavior(value: string): ContextBehavior {
  if ((CONTEXT_BEHAVIORS as readonly string[]).includes(value)) {
    return value as ContextBehavior;
  }

  throw new Error(`Invalid contextBehavior: ${value}`);
}

function parseSpan(value: string): string | null {
  return value === 'NULL' ? null : value;
}

export function parseGeminiCliJudgeKeyValueResponse(
  rawText: string,
  options: GeminiCliJudgeKeyValueParseOptions = {},
): GeminiCliJudgePayload {
  const block = extractJudgeBlock(rawText);
  const topLevel = new Map<string, string>();
  const errorFields = new Map<number, Map<string, string>>();
  const seenKeys = new Set<string>();

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 1) {
      throw new Error(`Invalid key-value line: ${line}`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (seenKeys.has(key)) {
      throw new Error(`Duplicate key in Gemini CLI judge response: ${key}`);
    }
    seenKeys.add(key);

    if (key === 'has_no_error' || key === 'contextBehavior' || key === 'error_count') {
      topLevel.set(key, value);
      continue;
    }

    const errorMatch = key.match(ERROR_FIELD_PATTERN);
    if (!errorMatch) {
      throw new Error(`Unknown key in Gemini CLI judge response: ${key}`);
    }

    const errorIndex = Number(errorMatch[1]);
    const fieldName = errorMatch[2];
    const fields = errorFields.get(errorIndex) ?? new Map<string, string>();
    fields.set(fieldName, value);
    errorFields.set(errorIndex, fields);
  }

  if (!topLevel.has('has_no_error')) {
    throw new Error('Gemini CLI judge response missing has_no_error.');
  }
  if (!topLevel.has('error_count')) {
    throw new Error('Gemini CLI judge response missing error_count.');
  }
  if (options.requireContextBehavior && !topLevel.has('contextBehavior')) {
    throw new Error('Gemini CLI judge response missing contextBehavior.');
  }

  const hasNoError = parseBoolean(topLevel.get('has_no_error')!, 'has_no_error');
  const errorCount = parseErrorCount(topLevel.get('error_count')!);
  const contextBehaviorValue = topLevel.get('contextBehavior');

  if (hasNoError && errorCount !== 0) {
    throw new Error('has_no_error=true requires error_count=0.');
  }
  if (!hasNoError && errorCount === 0) {
    throw new Error('has_no_error=false requires error_count greater than 0.');
  }

  const errors: NormalizedJudgeError[] = [];
  for (let index = 0; index < errorCount; index += 1) {
    const fields = errorFields.get(index);
    if (!fields) {
      throw new Error(`Gemini CLI judge response missing error.${index} fields.`);
    }

    for (const requiredField of ['severity', 'class', 'target_span_text', 'source_span_text']) {
      if (!fields.has(requiredField)) {
        throw new Error(`Gemini CLI judge response missing error.${index}.${requiredField}.`);
      }
    }

    if (options.requireExplanation && !fields.has('explanation')) {
      throw new Error(`Gemini CLI judge response missing error.${index}.explanation.`);
    }

    errors.push({
      severity: parseSeverity(fields.get('severity')!),
      class: parseMqmClass(fields.get('class')!),
      target_span_text: parseSpan(fields.get('target_span_text')!),
      source_span_text: parseSpan(fields.get('source_span_text')!),
      ...(fields.has('explanation') ? { explanation: fields.get('explanation')! } : {}),
    });
  }

  for (const index of errorFields.keys()) {
    if (index >= errorCount) {
      throw new Error(`Gemini CLI judge response included error.${index} beyond error_count=${errorCount}.`);
    }
  }

  return {
    has_no_error: hasNoError,
    errors,
    ...(contextBehaviorValue === undefined ? {} : { contextBehavior: parseContextBehavior(contextBehaviorValue) }),
  };
}

function requestRequiresContextBehavior(request: JudgeRequest): boolean {
  const config = request.config as Record<string, unknown> | undefined;
  const schema = config?.responseJsonSchema;

  if (!isRecord(schema)) {
    return false;
  }

  return Array.isArray(schema.required) && schema.required.includes('contextBehavior');
}

function requestRequiresExplanation(request: JudgeRequest): boolean {
  const config = request.config as Record<string, unknown> | undefined;
  const schema = config?.responseJsonSchema;

  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return false;
  }

  const errorsProperty = schema.properties.errors;
  if (!isRecord(errorsProperty) || !isRecord(errorsProperty.items)) {
    return false;
  }

  return Array.isArray(errorsProperty.items.required) && errorsProperty.items.required.includes('explanation');
}

function sanitizeSystemInstructionForCli(text: string): string {
  return text
    .replace(/\s*-\s*Output valid JSON only\.?/gi, '')
    .replace(/\bOutput valid JSON only\.?/gi, '')
    .replace(/\s*-\s*If there are no errors, return \{[^\n]+\}\.?/gi, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

function stripJsonReturnInstruction(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let inFence = false;
  let firstReturnInstructionIndex = -1;

  for (const [index, line] of lines.entries()) {
    if (!inFence && (
      /^\s*Return\s+(?:the\s+result\s+as\s+)?JSON\b/i.test(line)
      || /^\s*Return\s+JSON\s+with\s*:/i.test(line)
    )) {
      firstReturnInstructionIndex = index;
      break;
    }

    const fenceCount = line.match(/```/g)?.length ?? 0;
    if (fenceCount % 2 === 1) {
      inFence = !inFence;
    }
  }

  return (firstReturnInstructionIndex < 0 ? lines : lines.slice(0, firstReturnInstructionIndex)).join('\n').trim();
}

function keyValueBlockFromPayload(payload: GeminiCliJudgePayload): string {
  const lines = [
    'BEGIN_JUDGE',
    `has_no_error=${payload.has_no_error ? 'true' : 'false'}`,
  ];

  if (payload.contextBehavior) {
    lines.push(`contextBehavior=${payload.contextBehavior}`);
  }

  lines.push(`error_count=${payload.errors.length}`);

  payload.errors.forEach((error, index) => {
    lines.push(`error.${index}.severity=${error.severity}`);
    lines.push(`error.${index}.class=${error.class}`);
    lines.push(`error.${index}.target_span_text=${error.target_span_text ?? 'NULL'}`);
    lines.push(`error.${index}.source_span_text=${error.source_span_text ?? 'NULL'}`);
    if (error.explanation !== undefined) {
      lines.push(`error.${index}.explanation=${error.explanation}`);
    }
  });

  lines.push('END_JUDGE');
  return lines.join('\n');
}

function maybeConvertJsonJudgeTextToKeyValue(text: string, includeExplanation: boolean): string {
  try {
    const payload = JSON.parse(text) as GeminiCliJudgePayload;

    if (typeof payload.has_no_error !== 'boolean' || !Array.isArray(payload.errors)) {
      return text;
    }

    return keyValueBlockFromPayload({
      has_no_error: payload.has_no_error,
      errors: payload.errors.map((error) => ({
        severity: error.severity,
        class: error.class,
        target_span_text: error.target_span_text,
        source_span_text: error.source_span_text,
        ...(!includeExplanation || error.explanation === undefined ? {} : { explanation: error.explanation }),
      })),
      ...(payload.contextBehavior === undefined ? {} : { contextBehavior: payload.contextBehavior }),
    });
  } catch {
    return text;
  }
}

function getTextFromMessage(message: JudgeRequest['contents'][number]): string {
  return message.parts.map((part) => part.text).join('\n');
}

export function buildGeminiCliJudgePrompt(request: JudgeRequest): string {
  const requiresContextBehavior = requestRequiresContextBehavior(request);
  const requiresExplanation = requestRequiresExplanation(request);
  const config = request.config as Record<string, unknown> | undefined;
  const systemInstruction = typeof config?.systemInstruction === 'string'
    ? sanitizeSystemInstructionForCli(config.systemInstruction)
    : '';
  const fewShotMessages = request.contents.slice(0, -1);
  const taskMessage = request.contents.at(-1);
  const parts: string[] = [];

  if (systemInstruction.trim().length > 0) {
    parts.push(['System instructions:', systemInstruction.trim()].join('\n'));
  }

  parts.push([
    'Return ONLY a key-value judge block. Do not return JSON, Markdown, prose, or extra keys.',
    'Use exactly this shape:',
    'BEGIN_JUDGE',
    'has_no_error=true|false',
    ...(requiresContextBehavior
      ? ['contextBehavior=used_correctly|missed_required_context|ignored_irrelevant_context|misused_context|unclear']
      : []),
    'error_count=N',
    'error.0.severity=minor|major|critical',
    `error.0.class=${MQM_ERROR_CLASSES.join('|')}`,
    'error.0.target_span_text=<text or NULL>',
    'error.0.source_span_text=<text or NULL>',
    ...(requiresExplanation ? ['error.0.explanation=<text>'] : []),
    'END_JUDGE',
    'If has_no_error=true, set error_count=0 and omit all error.N.* lines.',
    'Use NULL only when there is no applicable span.',
  ].join('\n'));

  if (fewShotMessages.length > 0) {
    parts.push([
      'Examples:',
      ...fewShotMessages.map((message) => {
        const label = message.role === 'model' ? 'Judge' : 'User';
        const text = message.role === 'model'
          ? maybeConvertJsonJudgeTextToKeyValue(getTextFromMessage(message), requiresExplanation)
          : stripJsonReturnInstruction(getTextFromMessage(message));

        return `${label}:\n${text}`;
      }),
    ].join('\n\n'));
  }

  if (!taskMessage) {
    throw new Error('Gemini CLI judge request has no task message.');
  }

  parts.push([
    'Task:',
    stripJsonReturnInstruction(getTextFromMessage(taskMessage)),
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
        const payload = parseGeminiCliJudgeKeyValueResponse(rawOutput, {
          requireContextBehavior: requestRequiresContextBehavior(request),
          requireExplanation: requestRequiresExplanation(request),
        });
        const latencyMs = Date.now() - startTime;

        return {
          rawText: JSON.stringify(payload),
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
