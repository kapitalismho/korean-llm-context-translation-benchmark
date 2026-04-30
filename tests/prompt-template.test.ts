import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { buildTranslationPromptVariables, getTargetLanguageRules, getTranslationExamples } from '../src/gemini.js';

const LANGUAGE_PAIR_EXAMPLES_URL = new URL('../data/prompt-examples/language-pair/', import.meta.url);

function readExampleText(fileName: string): string {
  return readFileSync(new URL(fileName, LANGUAGE_PAIR_EXAMPLES_URL), 'utf8').trim();
}

function readOptionalText(url: URL): string {
  return existsSync(url) ? readFileSync(url, 'utf8').trim() : '';
}

function extractSection(markdown: string, heading: string): string {
  const headingMarker = `## ${heading}\n`;
  const start = markdown.indexOf(headingMarker);
  assert.notEqual(start, -1, `Expected ${heading} section`);
  const sectionStart = start + headingMarker.length;
  const nextHeading = markdown.slice(sectionStart).search(/^## /m);
  const sectionEnd = nextHeading === -1 ? markdown.length : sectionStart + nextHeading;
  return markdown.slice(sectionStart, sectionEnd).trimEnd();
}

test('gemini-context-v2 delegates target language rules to a dynamic placeholder', () => {
  const prompt = readFileSync(new URL('../data/prompts/gemini-context-v2.md', import.meta.url), 'utf8');

  assert.match(prompt, /\n### Target language Rules\n\$\{targetLanguageRules\}\n\n## Examples/);
  assert.doesNotMatch(prompt, /^#+\s*Language Rules$/m);
  assert.doesNotMatch(prompt, /\* \*\*Chinese\*\*/);
  assert.doesNotMatch(prompt, /\* \*\*Japanese\*\*/);
  assert.doesNotMatch(prompt, /\* \*\*English\*\*/);
  assert.doesNotMatch(prompt, /\* \*\*Korean\*\*/);
});

test('gemini-context-v2 delegates translation examples to a dynamic placeholder', () => {
  const prompt = readFileSync(new URL('../data/prompts/gemini-context-v2.md', import.meta.url), 'utf8');

  assert.equal(extractSection(prompt, 'Examples'), '${translationExamples}');
  assert.doesNotMatch(prompt, /교수님이 지금 연구실에 계신대/);
  assert.doesNotMatch(prompt, /There isn’t a cloud in the sky now/);
  assert.doesNotMatch(prompt, /你要不要试戴一下/);
});

test('gemini-context-v2 defines labeled Context policy without exposing internal policy instructions', () => {
  const prompt = readFileSync(new URL('../data/prompts/gemini-context-v2.md', import.meta.url), 'utf8');

  assert.equal(extractSection(prompt, 'Context'), [
    '* Ground the translation in `<input>`; use `<context>` cautiously to clarify it when helpful.',
    '* When unsure whether context applies, translate `<input>` standalone.',
    '* Treat timestamps and speaker hints as lightweight metadata for tracking conversation flow.',
    '* `[self]` means the current speaker’s earlier utterance; `[others]` means one or more other speakers who are not the current speaker.',
    '* Context may contain mixed languages; treat mixed-language context as normal conversation context.',
    '',
    '### Context Use Cases',
    'Use context when it directly helps with:',
    '* Reference: Resolve pronouns, demonstratives, deictic expressions, and omitted referents.',
    '* Ellipsis: Fill omitted subjects, objects, verbs, phrases, or endings when `<input>` is incomplete.',
    '* Reply: Identify what `<input>` answers, agrees with, rejects, jokes about, or reacts to.',
    '* Ambiguity: Choose the intended meaning of ambiguous words, idioms, slang, ASR noise, or short reactions.',
    '* Perspective: Preserve speaker, addressee, actor, and viewpoint.',
    '* Tone/Register: Recreate equivalent formality, honorifics/politeness, social distance, and emotional stance.',
    '* Discourse Link: Preserve temporal, causal, contrastive, or sequential cues.',
    '',
    '### Context Ignore Cases',
    'Ignore context when it would cause:',
    '* Addition Risk: Context would add unsupported names, causes, events, emotions, intentions, or details.',
    '* Speaker Boundary: Another speaker’s line is not clearly answered or referenced by `<input>`.',
    '* Topic Shift: `<input>` starts a new topic, question, request, or unrelated reaction.',
    '* Conflict: Context is old, inactive, misleading, contradicted, or overridden by `<input>`.',
    '* Weak Signal: Context looks related or tempting, but resolves nothing specific in `<input>`.',
    '* Already Clear: `<input>` is complete and unambiguous; context only adds background.',
  ].join('\n'));
  assert.doesNotMatch(prompt, /Apply this policy internally/);
});

test('gemini-context-v2 keeps preprocessing guidance concise and unlabeled', () => {
  const prompt = readFileSync(new URL('../data/prompts/gemini-context-v2.md', import.meta.url), 'utf8');

  assert.equal(extractSection(prompt, 'Preprocessing'), [
    '* Treat `<input>` as a speech transcript that may contain missing spacing, stutters, filler words, typos, or unusual punctuation.',
    '* Read through surface issues to understand the utterance.',
    '* Preserve incomplete or uncertain meaning instead of filling it with unsupported details.',
  ].join('\n'));
});

test('target language rules are stored as prompt-adjacent text files and loaded for interpolation', () => {
  const chineseRules = readOptionalText(new URL('../data/prompt-rules/target-language/chinese.md', import.meta.url));
  const japaneseRules = readOptionalText(new URL('../data/prompt-rules/target-language/japanese.md', import.meta.url));
  const englishRules = readOptionalText(new URL('../data/prompt-rules/target-language/english.md', import.meta.url));
  const koreanRules = readOptionalText(new URL('../data/prompt-rules/target-language/korean.md', import.meta.url));

  assert.equal(chineseRules, [
    '* Prefer natural softeners when they fit the source tone.',
    '* Prefer "你" for second-person address.',
  ].join('\n'));
  assert.equal(japaneseRules, [
    '* Match casual or polite speech level to the source tone.',
    '* Use タメ口 for casual tone.',
    '* Prefer 終助詞 when they naturally preserve tone.',
    '* Prefer "私" when a first-person pronoun is needed.',
  ].join('\n'));
  assert.equal(englishRules, [
    '* Use contractions and casual phrasing when they fit the source tone.',
    '* Keep polite or hesitant wording when the source sounds polite or hesitant.',
  ].join('\n'));
  assert.equal(koreanRules, [
    '* Match 반말 or 존댓말 to the source tone and social distance.',
    '* Prefer 해요체 when 존댓말 is appropriate.',
    '* Keep soft, hesitant, playful, or emphatic endings when they are shown in the source.',
  ].join('\n'));

  assert.equal(getTargetLanguageRules('Chinese Simplified'), chineseRules);
  assert.equal(getTargetLanguageRules('Chinese Traditional'), chineseRules);
  assert.equal(getTargetLanguageRules('Japanese'), japaneseRules);
  assert.equal(getTargetLanguageRules('English'), englishRules);
  assert.equal(getTargetLanguageRules('Korean'), koreanRules);
});

test('language-pair translation example files include the core pairs and fallback', () => {
  const fileNames = readdirSync(LANGUAGE_PAIR_EXAMPLES_URL)
    .filter((fileName) => fileName.endsWith('.md'))
    .sort();

  assert.deepEqual(fileNames, [
    'chinese-simplified-to-english.md',
    'chinese-simplified-to-japanese.md',
    'chinese-simplified-to-korean.md',
    'english-to-chinese-simplified.md',
    'english-to-japanese.md',
    'english-to-korean.md',
    'fallback.md',
    'japanese-to-chinese-simplified.md',
    'japanese-to-english.md',
    'japanese-to-korean.md',
    'korean-to-chinese-simplified.md',
    'korean-to-english.md',
    'korean-to-japanese.md',
  ].sort());

  for (const fileName of fileNames) {
    assert.notEqual(readExampleText(fileName), '', `${fileName} should not be empty`);
  }
});

test('getTranslationExamples returns exact language-pair example markdown', () => {
  assert.equal(getTranslationExamples('Korean', 'Japanese'), readExampleText('korean-to-japanese.md'));
  assert.equal(getTranslationExamples('Chinese Simplified', 'English'), readExampleText('chinese-simplified-to-english.md'));
  assert.equal(getTranslationExamples('zh-Hans', 'Korean'), readExampleText('chinese-simplified-to-korean.md'));
});

test('getTranslationExamples falls back only to fallback.md for unsupported source to English', () => {
  const fallbackExamples = readExampleText('fallback.md');

  assert.equal(getTranslationExamples('French', 'English'), fallbackExamples);
  assert.equal(getTranslationExamples('Chinese Traditional', 'English'), fallbackExamples);
});

test('getTranslationExamples does not fall back for unsupported non-English targets', () => {
  assert.equal(getTranslationExamples('French', 'Japanese'), '');
  assert.equal(getTranslationExamples('Chinese Traditional', 'Korean'), '');
  assert.equal(getTranslationExamples('Korean', 'Chinese Traditional'), '');
});

test('buildTranslationPromptVariables includes dynamic language-pair examples', () => {
  const variables = buildTranslationPromptVariables('원문', 'Korean', 'Japanese');

  assert.equal(variables.translationExamples, readExampleText('korean-to-japanese.md'));
});
