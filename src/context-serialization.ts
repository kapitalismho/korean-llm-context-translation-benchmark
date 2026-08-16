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

/**
 * Parse the runner's serialized context-model input (`<context>...</context>` +
 * `<input>...</input>`) back into its parts for clients that render a single
 * completion prompt (for example the llama.cpp completion mode).
 *
 * Returns null when the text is not a serialized context input (plain sentence).
 */
export function parseContextModelInput(text: string): { currentSource: string; contextTurns: string } | null {
  const taggedInputMatch = text.match(/^<context>\n([\s\S]*?)\n<\/context>\n\n<input>\n([\s\S]*)\n<\/input>$/);

  if (taggedInputMatch) {
    return {
      currentSource: taggedInputMatch[2],
      contextTurns: numberContextLines(taggedInputMatch[1]),
    };
  }

  const match = text.match(/^<context>\n([\s\S]*?)\n<\/context>\n\n(?:Text to translate|Current input):\n([\s\S]*)$/);

  if (!match) {
    return null;
  }

  return {
    currentSource: match[2],
    contextTurns: numberContextLines(match[1]),
  };
}

function numberContextLines(contextContent: string): string {
  return contextContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => `${index + 1}. ${line}`)
    .join('\n');
}
