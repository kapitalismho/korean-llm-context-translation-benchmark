import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createRunLayout,
  getUnresolvedTranslationFailureRecords,
  hasJsonlRecord,
  parseRunManifestV3,
  writeJsonlRecord,
} from '../src/run-artifacts.js';
import type { RunManifestV3Input } from '../src/run-artifacts.js';

const DATASET_FINGERPRINT = 'a'.repeat(64);
const PROMPT_FINGERPRINT = 'b'.repeat(64);

function createTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'run-artifacts-'));
}

function createManifest(resume: boolean): RunManifestV3Input {
  return {
    manifestVersion: 3,
    runId: 'run-001',
    benchmarkId: 'gemba-mqm-v1',
    datasetVersion: 'sentences.json',
    datasetKind: 'sentence',
    datasetFingerprintSha256: DATASET_FINGERPRINT,
    judgeModelId: 'gemini-2.5-flash',
    promptVersion: 'gemini.md',
    promptFingerprintSha256: PROMPT_FINGERPRINT,
    judgePromptVersion: 'gemba-mqm-v1',
    judgePromptSetId: 'gemba-mqm-v1',
    targetLanguages: ['en', 'ja'],
    targetLanguageLabels: {
      en: 'English',
      ja: 'Japanese',
    },
    limitApplied: 5,
    participants: [
      {
        participantId: 'qwen-3.6-plus',
        displayName: 'Qwen 3.6 Plus',
        provider: 'qwen',
        providerModelId: 'qwen3.6-plus',
      },
      {
        participantId: 'gemini-3-flash',
        displayName: 'Gemini 3 Flash',
        provider: 'gemini',
        providerModelId: 'gemini-3-flash-preview',
      },
    ],
    translationConcurrencyPerModel: 2,
    vertexProject: 'demo-project',
    vertexRegion: 'us-central1',
    vendoredGembaCommit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
    resume,
  };
}

