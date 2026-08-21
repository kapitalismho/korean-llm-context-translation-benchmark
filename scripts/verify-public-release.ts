import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_ROOT_FILES = [
  'README.md',
  'LICENSE',
  'data/LICENSE',
  'package.json',
  'package-lock.json',
  '.env.example',
  '.gitignore',
  'src/index.ts',
  'tests/index.js',
  'tests/reporting.test.ts',
  'data/datasets/gemba-mqm-context-v1/runtime.json',
  'data/datasets/gemba-mqm-context-v1.authoring/README.md',
  'vendor/gemba',
];

const REQUIRED_DOCS = [
  'docs/methodology.md',
  'docs/dataset.md',
  'docs/evaluation.md',
  'docs/results.md',
  'docs/limitations.md',
  'docs/reproducibility.md',
  'docs/third-party-notices.md',
];

const REQUIRED_REPORTS = [
  'experiments/2026-04-gemini-context-v2-archived/reports/leaderboard.overall.csv',
  'experiments/2026-04-gemini-context-v2-archived/reports/leaderboard.by-language.csv',
  'experiments/2026-04-gemini-context-v2-archived/reports/leaderboard.by-context-expectation.csv',
  'experiments/2026-04-gemini-context-v2-archived/reports/context-behavior.csv',
  'experiments/2026-04-gemini-context-v2-archived/reports/run-summary.json',
  'experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/README.md',
  'experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/manifest.json',
  'experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/fork-prepared.json',
  'experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/reports/summary-overall.penalty.json',
  'experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/reports/run-status.json',
  'experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/reports/leaderboard.by-language.json',
  'experiments/2026-08-issue1-milmmt-e4b-papago-deepseek-0731-archived/reports/context-behavior.rates.json',
  'experiments/2026-08-gemini35-live-10p-highjudge/README.md',
  'experiments/2026-08-gemini35-live-10p-highjudge/manifest.json',
  'experiments/2026-08-gemini35-live-10p-highjudge/fork-prepared.json',
  'experiments/2026-08-gemini35-live-10p-highjudge/reports/summary-overall.penalty.json',
  'experiments/2026-08-gemini35-live-10p-highjudge/reports/run-status.json',
  'experiments/2026-08-gemini35-live-10p-highjudge/reports/leaderboard.by-language.json',
  'experiments/2026-08-gemini35-live-10p-highjudge/reports/context-behavior.rates.json',
  'experiments/2026-08-gemini35-live-10p-highjudge/ablation/README.md',
  'experiments/2026-08-gemini35-live-10p-highjudge/ablation/manifest.json',
  'experiments/2026-08-gemini35-live-10p-highjudge/ablation/reports/ablation-ab-comparison.md',
];

const BLOCKED_PATHS = [
  '.agent',
  '.env',
  'AGENTS.md',
  'opencode.json',
  'data/benchmarks/gemba-mqm-context-v1.json',
  'data/benchmarks/gemba-mqm-context-v1-rework.json',
  'data/benchmarks/gemba-mqm-context-v1-rework-no-explanation.json',
  'data/benchmarks/gemba-mqm-context-v1-system-context.json',
  'data/benchmarks/gemba-mqm-v1.json',
  'data/benchmarks/gemba-mqm-v1.pilot.json',
  'data/judge-prompts/gemba-mqm-context-v1-no-explanation',
  'data/judge-prompts/gemba-mqm-v1',
  'data/prompts/gemini.md',
  'data/prompts/gemini-context-rework.md',
  'data/prompts/gemini-system-context-minimal.md',
  'docs/cost-analysis.md',
  'docs/superpowers',
  'docs/reports/2026-04-22-gemba-mqm-context-benchmark-final-report-ko.md',
  'reports',
  'scripts/experiment',
  'output',
  'node_modules',
  '.ruff_cache',
  'batch1.txt',
  'translation-eval.md',
  'openrouter.py',
  'qwen_async.py',
  'scripts/agent-eval-helper.js',
  'scripts/auto-format-score.js',
  'scripts/format-report.txt',
  'prompt_rev',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literalPattern(parts: string[], separator = '', flags?: string): RegExp {
  return new RegExp(escapeRegExp(parts.join(separator)), flags);
}

const slash = '/';
const backslash = String.fromCharCode(92);

const PRIVATE_PATTERNS = [
  /\bproject-[0-9a-f]{8}(?:-[0-9a-f]{3,}){3,}\b/i,
  /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n]+/i,
  literalPattern(['Start', 'Process powershell'], '-', 'i'),
  literalPattern(['RUN_ID', ''], '='),
  literalPattern(['LOG', ''], '='),
];

function patternFromFragments(parts: string[], suffix = '', flags?: string): RegExp {
  return new RegExp(`${escapeRegExp(parts.join(''))}${suffix}`, flags);
}

