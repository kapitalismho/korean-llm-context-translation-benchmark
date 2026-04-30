import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadGembaAssets } from '../src/gemba-assets.js';

function withTempProjectRoot(fn: (projectRoot: string) => void) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'gemba-assets-'));

  try {
    fn(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function writePromptSetFixture(
  projectRoot: string,
  promptSetId: string,
  overrides: {
    manifest?: unknown;
    fewShotMessages?: unknown;
    responseSchema?: unknown;
    systemPrompt?: string;
    userPromptTemplate?: string;
  } = {},
) {
  const promptSetDir = join(projectRoot, 'data', 'judge-prompts', promptSetId);
  mkdirSync(promptSetDir, { recursive: true });
  const mqmClasses = ['accuracy/mistranslation'];

  writeFileSync(join(promptSetDir, 'manifest.json'), JSON.stringify(overrides.manifest ?? {
    name: promptSetId,
    upstream: {
      repo: 'https://github.com/MicrosoftTranslator/GEMBA',
      commit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
      promptFile: 'gemba/prompt.py',
      rubricFile: 'gemba/gemba_mqm_utils.py',
    },
    mqmClasses,
  }, null, 2));
  writeFileSync(join(promptSetDir, 'system.md'), overrides.systemPrompt ?? 'Judge the translation.');
  writeFileSync(join(promptSetDir, 'user-template.md'), overrides.userPromptTemplate ?? 'Source:\n```$\{source}```');
  writeFileSync(join(promptSetDir, 'few-shot-messages.json'), JSON.stringify(overrides.fewShotMessages ?? [
    {
      role: 'user',
      parts: [{ text: 'Example prompt' }],
    },
    {
      role: 'model',
      parts: [{ text: '{"has_no_error":true,"errors":[]}' }],
    },
  ], null, 2));
  writeFileSync(join(promptSetDir, 'response-schema.json'), JSON.stringify(overrides.responseSchema ?? {
    type: 'object',
    additionalProperties: false,
    properties: {
      has_no_error: { type: 'boolean' },
      errors: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            class: {
              type: 'string',
              enum: mqmClasses,
            },
          },
          required: ['class'],
        },
      },
    },
    required: ['has_no_error', 'errors'],
  }, null, 2));
}

function stripExplanationFromContextJudgeSchema(schema: unknown): unknown {
  const clone = structuredClone(schema) as {
    properties?: {
      errors?: {
        items?: {
          required?: string[];
          properties?: Record<string, unknown>;
        };
      };
    };
  };
  const errorItems = clone.properties?.errors?.items;

  if (Array.isArray(errorItems?.required)) {
    errorItems.required = errorItems.required.filter((field) => field !== 'explanation');
  }
  if (errorItems?.properties) {
    delete errorItems.properties.explanation;
  }

  return clone;
}

function stripExplanationFromFewShotModelMessages(
  messages: ReturnType<typeof loadGembaAssets>['fewShotMessages'],
): ReturnType<typeof loadGembaAssets>['fewShotMessages'] {
  return messages.map((message) => {
    if (message.role !== 'model') {
      return message;
    }

    return {
      ...message,
      parts: message.parts.map((part) => {
        const payload = JSON.parse(part.text) as {
          errors?: Array<Record<string, unknown>>;
        };

        for (const error of payload.errors ?? []) {
          delete error.explanation;
        }

        return {
          ...part,
          text: JSON.stringify(payload),
        };
      }),
    };
  });
}

