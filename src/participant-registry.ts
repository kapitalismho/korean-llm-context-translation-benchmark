import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Provider, TranslationMessageLayout } from './llm-client.js';
import type { LlamaCppMode } from './llamacpp.js';

const REGISTRY_PROVIDERS = new Set<Provider>(['gemini', 'qwen', 'openrouter', 'deepseek', 'deepl', 'google-translate-basic', 'google-web', 'llamacpp', 'papago']);
const REGISTRY_MESSAGE_LAYOUTS = new Set<TranslationMessageLayout>(['system-context']);
const REGISTRY_LLAMACPP_MODES = new Set<LlamaCppMode>(['chat', 'completion']);

type RawParticipantDefinition = {
  participantId?: unknown;
  displayName?: unknown;
  provider?: unknown;
  providerModelId?: unknown;
  messageLayout?: unknown;
  promptFile?: unknown;
  llamaCppServerUrl?: unknown;
  llamaCppMode?: unknown;
};

export interface ParticipantDefinition {
  participantId: string;
  displayName: string;
  provider: Provider;
  providerModelId: string;
  messageLayout?: TranslationMessageLayout;
  promptFile?: string;
  promptFingerprintSha256?: string;
  llamaCppServerUrl?: string;
  llamaCppMode?: LlamaCppMode;
}

export function loadParticipantRegistry(pathOrUrl: string | URL): ParticipantDefinition[] {
  const registryPath = toRegistryPath(pathOrUrl);
  const registryDir = dirname(registryPath);
  const raw = JSON.parse(readFileSync(registryPath, 'utf8')) as unknown;

  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error('Participant registry must define at least two participants.');
  }

  const participantIds = new Set<string>();

  return raw.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`registry[${index}] must be an object.`);
    }

    const participantId = requireString(item.participantId, `registry[${index}].participantId`);
    if (participantIds.has(participantId)) {
      throw new Error(`Duplicate participant id: ${participantId}`);
    }

    participantIds.add(participantId);

    const messageLayout = requireOptionalMessageLayout(item.messageLayout, index);
    const promptFile = requireOptionalPromptFile(item.promptFile, index, registryDir);
    const provider = requireProvider(item.provider, index);
    const llamaCppServerUrl = requireOptionalLlamaCppServerUrl(item.llamaCppServerUrl, index);
    const llamaCppMode = requireOptionalLlamaCppMode(item.llamaCppMode, index);

    if (provider === 'llamacpp' && llamaCppServerUrl === undefined) {
      throw new Error(`registry[${index}].llamaCppServerUrl is required when provider is llamacpp`);
    }

    return {
      participantId,
      displayName: requireString(item.displayName, `registry[${index}].displayName`),
      provider,
      providerModelId: requireString(item.providerModelId, `registry[${index}].providerModelId`),
      ...(messageLayout ? { messageLayout } : {}),
      ...(promptFile ? { promptFile } : {}),
      ...(llamaCppServerUrl ? { llamaCppServerUrl } : {}),
      ...(llamaCppMode ? { llamaCppMode } : {}),
    };
  });
}

export function resolveSelectedParticipants(
  registry: ParticipantDefinition[],
  participantIds: string[],
): ParticipantDefinition[] {
  assertUniqueSelectedParticipantIds(participantIds);

  const participantsById = new Map(
    registry.map((participant) => [participant.participantId, participant]),
  );

  return participantIds.map((participantId) => {
    const participant = participantsById.get(participantId);
    if (!participant) {
      throw new Error(`Unknown participant id: ${participantId}`);
    }

    return participant;
  });
}

function assertUniqueSelectedParticipantIds(participantIds: string[]): void {
  const seen = new Set<string>();

  for (const participantId of participantIds) {
    if (seen.has(participantId)) {
      throw new Error(`Duplicate participant id in selection: ${participantId}`);
    }

    seen.add(participantId);
  }
}

function toRegistryPath(pathOrUrl: string | URL): string {
  if (pathOrUrl instanceof URL) {
    return fileURLToPath(pathOrUrl);
  }

  return resolve(pathOrUrl);
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Participant registry must define ${fieldName}.`);
  }

  return value;
}

function requireProvider(value: unknown, index: number): Provider {
  if (typeof value !== 'string' || !REGISTRY_PROVIDERS.has(value as Provider)) {
    throw new Error(`registry[${index}].provider must be one of gemini, qwen, openrouter, deepseek, deepl, google-translate-basic, google-web, llamacpp, or papago.`);
  }

  return value as Provider;
}

function requireOptionalMessageLayout(value: unknown, index: number): TranslationMessageLayout | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !REGISTRY_MESSAGE_LAYOUTS.has(value as TranslationMessageLayout)) {
    throw new Error(`registry[${index}].messageLayout must be system-context when provided.`);
  }

  return value as TranslationMessageLayout;
}

function requireOptionalPromptFile(value: unknown, index: number, registryDir: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`registry[${index}].promptFile must be a non-empty string when provided.`);
  }

  return resolve(registryDir, value);
}

function requireOptionalLlamaCppServerUrl(value: unknown, index: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`registry[${index}].llamaCppServerUrl must be a non-empty string when provided.`);
  }

  return value;
}

function requireOptionalLlamaCppMode(value: unknown, index: number): LlamaCppMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !REGISTRY_LLAMACPP_MODES.has(value as LlamaCppMode)) {
    throw new Error(`registry[${index}].llamaCppMode must be chat or completion when provided.`);
  }

  return value as LlamaCppMode;
}

function isRecord(value: unknown): value is RawParticipantDefinition {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
