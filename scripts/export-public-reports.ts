import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportPublicReports } from '../src/public-report-export.js';

interface CliOptions {
  outputRoot: string;
  reportsDir: string;
  mainRunId: string;
  deeplContextRunId: string;
  deeplNoContextRunId: string;
  generatedAtUtc: string;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_GENERATED_AT_UTC = '2026-04-30T00:00:00.000Z';

const DEFAULTS: CliOptions = {
  outputRoot: 'output',
  reportsDir: path.join(projectRoot, 'reports'),
  mainRunId: 'gemba-mqm-context-v1-gemini-context-v2-expanded-nodeepl-api-20260429-011514',
  deeplContextRunId: 'gemba-mqm-context-v1-gemini-context-v2-expanded-deepl-reuse-20260429-052309',
  deeplNoContextRunId: 'gemba-mqm-context-v1-gemini-context-v2-expanded-deepl-nocontext-reuse-20260429-052839',
  generatedAtUtc: DEFAULT_GENERATED_AT_UTC,
};

function requireOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function resolveFromProjectRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--output-root':
        options.outputRoot = requireOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--reports-dir':
        options.reportsDir = resolveFromProjectRoot(requireOptionValue(argv, index, arg));
        index += 1;
        break;
      case '--main-run-id':
        options.mainRunId = requireOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--deepl-context-run-id':
        options.deeplContextRunId = requireOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--deepl-nocontext-run-id':
        options.deeplNoContextRunId = requireOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--generated-at-utc':
        options.generatedAtUtc = requireOptionValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const result = exportPublicReports({
  projectRoot,
  outputRoot: options.outputRoot,
  reportsDir: options.reportsDir,
  mainRunId: options.mainRunId,
  deeplContextRunId: options.deeplContextRunId,
  deeplNoContextRunId: options.deeplNoContextRunId,
  generatedAtUtc: options.generatedAtUtc,
});

console.log(`Public reports written to ${result.reportsDir}`);
for (const filePath of result.files) {
  console.log(filePath);
}
