import type { ContextRuntimeSample, ContextTurn } from './context-benchmark-types.js';

export function renderTurn(turn: ContextTurn): string {
  if (turn.relativeTimeLabel) {
    return `[${turn.speakerRole}, ${turn.relativeTimeLabel}] ${turn.sourceText}`;
  }

  return `[${turn.speakerRole}] ${turn.sourceText}`;
}

export function renderContextModelInput(sample: ContextRuntimeSample): string {
  return [
    '<context>',
    ...sample.contextTurns.map(renderTurn),
    '</context>',
    '',
    '<input>',
    sample.currentSource.sourceText,
    '</input>',
  ].join('\n');
}

export function renderContextJudgeTemplateVariables(
  sample: ContextRuntimeSample,
  translation: string,
  targetLanguageLabel: string,
): {
  targetLanguageLabel: string;
  contextBlock: string;
  currentSource: string;
  translation: string;
} {
  return {
    targetLanguageLabel,
    contextBlock: sample.contextTurns.map((turn, index) => `${index + 1}. ${renderTurn(turn)}`).join('\n'),
    currentSource: sample.currentSource.sourceText,
    translation,
  };
}
