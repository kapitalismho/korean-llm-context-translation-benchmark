import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPublicReleaseTree } from '../src/public-release-tree.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const requiredDocs = [
  'methodology.md',
  'dataset.md',
  'evaluation.md',
  'results.md',
  'cost-analysis.md',
  'limitations.md',
  'reproducibility.md',
  'third-party-notices.md',
];

const requiredReports = [
  'leaderboard.overall.csv',
  'leaderboard.by-language.csv',
  'leaderboard.by-context-expectation.csv',
  'context-behavior.csv',
  'cost-efficiency.csv',
  'run-summary.json',
];

function writeFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

function writePublicVerifierFixture(publicRoot: string): void {
  writeFile(path.join(publicRoot, 'README.md'), '# Public\n');
  writeFile(path.join(publicRoot, 'LICENSE'), 'MIT\n');
  writeFile(path.join(publicRoot, 'data', 'LICENSE'), 'CC BY 4.0\n');
  writeFile(path.join(publicRoot, 'package.json'), '{"name":"fixture"}\n');
  writeFile(path.join(publicRoot, 'package-lock.json'), '{"name":"fixture"}\n');
  writeFile(path.join(publicRoot, '.env.example'), 'GEMINI_API_KEY=\n');
  writeFile(path.join(publicRoot, '.gitignore'), 'output/\n');
  writeFile(path.join(publicRoot, 'src', 'index.ts'), 'export {};\n');
  writeFile(path.join(publicRoot, 'tests', 'index.js'), 'import "./reporting.test.ts";\n');
  writeFile(path.join(publicRoot, 'tests', 'reporting.test.ts'), 'import test from "node:test";\n');
  writeFile(path.join(publicRoot, 'data', 'datasets', 'gemba-mqm-context-v1', 'runtime.json'), '[]\n');
  writeFile(path.join(publicRoot, 'data', 'datasets', 'gemba-mqm-context-v1.authoring', 'README.md'), '# Authoring\n');
  writeFile(path.join(publicRoot, 'vendor', 'gemba', 'LICENSE.md'), 'Upstream license\n');

  for (const doc of requiredDocs) {
    writeFile(path.join(publicRoot, 'docs', doc), `# ${doc}\n`);
  }

  for (const report of requiredReports) {
    writeFile(path.join(publicRoot, 'reports', report), report.endsWith('.json') ? '{}\n' : 'header\n');
  }
}

