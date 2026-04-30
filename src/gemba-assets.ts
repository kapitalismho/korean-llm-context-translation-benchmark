import fs from 'node:fs';
import path from 'node:path';

import type { MqmErrorClass } from './benchmark-types.js';

export interface GembaAssetManifest {
  name: string;
  upstream: {
    repo: string;
    commit: string;
    promptFile: string;
    rubricFile: string;
  };
  mqmClasses: MqmErrorClass[];
}

export interface GembaFewShotMessage {
  role: string;
  parts: Array<{
    text: string;
  }>;
}

export interface GembaAssets {
  manifest: GembaAssetManifest;
  systemPrompt: string;
  userPromptTemplate: string;
  fewShotMessages: GembaFewShotMessage[];
  responseSchema: Record<string, unknown>;
}

const CONTEXT_BEHAVIOR_VALUES = [
  'used_correctly',
  'missed_required_context',
  'ignored_irrelevant_context',
  'misused_context',
  'unclear',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid ${label}: could not parse JSON at ${filePath}`, {
      cause: error,
    });
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }

  return value;
}

function requireNonEmptyStringArray(value: unknown, label: string): string[] {
  const values = requireStringArray(value, label);

  if (values.length === 0) {
    throw new Error(`${label} must contain at least one entry.`);
  }

  return values;
}

function normalizeStringSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function assertExactStringSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const normalizedActual = normalizeStringSet(actual);
  const normalizedExpected = normalizeStringSet(expected);

  if (
    normalizedActual.length !== normalizedExpected.length
    || normalizedActual.some((value, index) => value !== normalizedExpected[index])
  ) {
    throw new Error(`${label} must exactly match the expected values.`);
  }
}

function validateManifest(value: unknown): GembaAssetManifest {
  try {
    const manifest = requireRecord(value, 'manifest');
    const upstream = requireRecord(manifest.upstream, 'upstream');

    return {
      name: requireNonEmptyString(manifest.name, 'name'),
      upstream: {
        repo: requireNonEmptyString(upstream.repo, 'upstream.repo'),
        commit: requireNonEmptyString(upstream.commit, 'upstream.commit'),
        promptFile: requireNonEmptyString(upstream.promptFile, 'upstream.promptFile'),
        rubricFile: requireNonEmptyString(upstream.rubricFile, 'upstream.rubricFile'),
      },
      mqmClasses: requireNonEmptyStringArray(manifest.mqmClasses, 'mqmClasses') as MqmErrorClass[],
    };
  } catch (error) {
    throw new Error(`Invalid Gemba asset manifest: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function validateFewShotMessages(value: unknown): GembaFewShotMessage[] {
  try {
    if (!Array.isArray(value)) {
      throw new Error('fewShotMessages must be an array.');
    }

    return value.map((message, messageIndex) => {
      const messageRecord = requireRecord(message, `messages[${messageIndex}]`);
      const role = requireNonEmptyString(messageRecord.role, `messages[${messageIndex}].role`);

      if (!Array.isArray(messageRecord.parts)) {
        throw new Error(`messages[${messageIndex}].parts must be an array.`);
      }

      const parts = messageRecord.parts.map((part, partIndex) => {
        const partRecord = requireRecord(part, `messages[${messageIndex}].parts[${partIndex}]`);

        return {
          text: requireNonEmptyString(
            partRecord.text,
            `messages[${messageIndex}].parts[${partIndex}].text`,
          ),
        };
      });

      return { role, parts };
    });
  } catch (error) {
    throw new Error(`Invalid Gemba few-shot messages: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function validateResponseSchema(
  value: unknown,
  promptSetId: string,
  mqmClasses: readonly MqmErrorClass[],
): Record<string, unknown> {
  try {
    const schema = requireRecord(value, 'responseSchema');

    if (schema.type !== 'object') {
      throw new Error('responseSchema.type must be "object".');
    }

    const properties = requireRecord(schema.properties, 'responseSchema.properties');
    const required = requireStringArray(schema.required, 'responseSchema.required');

    if (!required.includes('has_no_error') || !required.includes('errors')) {
      throw new Error('responseSchema.required must include has_no_error and errors.');
    }

    const errorsProperty = requireRecord(properties.errors, 'responseSchema.properties.errors');
    if (errorsProperty.type !== 'array') {
      throw new Error('responseSchema.properties.errors.type must be "array".');
    }

    const errorItems = requireRecord(errorsProperty.items, 'responseSchema.properties.errors.items');
    const errorItemProperties = requireRecord(
      errorItems.properties,
      'responseSchema.properties.errors.items.properties',
    );
    const classProperty = requireRecord(
      errorItemProperties.class,
      'responseSchema.properties.errors.items.properties.class',
    );
    const classEnum = requireNonEmptyStringArray(
      classProperty.enum,
      'responseSchema.properties.errors.items.properties.class.enum',
    );

    assertExactStringSet(classEnum, mqmClasses, 'responseSchema.properties.errors.items.properties.class.enum');

    if (promptSetId.startsWith('gemba-mqm-context-v1')) {
      if (!required.includes('contextBehavior')) {
        throw new Error('responseSchema.required must include contextBehavior for gemba-mqm-context-v1.');
      }

      const contextBehaviorProperty = requireRecord(
        properties.contextBehavior,
        'responseSchema.properties.contextBehavior',
      );
      const contextBehaviorEnum = requireNonEmptyStringArray(
        contextBehaviorProperty.enum,
        'responseSchema.properties.contextBehavior.enum',
      );

      assertExactStringSet(
        contextBehaviorEnum,
        CONTEXT_BEHAVIOR_VALUES,
        'responseSchema.properties.contextBehavior.enum',
      );
    }

    return schema;
  } catch (error) {
    throw new Error(`Invalid Gemba response schema: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

export function loadGembaAssets(projectRoot: string, promptSetId: string = 'gemba-mqm-v1'): GembaAssets {
  const assetsDir = path.join(projectRoot, 'data', 'judge-prompts', promptSetId);

  const manifest = validateManifest(readJsonFile(path.join(assetsDir, 'manifest.json'), 'Gemba asset manifest'));
  const systemPrompt = requireNonEmptyString(
    fs.readFileSync(path.join(assetsDir, 'system.md'), 'utf8').trim(),
    'system prompt',
  );
  const userPromptTemplate = requireNonEmptyString(
    fs.readFileSync(path.join(assetsDir, 'user-template.md'), 'utf8').trim(),
    'user prompt template',
  );
  const fewShotMessages = validateFewShotMessages(
    readJsonFile(path.join(assetsDir, 'few-shot-messages.json'), 'Gemba few-shot messages'),
  );
  const responseSchema = validateResponseSchema(
    readJsonFile(path.join(assetsDir, 'response-schema.json'), 'Gemba response schema'),
    promptSetId,
    manifest.mqmClasses,
  );

  return {
    manifest,
    systemPrompt,
    userPromptTemplate,
    fewShotMessages,
    responseSchema,
  };
}
