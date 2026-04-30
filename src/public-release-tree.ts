import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { globSync } from 'glob';

export interface PublicReleaseTreeOptions {
  projectRoot: string;
  outDir?: string;
}

export interface PublicReleaseTreeResult {
  outDir: string;
  filesCopied: number;
}

const FILE_ALLOWLIST = [
  '.env.example',
  '.gitignore',
  'LICENSE',
  'README.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.test.json',
  'data/LICENSE',
  'data/benchmarks/gemba-mqm-context-v1-gemini-context-v2.json',
  'data/prompts/gemini-context-v2.md',
  'data/prompts/simple-translation.md',
  'tests/reporting.test.ts',
  'reports/leaderboard.overall.csv',
  'reports/leaderboard.by-language.csv',
  'reports/leaderboard.by-context-expectation.csv',
  'reports/context-behavior.csv',
  'reports/run-summary.json',
];

const GLOB_ALLOWLIST = [
  'src/**/*.ts',
  'data/datasets/**/*',
  'data/judge-prompts/gemba-mqm-context-v1/**/*',
  'data/participants/**/*',
  'data/prompt-examples/**/*',
  'data/prompt-rules/**/*',
  'docs/*.md',
  'docs/assets/**/*',
  'vendor/gemba/**/*',
];

const PUBLIC_TEST_INDEX = 'import \'./reporting.test.ts\';\n';

const SCRIPT_ALLOWLIST = [
  'scripts/freeze-context-dataset.ts',
  'scripts/generate-context-authoring-scaffold.ts',
  'scripts/generate-ranking-chart.ts',
  'scripts/validate-context-authoring.ts',
  'scripts/export-public-reports.ts',
  'scripts/build-public-release.ts',
  'scripts/verify-public-release.ts',
];

const BLOCKED_PUBLIC_PATHS = [
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
  'reports/cost-efficiency.csv',
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

export function defaultOutDir(projectRoot: string): string {
  return path.join(projectRoot, 'output', 'public-release', 'korean-multiturn-context-translation-benchmark');
}

export function assertSafeOutDir(projectRoot: string, outDir: string): void {
  const releaseRoot = path.resolve(projectRoot, 'output', 'public-release');
  const resolvedOutDir = path.resolve(outDir);
  const relativeToReleaseRoot = path.relative(releaseRoot, resolvedOutDir);

  if (relativeToReleaseRoot === '' || relativeToReleaseRoot.startsWith('..') || path.isAbsolute(relativeToReleaseRoot)) {
    throw new Error(`Refusing to delete outside output/public-release: ${outDir}`);
  }
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function isBlockedRelativePath(relativePath: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);

  return BLOCKED_PUBLIC_PATHS.some(
    (blockedPath) => normalizedPath === blockedPath || normalizedPath.startsWith(`${blockedPath}/`),
  );
}

function copyRelativeFile(projectRoot: string, outDir: string, relativePath: string): boolean {
  const source = path.join(projectRoot, relativePath);
  if (!existsSync(source) || statSync(source).isDirectory()) {
    return false;
  }

  const destination = path.join(outDir, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  return true;
}

function writePublicTestIndex(outDir: string): void {
  const destination = path.join(outDir, 'tests', 'index.js');

  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, PUBLIC_TEST_INDEX, 'utf8');
}

function addIfPublicFile(files: Set<string>, projectRoot: string, relativePath: string): void {
  const normalizedPath = normalizeRelativePath(relativePath);

  if (isBlockedRelativePath(normalizedPath)) {
    return;
  }

  const source = path.join(projectRoot, normalizedPath);
  if (existsSync(source) && !statSync(source).isDirectory()) {
    files.add(normalizedPath);
  }
}

function collectAllowlistedFiles(projectRoot: string): string[] {
  const files = new Set<string>();

  for (const file of [...FILE_ALLOWLIST, ...SCRIPT_ALLOWLIST]) {
    addIfPublicFile(files, projectRoot, file);
  }

  for (const pattern of GLOB_ALLOWLIST) {
    for (const match of globSync(pattern, { cwd: projectRoot, nodir: true, dot: true, posix: true })) {
      addIfPublicFile(files, projectRoot, match);
    }
  }

  return [...files].sort();
}

export function buildPublicReleaseTree(options: PublicReleaseTreeOptions): PublicReleaseTreeResult {
  const projectRoot = path.resolve(options.projectRoot);
  const outDir = options.outDir ?? defaultOutDir(projectRoot);

  assertSafeOutDir(projectRoot, outDir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  let filesCopied = 0;
  for (const relativePath of collectAllowlistedFiles(projectRoot)) {
    if (copyRelativeFile(projectRoot, outDir, relativePath)) {
      filesCopied += 1;
    }
  }
  writePublicTestIndex(outDir);
  filesCopied += 1;

  for (const blockedPath of BLOCKED_PUBLIC_PATHS) {
    if (existsSync(path.join(outDir, blockedPath))) {
      throw new Error(`Blocked path copied into public release tree: ${blockedPath}`);
    }
  }

  return { outDir, filesCopied };
}
