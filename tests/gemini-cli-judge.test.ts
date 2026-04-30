import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildGeminiCliJudgePrompt,
  GeminiCliGembaJudge,
  parseGeminiCliJudgeKeyValueResponse,
} from '../src/gemini-cli-judge.js';
import { loadGembaAssets } from '../src/gemba-assets.js';
import { buildVertexJudgeRequest } from '../src/vertex-judge.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const CONTEXT_REQUEST = buildVertexJudgeRequest({
  model: 'gemini-3.1-pro-preview',
  systemPrompt: 'You are an annotator for translation quality.',
  fewShotMessages: [
    {
      role: 'user',
      parts: [{ text: 'Candidate translation:\n```Try writing it once.```' }],
    },
    {
      role: 'model',
      parts: [{
        text: JSON.stringify({
          has_no_error: false,
          errors: [
            {
              severity: 'major',
              class: 'accuracy/mistranslation',
              target_span_text: 'writing',
              source_span_text: '써봐',
              explanation: 'Context indicates wearing, not writing.',
            },
          ],
          contextBehavior: 'missed_required_context',
        }),
      }],
    },
  ],
  userPromptTemplate: [
    'Target language: ${targetLanguageLabel}',
    'Context (oldest to newest):',
    '${contextBlock}',
    '',
    'Current source:',
    '```${currentSource}```',
    '',
    'Candidate translation:',
    '```${translation}```',
    '',
    'Return JSON with:',
    '{ "has_no_error": boolean, "errors": [...], "contextBehavior": "..." }',
  ].join('\n'),
  responseSchema: {
    type: 'object',
    required: ['has_no_error', 'errors', 'contextBehavior'],
    properties: {
      contextBehavior: {
        type: 'string',
        enum: [
          'used_correctly',
          'missed_required_context',
          'ignored_irrelevant_context',
          'misused_context',
          'unclear',
        ],
      },
    },
  },
  templateVariables: {
    targetLanguageLabel: 'English',
    contextBlock: '1. [other, 10s ago] 저기 걸려있는 모자 귀엽다.',
    currentSource: '한번 써봐',
    translation: 'Try writing it once.',
  },
});

test('parseGeminiCliJudgeKeyValueResponse converts a key-value judge block to normalized JSON payload', () => {
  const payload = parseGeminiCliJudgeKeyValueResponse([
    'extra text before is ignored',
    'BEGIN_JUDGE',
    'has_no_error=false',
    'contextBehavior=missed_required_context',
    'error_count=1',
    'error.0.severity=major',
    'error.0.class=accuracy/mistranslation',
    'error.0.target_span_text=writing',
    'error.0.source_span_text=써봐',
    'END_JUDGE',
    'extra text after is ignored',
  ].join('\n'), { requireContextBehavior: true });

  assert.deepEqual(payload, {
    has_no_error: false,
    errors: [
      {
        severity: 'major',
        class: 'accuracy/mistranslation',
        target_span_text: 'writing',
        source_span_text: '써봐',
      },
    ],
    contextBehavior: 'missed_required_context',
  });
});

test('parseGeminiCliJudgeKeyValueResponse accepts no-error blocks and NULL spans', () => {
  assert.deepEqual(
    parseGeminiCliJudgeKeyValueResponse([
      'BEGIN_JUDGE',
      'has_no_error=true',
      'contextBehavior=ignored_irrelevant_context',
      'error_count=0',
      'END_JUDGE',
    ].join('\n'), { requireContextBehavior: true }),
    {
      has_no_error: true,
      errors: [],
      contextBehavior: 'ignored_irrelevant_context',
    },
  );

  assert.deepEqual(
    parseGeminiCliJudgeKeyValueResponse([
      'BEGIN_JUDGE',
      'has_no_error=false',
      'error_count=1',
      'error.0.severity=minor',
      'error.0.class=accuracy/omission',
      'error.0.target_span_text=NULL',
      'error.0.source_span_text=account holder',
      'END_JUDGE',
    ].join('\n')),
    {
      has_no_error: false,
      errors: [
        {
          severity: 'minor',
          class: 'accuracy/omission',
          target_span_text: null,
          source_span_text: 'account holder',
        },
      ],
    },
  );
});