function runPublicVerifier(publicRoot: string): string {
  return execFileSync(process.execPath, ['--import', 'tsx', 'scripts/verify-public-release.ts', '--root', publicRoot], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function capturePublicVerifierFailure(publicRoot: string): string {
  try {
    runPublicVerifier(publicRoot);
  } catch (error) {
    const failedProcess = error as { message?: string; stderr?: string; stdout?: string };
    return [failedProcess.stdout, failedProcess.stderr, failedProcess.message].filter(Boolean).join('\n');
  }

  assert.fail('Expected public verifier to fail');
}

test('buildPublicReleaseTree copies allowlisted files and excludes internal files', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'public-release-tree-'));
  const outDir = path.join(projectRoot, 'output', 'public-release', 'fixture');

  writeFile(path.join(projectRoot, 'README.md'), '# Public\n');
  writeFile(path.join(projectRoot, 'LICENSE'), 'MIT\n');
  writeFile(path.join(projectRoot, '.gitignore'), 'output/\n');
  writeFile(path.join(projectRoot, '.env.example'), 'GEMINI_API_KEY=\n');
  writeFile(path.join(projectRoot, 'package.json'), '{"name":"fixture"}\n');
  writeFile(path.join(projectRoot, 'package-lock.json'), '{"name":"fixture"}\n');
  writeFile(path.join(projectRoot, 'tsconfig.json'), '{}\n');
  writeFile(path.join(projectRoot, 'tsconfig.test.json'), '{}\n');
  writeFile(path.join(projectRoot, 'src', 'index.ts'), 'export {};\n');
  writeFile(path.join(projectRoot, 'tests', 'index.js'), 'import "./index.test.ts";\n');
  writeFile(path.join(projectRoot, 'tests', 'index.test.ts'), 'import test from "node:test";\n');
  writeFile(path.join(projectRoot, 'scripts', 'freeze-context-dataset.ts'), 'export {};\n');
  writeFile(path.join(projectRoot, 'data', 'datasets', 'gemba-mqm-context-v1', 'runtime.json'), '[]\n');
  writeFile(path.join(projectRoot, 'data', 'LICENSE'), 'CC BY 4.0\n');
  writeFile(path.join(projectRoot, 'docs', 'methodology.md'), '# Methodology\n');
  writeFile(path.join(projectRoot, 'docs', 'assets', 'leaderboard.png'), 'fixture image\n');
  writeFile(path.join(projectRoot, 'reports', 'leaderboard.overall.csv'), 'rank,participant_id\n');
  writeFile(path.join(projectRoot, 'reports', 'leaderboard.by-language.csv'), 'language,rank,participant_id\n');
  writeFile(path.join(projectRoot, 'reports', 'leaderboard.by-context-expectation.csv'), 'context_expectation,rank,participant_id\n');
  writeFile(path.join(projectRoot, 'reports', 'context-behavior.csv'), 'participant_id,used_correctly\n');
  writeFile(path.join(projectRoot, 'reports', 'cost-efficiency.csv'), 'participant_id,total_cost_usd\n');
  writeFile(path.join(projectRoot, 'reports', 'run-summary.json'), '{}\n');
  writeFile(path.join(projectRoot, 'reports', 'internal.csv'), 'private\n');
  writeFile(path.join(projectRoot, 'vendor', 'gemba', 'commit', 'README.md'), '# GEMBA\n');

  writeFile(path.join(projectRoot, '.agent', 'state.json'), '{}\n');
  writeFile(path.join(projectRoot, '.env'), 'SECRET=1\n');
  writeFile(path.join(projectRoot, 'AGENTS.md'), 'internal\n');
  writeFile(path.join(projectRoot, 'opencode.json'), '{}\n');
  writeFile(path.join(projectRoot, 'docs', 'superpowers', 'plans', 'internal.md'), 'internal\n');
  writeFile(path.join(projectRoot, 'output', 'run', 'manifest.json'), '{}\n');
  writeFile(path.join(projectRoot, 'scripts', 'agent-eval-helper.js'), 'internal\n');
  writeFile(path.join(projectRoot, 'prompt_rev', 'draft.md'), 'internal\n');

  const result = buildPublicReleaseTree({ projectRoot, outDir });

  assert.ok(result.filesCopied > 0);
  assert.ok(existsSync(path.join(outDir, 'README.md')));
  assert.ok(existsSync(path.join(outDir, 'data', 'datasets', 'gemba-mqm-context-v1', 'runtime.json')));
  assert.ok(existsSync(path.join(outDir, 'docs', 'methodology.md')));
  assert.ok(existsSync(path.join(outDir, 'docs', 'assets', 'leaderboard.png')));
  assert.ok(existsSync(path.join(outDir, 'tests', 'index.js')));
  assert.deepEqual(readdirSync(path.join(outDir, 'reports')).sort(), requiredReports.sort());
  assert.equal(existsSync(path.join(outDir, '.env')), false);
  assert.equal(existsSync(path.join(outDir, '.agent')), false);
  assert.equal(existsSync(path.join(outDir, 'AGENTS.md')), false);
  assert.equal(existsSync(path.join(outDir, 'opencode.json')), false);
  assert.equal(existsSync(path.join(outDir, 'docs', 'superpowers')), false);
  assert.equal(existsSync(path.join(outDir, 'output')), false);
  assert.equal(existsSync(path.join(outDir, 'scripts', 'agent-eval-helper.js')), false);
  assert.equal(existsSync(path.join(outDir, 'prompt_rev')), false);
  assert.equal(existsSync(path.join(outDir, 'reports', 'internal.csv')), false);
  assert.doesNotMatch(readFileSync(path.join(outDir, '.env.example'), 'utf8'), /SECRET/);
});