const GENERIC_SENSITIVE_PATTERNS = [
  patternFromFragments(['AI', 'za'], '[0-9A-Za-z_-]{20,}'),
  patternFromFragments(['sk', '-'], '[0-9A-Za-z_-]{20,}'),
  patternFromFragments(['Bear', 'er '], '[0-9A-Za-z._-]{20,}'),
  /BEGIN (?:RSA |EC |OPENSSH )?PRIV(?:ATE)? KEY/,
  literalPattern(['service', 'account'], '_', 'i'),
  literalPattern(['service', 'account'], '-', 'i'),
  literalPattern(['client', 'email'], '_', 'i'),
  literalPattern(['client', 'email'], '-', 'i'),
  literalPattern(['private', 'key'], '_', 'i'),
  literalPattern(['private', 'key'], '-', 'i'),
  literalPattern(['old', 'secret'], '-', 'i'),
  literalPattern(['secret', 'token'], '-', 'i'),
  literalPattern(['C:', ''], backslash),
  literalPattern(['C:', ''], slash),
  literalPattern(['', 'Users', ''], slash),
  literalPattern(['', 'home', ''], slash),
];

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function walk(filePath: string): string[] {
  const stats = statSync(filePath);

  if (!stats.isDirectory()) {
    return [filePath];
  }

  return readdirSync(filePath).flatMap((entry) => walk(path.join(filePath, entry)));
}

function assertExists(root: string, relativePath: string): void {
  if (!existsSync(path.join(root, relativePath))) {
    throw new Error(`Missing required public file: ${relativePath}`);
  }
}

function assertReportFile(root: string, relativePath: string): void {
  const absolutePath = path.join(root, relativePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Missing required public file: ${relativePath}`);
  }

  if (!statSync(absolutePath).isFile()) {
    throw new Error(`Report artifact must be a file: ${relativePath}`);
  }
}

function assertAbsent(root: string, relativePath: string): void {
  if (existsSync(path.join(root, relativePath))) {
    throw new Error(`Blocked path present in public release: ${relativePath}`);
  }
}

function assertNoUnexpectedReportFiles(root: string): void {
  const reportsRoot = path.join(root, 'experiments', '2026-04-gemini-context-v2-archived', 'reports');
  const expected = new Set(REQUIRED_REPORTS.map((item) => path.basename(item)));

  for (const entry of readdirSync(reportsRoot, { withFileTypes: true })) {
    const relativeEntry = `experiments/2026-04-gemini-context-v2-archived/reports/${entry.name}`;

    if (!entry.isFile()) {
      throw new Error(`Report artifact must be a file: ${relativeEntry}`);
    }

    if (!expected.has(entry.name)) {
      throw new Error(`Unexpected report artifact in public release: ${relativeEntry}`);
    }
  }
}

function assertVendoredLicense(root: string): void {
  const vendorRoot = path.join(root, 'vendor', 'gemba');
  const licenseFile = walk(vendorRoot).find((filePath) => /(^|\\|\/)licen[sc]e(\.|$)/i.test(filePath));

  if (!licenseFile) {
    throw new Error('Missing upstream license file under vendor/gemba');
  }
}

function readTextIfPractical(filePath: string): string {
  const buffer = readFileSync(filePath);

  if (buffer.includes(0)) {
    return '';
  }

  return buffer.toString('utf8');
}

function scanFiles(root: string, files: string[], patterns: RegExp[], label: string): void {
  for (const filePath of files) {
    const text = readTextIfPractical(filePath);

    for (const pattern of patterns) {
      if (pattern.test(text)) {
        throw new Error(`${label} ${pattern} found in ${path.relative(root, filePath)}`);
      }
    }
  }
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function firstPartyTextFiles(root: string): string[] {
  return walk(root).filter((filePath) => {
    const relativePath = normalizeRelativePath(path.relative(root, filePath));
    return !relativePath.startsWith('vendor/');
  });
}

let publicRoot = path.join(projectRoot, 'output', 'public-release', 'korean-multiturn-context-translation-benchmark');
const argv = process.argv.slice(2);

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];

  switch (arg) {
    case '--root':
      publicRoot = path.resolve(projectRoot, readValue(argv, index, arg));
      index += 1;
      break;
    default:
      throw new Error(`Unknown option: ${arg}`);
  }
}

for (const required of [...REQUIRED_ROOT_FILES, ...REQUIRED_DOCS]) {
  assertExists(publicRoot, required);
}

for (const report of REQUIRED_REPORTS) {
  assertReportFile(publicRoot, report);
}

for (const blocked of BLOCKED_PATHS) {
  assertAbsent(publicRoot, blocked);
}

assertNoUnexpectedReportFiles(publicRoot);
assertVendoredLicense(publicRoot);

scanFiles(publicRoot, walk(publicRoot), PRIVATE_PATTERNS, 'Private pattern');
scanFiles(publicRoot, firstPartyTextFiles(publicRoot), GENERIC_SENSITIVE_PATTERNS, 'Sensitive-looking pattern');

console.log(`Verified public release tree: ${publicRoot}`);