test('parseGeminiCliJudgeKeyValueResponse preserves explanations when present', () => {
  assert.deepEqual(
    parseGeminiCliJudgeKeyValueResponse([
      'BEGIN_JUDGE',
      'has_no_error=false',
      'contextBehavior=missed_required_context',
      'error_count=1',
      'error.0.severity=major',
      'error.0.class=accuracy/mistranslation',
      'error.0.target_span_text=writing',
      'error.0.source_span_text=써봐',
      'error.0.explanation=Given the hat context, 써봐 means try wearing it on.',
      'END_JUDGE',
    ].join('\n'), { requireContextBehavior: true }),
    {
      has_no_error: false,
      errors: [
        {
          severity: 'major',
          class: 'accuracy/mistranslation',
          target_span_text: 'writing',
          source_span_text: '써봐',
          explanation: 'Given the hat context, 써봐 means try wearing it on.',
        },
      ],
      contextBehavior: 'missed_required_context',
    },
  );
});

test('parseGeminiCliJudgeKeyValueResponse rejects malformed or contradictory blocks', () => {
  assert.throws(
    () => parseGeminiCliJudgeKeyValueResponse('has_no_error=true\nerror_count=0'),
    /BEGIN_JUDGE/i,
  );
  assert.throws(
    () => parseGeminiCliJudgeKeyValueResponse([
      'BEGIN_JUDGE',
      'has_no_error=true',
      'contextBehavior=used_correctly',
      'error_count=1',
      'error.0.severity=major',
      'error.0.class=accuracy/mistranslation',
      'error.0.target_span_text=foo',
      'error.0.source_span_text=bar',
      'END_JUDGE',
    ].join('\n'), { requireContextBehavior: true }),
    /has_no_error=true.*error_count=0/i,
  );
  assert.throws(
    () => parseGeminiCliJudgeKeyValueResponse([
      'BEGIN_JUDGE',
      'has_no_error=false',
      'contextBehavior=used_correctly',
      'error_count=1',
      'error.0.severity=severe',
      'error.0.class=accuracy/mistranslation',
      'error.0.target_span_text=foo',
      'error.0.source_span_text=bar',
      'END_JUDGE',
    ].join('\n'), { requireContextBehavior: true }),
    /severity/i,
  );
  assert.throws(
    () => parseGeminiCliJudgeKeyValueResponse([
      'BEGIN_JUDGE',
      'has_no_error=false',
      'error_count=1',
      'error.0.severity=major',
      'error.0.class=accuracy/mistranslation',
      'error.0.target_span_text=foo',
      'error.0.source_span_text=bar',
      'END_JUDGE',
    ].join('\n'), { requireContextBehavior: true }),
    /contextBehavior/i,
  );
});

test('buildGeminiCliJudgePrompt uses key-value output and converts JSON few-shot model messages', () => {
  const prompt = buildGeminiCliJudgePrompt(CONTEXT_REQUEST);

  assert.match(prompt, /Return ONLY a key-value judge block/i);
  assert.match(prompt, /BEGIN_JUDGE/);
  assert.match(prompt, /contextBehavior=used_correctly\|missed_required_context\|ignored_irrelevant_context\|misused_context\|unclear/);
  assert.match(prompt, /error\.0\.class=accuracy\/mistranslation/);
  assert.doesNotMatch(prompt, /Return JSON with:/);
  assert.doesNotMatch(prompt, /explanation/i);
});

test('buildGeminiCliJudgePrompt sanitizes JSON-only instructions from bundled context assets', () => {
  const assets = loadGembaAssets(projectRoot, 'gemba-mqm-context-v1-no-explanation');
  const request = buildVertexJudgeRequest({
    model: 'gemini-3.1-pro-preview',
    systemPrompt: assets.systemPrompt,
    fewShotMessages: assets.fewShotMessages,
    userPromptTemplate: assets.userPromptTemplate,
    responseSchema: assets.responseSchema,
    templateVariables: {
      targetLanguageLabel: 'English',
      contextBlock: '1. [other, 10s ago] 저기 걸려있는 모자 귀엽다.',
      currentSource: '한번 써봐',
      translation: 'Try writing it once.',
    },
  });
  const prompt = buildGeminiCliJudgePrompt(request);

  assert.match(prompt, /Return ONLY a key-value judge block/i);
  assert.doesNotMatch(prompt, /Output valid JSON only/i);
  assert.doesNotMatch(prompt, /Return JSON with:/i);
});