test('buildPublicReleaseTree refuses unsafe output directories before deleting', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'public-release-tree-safe-outdir-'));
  const unsafeOutDirs = [
    path.join(projectRoot, 'output', 'public-release'),
    path.join(projectRoot, 'output', 'public-release2', 'fixture'),
    path.join(projectRoot, 'output', 'public-release', 'fixture', '..', '..'),
    path.join(projectRoot, 'outside-release'),
  ];

  for (const outDir of unsafeOutDirs) {
    assert.throws(
      () => buildPublicReleaseTree({ projectRoot, outDir }),
      /Refusing to delete outside output\/public-release/,
      outDir,
    );
  }
});

test('verify-public-release scans public scripts for generic sensitive values', () => {
  const publicRoot = mkdtempSync(path.join(tmpdir(), 'public-release-verify-script-secret-'));
  const credentialShapedToken = ['sk', 'x'.repeat(24)].join('-');

  writePublicVerifierFixture(publicRoot);
  writeFile(path.join(publicRoot, 'scripts', 'build-public-release.ts'), `const leaked = "${credentialShapedToken}";\n`);

  assert.match(capturePublicVerifierFailure(publicRoot), /Sensitive-looking pattern.*scripts[\\/]build-public-release\.ts/);
});

test('verify-public-release scans public tests for generic sensitive values', () => {
  const publicRoot = mkdtempSync(path.join(tmpdir(), 'public-release-verify-test-secret-'));
  const credentialShapedToken = ['sk', 'y'.repeat(24)].join('-');

  writePublicVerifierFixture(publicRoot);
  writeFile(path.join(publicRoot, 'tests', 'reporting.test.ts'), `const leaked = "${credentialShapedToken}";\n`);

  assert.match(capturePublicVerifierFailure(publicRoot), /Sensitive-looking pattern.*tests[\\/]reporting\.test\.ts/);
});

test('verify-public-release flags generic private-looking project ids', () => {
  const publicRoot = mkdtempSync(path.join(tmpdir(), 'public-release-verify-project-id-'));
  const privateLookingProjectId = ['project', '12345678', '1234', 'abcd', 'def'].join('-');

  writePublicVerifierFixture(publicRoot);
  writeFile(path.join(publicRoot, 'README.md'), `Cloud project: ${privateLookingProjectId}\n`);

  assert.match(capturePublicVerifierFailure(publicRoot), /Private pattern.*README\.md/);
});

test('verify-public-release flags generic local Windows user paths', () => {
  const publicRoot = mkdtempSync(path.join(tmpdir(), 'public-release-verify-windows-user-path-'));
  const separator = String.fromCharCode(92);
  const localUserPath = ['C:', 'Users', 'fixture-user', 'workspace'].join(separator);

  writePublicVerifierFixture(publicRoot);
  writeFile(path.join(publicRoot, 'README.md'), `Local path: ${localUserPath}\n`);

  assert.match(capturePublicVerifierFailure(publicRoot), /Private pattern.*README\.md/);
});

test('verify-public-release source uses generic private-leak patterns', () => {
  const verifierSource = readFileSync(path.join(repositoryRoot, 'scripts', 'verify-public-release.ts'), 'utf8');

  assert.match(verifierSource, /project-\[0-9a-f\]/);
  assert.match(verifierSource, /\[A-Za-z\]:\[\\\\\/\]/);
  assert.doesNotMatch(verifierSource, /literalPattern\(\[['"]project['"],\s*['"][0-9a-f]+/i);
  assert.doesNotMatch(verifierSource, /literalPattern\(\[['"]C:['"],\s*['"]Users['"],\s*['"][^'"]+/i);
});

test('public release tree tests do not include private-fragment reconstruction code', () => {
  const testSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');

  assert.doesNotMatch(testSource, /forbiddenFragments\s*=\s*\[/);
  assert.doesNotMatch(testSource, /\[[^\n\]]+\]\.join\(''\)/);
});

test('verify-public-release requires report artifacts to be files', () => {
  const publicRoot = mkdtempSync(path.join(tmpdir(), 'public-release-verify-report-file-'));
  const reportPath = path.join(publicRoot, 'reports', 'leaderboard.overall.csv');

  writePublicVerifierFixture(publicRoot);
  rmSync(reportPath, { force: true });
  mkdirSync(reportPath, { recursive: true });

  assert.match(capturePublicVerifierFailure(publicRoot), /Report artifact must be a file: reports[\\/]leaderboard\.overall\.csv/);
});