test('createRunLayout writes a v3 manifest and jsonl files', () => {
  const root = createTempRoot();

  try {
    const layout = createRunLayout(root, createManifest(false));
    const manifest = JSON.parse(readFileSync(layout.manifestPath, 'utf8')) as Record<string, unknown>;

    assert.equal(existsSync(layout.manifestPath), true);
    assert.equal(existsSync(layout.translationJsonlPath), true);
    assert.equal(existsSync(layout.translationFailuresJsonlPath), true);
    assert.equal(existsSync(layout.translationMetricsJsonlPath), true);
    assert.equal(existsSync(layout.normalizedJudgeJsonlPath), true);
    assert.equal(existsSync(layout.judgeMetricsJsonlPath), true);
    assert.equal(manifest.manifestVersion, 3);
    assert.deepEqual(manifest.targetLanguages, ['en', 'ja']);
    assert.deepEqual(manifest.targetLanguageLabels, {
      en: 'English',
      ja: 'Japanese',
    });
    assert.equal(manifest.datasetFingerprintSha256, DATASET_FINGERPRINT);
    assert.equal(manifest.limitApplied, 5);
    assert.equal(manifest.promptFingerprintSha256, PROMPT_FINGERPRINT);
    assert.equal(manifest.translationConcurrencyPerModel, 2);
    assert.deepEqual((manifest.participants as Array<{ participantId: string }>).map((participant) => participant.participantId), [
      'qwen-3.6-plus',
      'gemini-3-flash',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseRunManifestV3 preserves datasetKind and judgePromptSetId', () => {
  const manifest = parseRunManifestV3({
    ...createManifest(false),
    datasetKind: 'context',
    judgePromptSetId: 'gemba-mqm-context-v1',
  });

  assert.equal(manifest.datasetKind, 'context');
  assert.equal(manifest.judgePromptSetId, 'gemba-mqm-context-v1');
});

test('parseRunManifestV3 preserves judge backend provenance', () => {
  const manifest = parseRunManifestV3({
    ...createManifest(false),
    judgeBackend: 'gemini-cli',
    geminiCliBin: '/usr/local/bin/gemini',
  });

  assert.equal(manifest.judgeBackend, 'gemini-cli');
  assert.equal(manifest.geminiCliBin, '/usr/local/bin/gemini');
});

test('parseRunManifestV3 defaults legacy manifests to the Vertex judge backend', () => {
  const { judgeBackend: _judgeBackend, geminiCliBin: _geminiCliBin, ...legacyManifest } = createManifest(false) as RunManifestV3Input & {
    judgeBackend?: string;
    geminiCliBin?: string;
  };

  const manifest = parseRunManifestV3(legacyManifest);

  assert.equal(manifest.judgeBackend, 'vertex');
  assert.equal(manifest.geminiCliBin, undefined);
});

test('parseRunManifestV3 preserves participant promptFile metadata', () => {
  const manifest = parseRunManifestV3({
    ...createManifest(false),
    participants: [
      {
        participantId: 'baseline-model',
        displayName: 'Baseline Model',
        provider: 'deepseek',
        providerModelId: 'deepseek-v4-flash',
        promptFile: 'data/prompts/simple-translation.md',
        promptFingerprintSha256: 'c'.repeat(64),
      },
      {
        participantId: 'context-model',
        displayName: 'Context Model',
        provider: 'gemini',
        providerModelId: 'gemini-3-flash-preview',
      },
    ],
  });

  assert.equal(manifest.participants[0].promptFile, 'data/prompts/simple-translation.md');
  assert.equal(manifest.participants[0].promptFingerprintSha256, 'c'.repeat(64));
  assert.equal(manifest.participants[1].promptFile, undefined);
  assert.equal(manifest.participants[1].promptFingerprintSha256, undefined);
});

test('parseRunManifestV3 preserves participant messageLayout metadata', () => {
  const manifest = parseRunManifestV3({
    ...createManifest(false),
    participants: [
      {
        participantId: 'system-context-openrouter',
        displayName: 'System Context OpenRouter',
        provider: 'openrouter',
        providerModelId: 'deepseek/deepseek-v4-flash',
        messageLayout: 'system-context',
      },
      {
        participantId: 'default-openrouter',
        displayName: 'Default OpenRouter',
        provider: 'openrouter',
        providerModelId: 'google/gemma-4-26b-a4b-it',
      },
    ],
  });

  assert.equal(manifest.participants[0].messageLayout, 'system-context');
  assert.equal(manifest.participants[1].messageLayout, undefined);
});

test('parseRunManifestV3 rejects participant promptFile metadata without a fingerprint', () => {
  assert.throws(
    () => parseRunManifestV3({
      ...createManifest(false),
      participants: [
        {
          participantId: 'baseline-model',
          displayName: 'Baseline Model',
          provider: 'deepseek',
          providerModelId: 'deepseek-v4-flash',
          promptFile: 'data/prompts/simple-translation.md',
        },
      ],
    }),
    /promptFingerprintSha256/i,
  );
});

test('parseRunManifestV3 rejects participant prompt fingerprints without a promptFile', () => {
  assert.throws(
    () => parseRunManifestV3({
      ...createManifest(false),
      participants: [
        {
          participantId: 'baseline-model',
          displayName: 'Baseline Model',
          provider: 'deepseek',
          providerModelId: 'deepseek-v4-flash',
          promptFingerprintSha256: 'c'.repeat(64),
        },
      ],
    }),
    /promptFile/i,
  );
});

test('createRunLayout rejects resume when participant prompt fingerprints differ', () => {
  const root = createTempRoot();

  try {
    const freshManifest = {
      ...createManifest(false),
      participants: [
        {
          participantId: 'baseline-model',
          displayName: 'Baseline Model',
          provider: 'deepseek' as const,
          providerModelId: 'deepseek-v4-flash',
          promptFile: 'data/prompts/simple-translation.md',
          promptFingerprintSha256: 'c'.repeat(64),
        },
      ],
    };
    createRunLayout(root, freshManifest);

    assert.throws(
      () => createRunLayout(root, {
        ...freshManifest,
        resume: true,
        participants: [
          {
            ...freshManifest.participants[0],
            promptFingerprintSha256: 'd'.repeat(64),
          },
        ],
      }),
      /existing manifest does not match/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseRunManifestV3 defaults missing datasetKind and judgePromptSetId for legacy sentence manifests', () => {
  const { datasetKind: _datasetKind, judgePromptSetId: _judgePromptSetId, ...legacySentenceManifest } = createManifest(false);
  const manifest = parseRunManifestV3(legacySentenceManifest);

  assert.equal(manifest.datasetKind, 'sentence');
  assert.equal(manifest.judgePromptSetId, 'gemba-mqm-v1');
});

test('parseRunManifestV3 defaults missing judgePromptSetId from judgePromptVersion', () => {
  const { judgePromptSetId: _judgePromptSetId, ...legacyManifest } = createManifest(false);
  const manifest = parseRunManifestV3({
    ...legacyManifest,
    judgePromptVersion: 'legacy-judge-prompt-v2',
  });

  assert.equal(manifest.judgePromptVersion, 'legacy-judge-prompt-v2');
  assert.equal(manifest.judgePromptSetId, 'legacy-judge-prompt-v2');
});

test('parseRunManifestV3 preserves forkFromRunId', () => {
  const manifest = parseRunManifestV3({
    ...createManifest(false),
    forkFromRunId: 'run-source',
  });

  assert.equal(manifest.forkFromRunId, 'run-source');
});

test('getUnresolvedTranslationFailureRecords keeps only the latest unresolved failure per stable key', () => {
  const unresolved = getUnresolvedTranslationFailureRecords(
    [
      {
        stable_key: 'run-001::1::ja::gemini-a',
      },
    ],
    [
      {
        recorded_at: '2026-04-18T10:00:00.000Z',
        stable_key: 'run-001::1::ja::gemini-a',
        participant_id: 'gemini-a',
        participant_model_id: 'gemini-3-flash-preview',
        provider: 'gemini',
        source_id: '1',
        source_lang: 'en',
        target_language: 'ja',
        final_disposition: 'retry_exhausted',
        error_class: 'rate_limit',
        attempts_used: 5,
        last_error_summary: '429 rate limit',
      },
      {
        recorded_at: '2026-04-18T10:05:00.000Z',
        stable_key: 'run-001::2::ja::gemini-b',
        participant_id: 'gemini-b',
        participant_model_id: 'gemini-3-flash-preview',
        provider: 'gemini',
        source_id: '2',
        source_lang: 'en',
        target_language: 'ja',
        final_disposition: 'retry_exhausted',
        error_class: 'rate_limit',
        attempts_used: 5,
        last_error_summary: '429 rate limit',
      },
      {
        recorded_at: '2026-04-18T10:06:00.000Z',
        stable_key: 'run-001::2::ja::gemini-b',
        participant_id: 'gemini-b',
        participant_model_id: 'gemini-3-flash-preview',
        provider: 'gemini',
        source_id: '2',
        source_lang: 'en',
        target_language: 'ja',
        final_disposition: 'terminal_deterministic',
        error_class: 'bad_request',
        attempts_used: 1,
        last_error_summary: '400 invalid request',
      },
    ],
  );

  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0]?.stable_key, 'run-001::2::ja::gemini-b');
  assert.equal(unresolved[0]?.final_disposition, 'terminal_deterministic');
});

test('hasJsonlRecord supports idempotent resume', () => {
  const root = createTempRoot();

  try {
    const layout = createRunLayout(root, createManifest(false));

    writeJsonlRecord(layout.translationJsonlPath, {
      stable_key: 'run-001::1::ja::qwen-3.6-plus',
    });

    assert.equal(
      hasJsonlRecord(layout.translationJsonlPath, 'run-001::1::ja::qwen-3.6-plus'),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunLayout preserves an existing manifest on resume', () => {
  const root = createTempRoot();

  try {
    const initialLayout = createRunLayout(root, createManifest(false));
    const manifestText = readFileSync(initialLayout.manifestPath, 'utf8');

    createRunLayout(root, createManifest(true));

    assert.equal(readFileSync(initialLayout.manifestPath, 'utf8'), manifestText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunLayout rejects a fresh run when artifacts already exist for the runId', () => {
  const root = createTempRoot();

  try {
    createRunLayout(root, createManifest(false));

    assert.throws(
      () => createRunLayout(root, createManifest(false)),
      /fresh run/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunLayout rejects pre-v3 resume manifests explicitly', () => {
  const root = createTempRoot();

  try {
    const layout = createRunLayout(root, createManifest(false));

    writeFileSync(layout.manifestPath, `${JSON.stringify({
      ...createManifest(false),
      manifestVersion: 2,
    }, null, 2)}\n`);

    assert.throws(
      () => createRunLayout(root, createManifest(true)),
      /pre-v3 runs are unsupported for resume/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunLayout rejects fingerprint-less legacy manifests explicitly on resume', () => {
  const root = createTempRoot();

  try {
    const layout = createRunLayout(root, createManifest(false));

    writeFileSync(layout.manifestPath, `${JSON.stringify({
      runId: 'run-001',
      benchmarkId: 'gemba-mqm-v1',
      manifestVersion: 2,
      datasetVersion: 'sentences.json',
      promptVersion: 'gemini.md',
      judgePromptVersion: 'gemba-mqm-v1',
      judgeModelId: 'gemini-2.5-flash',
      targetLanguages: ['en', 'ja'],
      targetLanguageLabels: {
        en: 'English',
        ja: 'Japanese',
      },
      limitApplied: 5,
      participants: [
        {
          participantId: 'qwen-3.6-plus',
          displayName: 'Qwen 3.6 Plus',
          provider: 'qwen',
          providerModelId: 'qwen3.6-plus',
        },
      ],
      translationConcurrencyPerModel: 2,
      resume: false,
    }, null, 2)}\n`);

    assert.throws(
      () => createRunLayout(root, createManifest(true)),
      /pre-v3 runs are unsupported for resume/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunLayout requires an exact v3 target-language match on resume', () => {
  const root = createTempRoot();

  try {
    createRunLayout(root, createManifest(false));

    assert.throws(
      () => createRunLayout(root, {
        ...createManifest(true),
        targetLanguages: ['ja'],
      }),
      /Existing manifest does not match the requested resume configuration/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunLayout requires an exact v3 limit match on resume', () => {
  const root = createTempRoot();

  try {
    createRunLayout(root, createManifest(false));

    assert.throws(
      () => createRunLayout(root, {
        ...createManifest(true),
        limitApplied: 4,
      }),
      /Existing manifest does not match the requested resume configuration/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunLayout requires an exact v3 dataset fingerprint match on resume', () => {
  const root = createTempRoot();

  try {
    createRunLayout(root, createManifest(false));

    assert.throws(
      () => createRunLayout(root, {
        ...createManifest(true),
        datasetFingerprintSha256: 'c'.repeat(64),
      }),
      /Existing manifest does not match the requested resume configuration/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunLayout requires an exact v3 dataset kind match on resume', () => {
  const root = createTempRoot();

  try {
    createRunLayout(root, createManifest(false));

    assert.throws(
      () => createRunLayout(root, {
        ...createManifest(true),
        datasetKind: 'context',
        judgePromptSetId: 'gemba-mqm-context-v1',
      }),
      /Existing manifest does not match the requested resume configuration/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunLayout requires an exact v3 judge prompt set match on resume', () => {
  const root = createTempRoot();

  try {
    createRunLayout(root, createManifest(false));

    assert.throws(
      () => createRunLayout(root, {
        ...createManifest(true),
        judgePromptSetId: 'gemba-mqm-context-v1',
      }),
      /Existing manifest does not match the requested resume configuration/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunLayout requires an exact judge backend match on resume', () => {
  const root = createTempRoot();

  try {
    createRunLayout(root, createManifest(false));

    assert.throws(
      () => createRunLayout(root, {
        ...createManifest(true),
        judgeBackend: 'gemini-cli',
      }),
      /Existing manifest does not match the requested resume configuration/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunLayout requires an exact v3 prompt fingerprint match on resume', () => {
  const root = createTempRoot();

  try {
    createRunLayout(root, createManifest(false));

    assert.throws(
      () => createRunLayout(root, {
        ...createManifest(true),
        promptFingerprintSha256: 'd'.repeat(64),
      }),
      /Existing manifest does not match the requested resume configuration/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunLayout keeps prompt fingerprint strict for forked resumes', () => {
  const root = createTempRoot();

  try {
    createRunLayout(root, {
      ...createManifest(false),
      forkFromRunId: 'run-source',
    });

    assert.throws(
      () => createRunLayout(root, {
        ...createManifest(true),
        forkFromRunId: 'run-source',
        promptFingerprintSha256: 'd'.repeat(64),
      }),
      /Existing manifest does not match the requested resume configuration/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunLayout requires an exact forkFromRunId match on resume', () => {
  const root = createTempRoot();

  try {
    createRunLayout(root, {
      ...createManifest(false),
      forkFromRunId: 'run-source',
    });

    assert.throws(
      () => createRunLayout(root, {
        ...createManifest(true),
        forkFromRunId: 'run-other-source',
      }),
      /Existing manifest does not match the requested resume configuration/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
