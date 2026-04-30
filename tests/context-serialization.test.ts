import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderContextJudgeTemplateVariables,
  renderContextModelInput,
} from '../src/context-serialization.js';
import type { ContextRuntimeSample } from '../src/context-benchmark-types.js';

const SAMPLE: ContextRuntimeSample = {
  sampleId: 'ctx2-dyadic-use-referent_resolution-001',
  contextTurnCount: 2,
  speakerMode: 'dyadic',
  contextExpectation: 'use',
  primaryPhenomenon: 'referent_resolution',
  secondaryPhenomena: ['self_other_deixis'],
  contextTurns: [
    { speakerRole: 'other', relativeTimeLabel: '18s ago', sourceText: '어 안녕' },
    { speakerRole: 'self', relativeTimeLabel: '6s ago', sourceText: '지금 막 들어왔어' },
  ],
  currentSource: { speakerRole: 'self', relativeTimeLabel: null, sourceText: '거기 몇시야?' },
};

test('renderContextModelInput uses oldest-to-newest context ordering', () => {
  assert.equal(
    renderContextModelInput(SAMPLE),
    ['<context>', '[other, 18s ago] 어 안녕', '[self, 6s ago] 지금 막 들어왔어', '</context>', '', '<input>', '거기 몇시야?', '</input>'].join('\n'),
  );
});

test('renderContextJudgeTemplateVariables returns numbered judge context lines', () => {
  const variables = renderContextJudgeTemplateVariables(SAMPLE, 'What time is it there?', 'English');

  assert.equal(variables.targetLanguageLabel, 'English');
  assert.match(variables.contextBlock, /^1\. \[other, 18s ago\] 어 안녕\n2\. \[self, 6s ago\] 지금 막 들어왔어$/m);
  assert.equal(variables.currentSource, '거기 몇시야?');
  assert.equal(variables.translation, 'What time is it there?');
});
