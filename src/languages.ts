import type { TargetLanguageCode } from './benchmark-types.js';

const labelToCode = {
  English: 'en',
  Japanese: 'ja',
  'Chinese Simplified': 'zh-Hans',
} as const satisfies Record<string, TargetLanguageCode>;

const codeToLabel: Record<TargetLanguageCode, keyof typeof labelToCode> = {
  en: 'English',
  ja: 'Japanese',
  'zh-Hans': 'Chinese Simplified',
};

export function toTargetLanguageCode(label: string): TargetLanguageCode {
  if (Object.hasOwn(labelToCode, label)) {
    return labelToCode[label as keyof typeof labelToCode];
  }

  throw new Error(`Unsupported target language label: ${label}`);
}

export function toTargetLanguageLabel(code: TargetLanguageCode): keyof typeof labelToCode {
  if (Object.hasOwn(codeToLabel, code)) {
    return codeToLabel[code];
  }

  throw new Error(`Unsupported target language code: ${code}`);
}