test('loadGembaAssets exposes pinned upstream metadata', () => {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const assets = loadGembaAssets(projectRoot);

  assert.equal(assets.manifest.upstream.commit, 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4');
  assert.equal(assets.manifest.upstream.promptFile, 'gemba/prompt.py');
  assert.equal(assets.manifest.upstream.rubricFile, 'gemba/gemba_mqm_utils.py');
  assert.ok(assets.manifest.mqmClasses.includes('fluency/register'));
  assert.equal(
    assets.systemPrompt,
    [
      'You are an annotator for the quality of machine translation. Your task is to identify errors and assess the quality of the translation.',
      '',
      'Additional constraints for this evaluation:',
      '- Evaluate only the current source sentence and the candidate translation.',
      '- Do not infer document-level inconsistency from any other sample.',
      '- Use only the allowed MQM classes and the severities minor, major, and critical.',
      '- Output valid JSON only.',
      '- If there are no errors, return {"has_no_error": true, "errors": []}.',
    ].join('\n'),
  );
  assert.match(
    assets.userPromptTemplate,
    /Based on the source segment and machine translation surrounded with triple backticks, identify error types in the translation and classify them\./,
  );
  assert.match(
    assets.userPromptTemplate,
    /Return the result as JSON with this structure:/,
  );
  assert.equal(assets.fewShotMessages.length, 6);
  assert.deepEqual(
    assets.fewShotMessages.map((message) => message.role),
    ['user', 'model', 'user', 'model', 'user', 'model'],
  );
  assert.match(
    assets.fewShotMessages[0].parts[0].text,
    /^English source:\n```I do apologise about this,/,
  );
  assert.match(
    assets.fewShotMessages[0].parts[0].text,
    /Based on the source segment and machine translation surrounded with triple backticks, identify error types in the translation and classify them\./,
  );
  assert.deepEqual(
    JSON.parse(assets.fewShotMessages[1].parts[0].text),
    {
      has_no_error: false,
      errors: [
        {
          severity: 'major',
          class: 'accuracy/mistranslation',
          target_span_text: 'involvement',
          source_span_text: null,
          explanation: 'The translation leaves “involvement” untranslated, causing a mistranslation.',
        },
        {
          severity: 'major',
          class: 'accuracy/omission',
          target_span_text: null,
          source_span_text: 'the account holder',
          explanation: 'The translation omits the reference to the account holder.',
        },
        {
          severity: 'minor',
          class: 'fluency/grammar',
          target_span_text: 'wäre',
          source_span_text: null,
          explanation: 'The grammatical form is incorrect in context.',
        },
        {
          severity: 'minor',
          class: 'fluency/register',
          target_span_text: 'dir',
          source_span_text: null,
          explanation: 'The informal register is inappropriate in context.',
        },
      ],
    },
  );
});

test('loadGembaAssets can load the context prompt set', () => {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const assets = loadGembaAssets(projectRoot, 'gemba-mqm-context-v1');

  assert.equal(assets.manifest.name, 'gemba-mqm-context-v1');
  assert.match(assets.userPromptTemplate, /Context \(oldest to newest\):/);
  assert.deepEqual(
    (assets.responseSchema as { required?: unknown }).required,
    ['has_no_error', 'errors', 'contextBehavior'],
  );
  assert.deepEqual(
    ((assets.responseSchema as {
      properties?: {
        contextBehavior?: { enum?: unknown };
      };
    }).properties?.contextBehavior?.enum),
    [
      'used_correctly',
      'missed_required_context',
      'ignored_irrelevant_context',
      'misused_context',
      'unclear',
    ],
  );
});

test('loadGembaAssets keeps explanations required in the existing context prompt set', () => {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const assets = loadGembaAssets(projectRoot, 'gemba-mqm-context-v1');
  const errorItems = (assets.responseSchema as {
    properties?: {
      errors?: {
        items?: {
          required?: unknown;
          properties?: Record<string, unknown>;
        };
      };
    };
  }).properties?.errors?.items;

  assert.deepEqual(
    errorItems?.required,
    ['severity', 'class', 'target_span_text', 'source_span_text', 'explanation'],
  );
  assert.deepEqual(errorItems?.properties?.explanation, { type: 'string' });

  const firstModelMessage = assets.fewShotMessages.find((message) => message.role === 'model');
  assert.ok(firstModelMessage);
  const payload = JSON.parse(firstModelMessage.parts[0].text) as {
    errors?: Array<{ explanation?: unknown }>;
  };
  assert.equal(typeof payload.errors?.[0]?.explanation, 'string');
});

test('loadGembaAssets can load the no-explanation context prompt set', () => {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const assets = loadGembaAssets(projectRoot, 'gemba-mqm-context-v1-no-explanation');

  assert.equal(assets.manifest.name, 'gemba-mqm-context-v1-no-explanation');
  assert.match(assets.userPromptTemplate, /Context \(oldest to newest\):/);
  assert.doesNotMatch(assets.userPromptTemplate, /explanation/i);

  const errorItems = (assets.responseSchema as {
    properties?: {
      errors?: {
        items?: {
          required?: unknown;
          properties?: Record<string, unknown>;
        };
      };
    };
  }).properties?.errors?.items;

  assert.deepEqual(errorItems?.required, ['severity', 'class', 'target_span_text', 'source_span_text']);
  assert.equal(errorItems?.properties?.explanation, undefined);
  assert.ok(
    assets.fewShotMessages.every((message) => message.parts.every((part) => !/explanation/i.test(part.text))),
  );
});

test('no-explanation context prompt set only removes error explanations from the original context prompt set', () => {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const original = loadGembaAssets(projectRoot, 'gemba-mqm-context-v1');
  const noExplanation = loadGembaAssets(projectRoot, 'gemba-mqm-context-v1-no-explanation');

  assert.equal(noExplanation.systemPrompt, original.systemPrompt);
  assert.equal(noExplanation.userPromptTemplate, original.userPromptTemplate);
  assert.deepEqual(
    noExplanation.responseSchema,
    stripExplanationFromContextJudgeSchema(original.responseSchema),
  );
  assert.deepEqual(
    noExplanation.fewShotMessages,
    stripExplanationFromFewShotModelMessages(original.fewShotMessages),
  );
});

test('loadGembaAssets keeps the sentence schema MQM class enum aligned with the manifest', () => {
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const assets = loadGembaAssets(projectRoot);

  assert.deepEqual(
    ((assets.responseSchema as {
      properties?: {
        errors?: {
          items?: {
            properties?: {
              class?: { enum?: unknown };
            };
          };
        };
      };
    }).properties?.errors?.items?.properties?.class?.enum),
    assets.manifest.mqmClasses,
  );
});

test('loadGembaAssets rejects malformed manifests with a clear error', () => {
  withTempProjectRoot((projectRoot) => {
    writePromptSetFixture(projectRoot, 'broken-manifest', {
      manifest: {
        name: 'broken-manifest',
        upstream: {
          repo: 'https://github.com/MicrosoftTranslator/GEMBA',
          commit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
          promptFile: 'gemba/prompt.py',
          rubricFile: 'gemba/gemba_mqm_utils.py',
        },
        mqmClasses: 'accuracy/mistranslation',
      },
    });

    assert.throws(
      () => loadGembaAssets(projectRoot, 'broken-manifest'),
      /Invalid Gemba asset manifest.*mqmClasses/i,
    );
  });
});

test('loadGembaAssets rejects empty MQM class inventories with a clear error', () => {
  withTempProjectRoot((projectRoot) => {
    writePromptSetFixture(projectRoot, 'empty-mqm-classes', {
      manifest: {
        name: 'empty-mqm-classes',
        upstream: {
          repo: 'https://github.com/MicrosoftTranslator/GEMBA',
          commit: 'a7a7eff8e46998447c6cbf09d06affc8f1b99ab4',
          promptFile: 'gemba/prompt.py',
          rubricFile: 'gemba/gemba_mqm_utils.py',
        },
        mqmClasses: [],
      },
    });

    assert.throws(
      () => loadGembaAssets(projectRoot, 'empty-mqm-classes'),
      /Invalid Gemba asset manifest.*mqmClasses/i,
    );
  });
});

test('loadGembaAssets rejects malformed few-shot messages with a clear error', () => {
  withTempProjectRoot((projectRoot) => {
    writePromptSetFixture(projectRoot, 'broken-few-shot', {
      fewShotMessages: [
        {
          role: 'user',
          parts: [{}],
        },
      ],
    });

    assert.throws(
      () => loadGembaAssets(projectRoot, 'broken-few-shot'),
      /Invalid Gemba few-shot messages.*parts\[0\]\.text/i,
    );
  });
});

test('loadGembaAssets rejects malformed response schemas with a clear error', () => {
  withTempProjectRoot((projectRoot) => {
    writePromptSetFixture(projectRoot, 'broken-schema', {
      responseSchema: [],
    });

    assert.throws(
      () => loadGembaAssets(projectRoot, 'broken-schema'),
      /Invalid Gemba response schema.*object/i,
    );
  });
});

test('loadGembaAssets rejects response schemas without an errors.class enum', () => {
  withTempProjectRoot((projectRoot) => {
    writePromptSetFixture(projectRoot, 'broken-errors-class-enum', {
      responseSchema: {
        type: 'object',
        properties: {
          has_no_error: { type: 'boolean' },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {},
              required: [],
            },
          },
        },
        required: ['has_no_error', 'errors'],
      },
    });

    assert.throws(
      () => loadGembaAssets(projectRoot, 'broken-errors-class-enum'),
      /Invalid Gemba response schema.*errors\.items\.properties\.class/i,
    );
  });
});

test('loadGembaAssets rejects context schemas with an invalid contextBehavior enum', () => {
  withTempProjectRoot((projectRoot) => {
    writePromptSetFixture(projectRoot, 'gemba-mqm-context-v1', {
      responseSchema: {
        type: 'object',
        properties: {
          has_no_error: { type: 'boolean' },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                class: {
                  type: 'string',
                  enum: ['accuracy/mistranslation'],
                },
              },
              required: ['class'],
            },
          },
          contextBehavior: {
            type: 'string',
            enum: ['used_correctly', 'wrong_value'],
          },
        },
        required: ['has_no_error', 'errors', 'contextBehavior'],
      },
    });

    assert.throws(
      () => loadGembaAssets(projectRoot, 'gemba-mqm-context-v1'),
      /Invalid Gemba response schema.*contextBehavior/i,
    );
  });
});