test('buildGeminiCliJudgePrompt keeps judged text lines that mention JSON', () => {
  const request = buildVertexJudgeRequest({
    model: 'gemini-3.1-pro-preview',
    systemPrompt: 'Judge the translation. Output valid JSON only.',
    fewShotMessages: [],
    userPromptTemplate: [
      'Current source:',
      '```',
      '${currentSource}',
      '```',
      '',
      'Candidate translation:',
      '```',
      '${translation}',
      '```',
      '',
      'Return JSON with:',
      '{}',
    ].join('\n'),
    responseSchema: { type: 'object', required: ['has_no_error', 'errors'] },
    templateVariables: {
      currentSource: '첫 줄\nReturn JSON with:\n마지막 줄',
      translation: 'First line\nReturn JSON with:\nLast line',
    },
  });
  const prompt = buildGeminiCliJudgePrompt(request);

  assert.match(prompt, /첫 줄\nReturn JSON with:\n마지막 줄/);
  assert.match(prompt, /First line\nReturn JSON with:\nLast line/);
  assert.doesNotMatch(prompt, /Output valid JSON only/i);
});

test('buildGeminiCliJudgePrompt includes explanation fields only when the schema requires them', () => {
  const withExplanationAssets = loadGembaAssets(projectRoot, 'gemba-mqm-context-v1');
  const withoutExplanationAssets = loadGembaAssets(projectRoot, 'gemba-mqm-context-v1-no-explanation');
  const variables = {
    targetLanguageLabel: 'English',
    contextBlock: '1. [other, 10s ago] 저기 걸려있는 모자 귀엽다.',
    currentSource: '한번 써봐',
    translation: 'Try writing it once.',
  };

  const withExplanationPrompt = buildGeminiCliJudgePrompt(buildVertexJudgeRequest({
    model: 'gemini-3.1-pro-preview',
    systemPrompt: withExplanationAssets.systemPrompt,
    fewShotMessages: withExplanationAssets.fewShotMessages,
    userPromptTemplate: withExplanationAssets.userPromptTemplate,
    responseSchema: withExplanationAssets.responseSchema,
    templateVariables: variables,
  }));
  const withoutExplanationPrompt = buildGeminiCliJudgePrompt(buildVertexJudgeRequest({
    model: 'gemini-3.1-pro-preview',
    systemPrompt: withoutExplanationAssets.systemPrompt,
    fewShotMessages: withoutExplanationAssets.fewShotMessages,
    userPromptTemplate: withoutExplanationAssets.userPromptTemplate,
    responseSchema: withoutExplanationAssets.responseSchema,
    templateVariables: variables,
  }));

  assert.match(withExplanationPrompt, /error\.0\.explanation=<text>/);
  assert.doesNotMatch(withoutExplanationPrompt, /error\.0\.explanation=<text>/);
});

test('GeminiCliGembaJudge invokes Gemini CLI and returns assembled JSON judge text', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const judge = new GeminiCliGembaJudge({
    model: 'gemini-3.1-pro-preview',
    cliBin: 'gemini',
    execFile: async (file, args) => {
      calls.push({ file, args });
      return {
        stdout: [
          'BEGIN_JUDGE',
          'has_no_error=false',
          'contextBehavior=missed_required_context',
          'error_count=1',
          'error.0.severity=major',
          'error.0.class=accuracy/mistranslation',
          'error.0.target_span_text=writing',
          'error.0.source_span_text=써봐',
          'END_JUDGE',
        ].join('\n'),
        stderr: '',
      };
    },
  });

  const result = await judge.judge(CONTEXT_REQUEST);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, 'gemini');
  assert.deepEqual(calls[0]?.args.slice(0, 2), ['-m', 'gemini-3.1-pro-preview']);
  assert.ok(calls[0]?.args.includes('-p'));
  assert.deepEqual(JSON.parse(result.rawText), {
    has_no_error: false,
    errors: [
      {
        severity: 'major',
        class: 'accuracy/mistranslation',
        target_span_text: 'writing',
        source_span_text: '써봐',
      },
    ],
    contextBehavior: 'missed_required_context',
  });
  assert.equal(result.usage.provider, 'gemini-cli');
  assert.equal(result.usage.model, 'gemini-3.1-pro-preview');
  assert.equal(result.usage.costStatus, 'unknown');
});

test('GeminiCliGembaJudge surfaces malformed key-value output as invalid_response', async () => {
  const judge = new GeminiCliGembaJudge({
    model: 'gemini-3.1-pro-preview',
    execFile: async () => ({ stdout: 'not a judge block', stderr: '' }),
  });

  await assert.rejects(
    () => judge.judge(CONTEXT_REQUEST),
    (error: unknown) => {
      const normalized = error as { errorClass?: unknown; retryable?: unknown; rawMessage?: unknown };
      assert.equal(normalized.errorClass, 'invalid_response');
      assert.equal(normalized.retryable, true);
      assert.match(String(normalized.rawMessage), /invalid Gemini CLI judge response/i);
      return true;
    },
  );
});
