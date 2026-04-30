import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { exportPublicReports } from '../src/public-report-export.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deterministicGeneratedAtUtc = '2026-04-30T00:00:00.000Z';

const reportNames = [
  'leaderboard.overall.csv',
  'leaderboard.by-language.csv',
  'leaderboard.by-context-expectation.csv',
  'context-behavior.csv',
  'cost-efficiency.csv',
  'run-summary.json',
];

interface FixtureRunOptions {
  runId: string;
  participants: Array<{
    participantId: string;
    displayName: string;
    provider: string;
    providerModelId: string;
  }>;
  summaryRows: Array<{
    participant_id: string;
    participant_display_name: string;
    mean_penalty: number;
  }>;
  benchmarkValid: boolean;
  reuseOnly?: boolean;
  unresolvedCells?: number;
  okCellsByParticipant: Record<string, number>;
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeFixtureRun(projectRoot: string, options: FixtureRunOptions): void {
  const runDir = path.join(projectRoot, 'output', options.runId);
  const reportsDir = path.join(runDir, 'reports');

  mkdirSync(reportsDir, { recursive: true });

  writeJson(path.join(runDir, 'manifest.json'), {
    manifestVersion: 3,
    runId: options.runId,
    benchmarkId: 'fixture-benchmark-v1',
    datasetVersion: 'fixture-dataset-v1',
    datasetKind: 'context',
    datasetFingerprintSha256: 'abc123fixturefingerprint',
    promptVersion: 'fixture-prompt-v1',
    promptFingerprintSha256: 'def456fixtureprompt',
    judgePromptVersion: 'fixture-judge-v1',
    judgePromptSetId: 'fixture-judge-v1',
    judgeBackend: 'vertex',
    judgeModelId: 'fixture-judge-model',
    targetLanguages: ['en', 'ja'],
    targetLanguageLabels: { en: 'English', ja: 'Japanese' },
    limitApplied: 1,
    participants: options.participants.map((participant) => ({
      ...participant,
      promptFile: '/private/local/simple-translation.md',
      promptFingerprintSha256: 'private-prompt-fingerprint',
    })),
    translationConcurrencyPerModel: 1,
    resume: false,
    vertexProject: 'private-cloud-project',
    vertexRegion: 'private-region',
  });

  const judgeFailureRatesByParticipantLanguage = Object.fromEntries(
    options.participants.flatMap((participant) => {
      const okCells = options.okCellsByParticipant[participant.participantId] ?? 0;
      return ['en', 'ja'].map((language, index) => [
        `${participant.participantId}::${language}`,
        { ok: index < okCells ? 1 : 0, failed: 0 },
      ]);
    }),
  );

  writeJson(path.join(reportsDir, 'run-status.json'), {
    benchmarkValid: options.benchmarkValid,
    ...(options.reuseOnly ? { reuseOnly: true } : {}),
    totalExpected: options.participants.length * 2,
    totalNormalized: Object.values(options.okCellsByParticipant).reduce((sum, count) => sum + count, 0),
    translationFailureHistoricalCount: options.unresolvedCells ?? 0,
    translationFailureUnresolvedCount: options.unresolvedCells ?? 0,
    judgeFailureRatesByParticipantLanguage,
  });

  writeJson(path.join(reportsDir, 'summary-overall.penalty.json'), options.summaryRows);
  writeJson(path.join(reportsDir, 'leaderboard.by-language.json'), {
    en: {
      leaderboard: options.summaryRows.map((row) => ({ ...row, samples: 1, failed_samples: 0 })),
      failures: [],
    },
    ja: {
      leaderboard: options.summaryRows.map((row) => ({ ...row, samples: row.participant_id.includes('deepl') ? 0 : 1, failed_samples: 0 })),
      failures: [],
    },
  });
  writeJson(path.join(reportsDir, 'leaderboard.by-context-expectation.json'), {
    use: options.summaryRows.map((row) => ({ ...row, samples: 1, failed_samples: 0 })),
    ignore: options.summaryRows.map((row) => ({ ...row, samples: row.participant_id.includes('deepl') ? 0 : 1, failed_samples: 0 })),
  });
  writeJson(path.join(reportsDir, 'context-behavior.counts.json'), Object.fromEntries(
    options.summaryRows.map((row) => [row.participant_id, {
      used_correctly: row.participant_id.includes('deepl') ? 1 : 2,
      missed_required_context: 0,
      ignored_irrelevant_context: 0,
      misused_context: 0,
      unclear: 0,
    }]),
  ));
  writeJson(path.join(reportsDir, 'context-behavior.rates.json'), Object.fromEntries(
    options.summaryRows.map((row) => [row.participant_id, {
      missed_required_context_rate: 0,
      misused_context_rate: 0,
    }]),
  ));
}

function sortedKeys(value: unknown): string[] {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));

  return Object.keys(value).sort();
}

test('exportPublicReports writes sanitized public report artifacts with sorted leaderboard and DeepL caveats', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'public-report-export-'));

  try {
    writeFixtureRun(projectRoot, {
      runId: 'main-run',
      participants: [
        { participantId: 'model-b', displayName: 'Model B', provider: 'fixture', providerModelId: 'model-b-provider' },
        { participantId: 'model-a', displayName: 'Model A', provider: 'fixture', providerModelId: 'model-a-provider' },
      ],
      summaryRows: [
        { participant_id: 'model-b', participant_display_name: 'Model B', mean_penalty: 2 },
        { participant_id: 'model-a', participant_display_name: 'Model A', mean_penalty: 1 },
      ],
      benchmarkValid: true,
      okCellsByParticipant: { 'model-a': 2, 'model-b': 2 },
    });

    writeFixtureRun(projectRoot, {
      runId: 'deepl-context-run',
      participants: [
        { participantId: 'deepl-api', displayName: 'DeepL API', provider: 'deepl', providerModelId: 'deepl-api' },
      ],
      summaryRows: [
        { participant_id: 'deepl-api', participant_display_name: 'DeepL API', mean_penalty: 4.9 },
      ],
      benchmarkValid: false,
      reuseOnly: true,
      unresolvedCells: 1,
      okCellsByParticipant: { 'deepl-api': 1 },
    });

    writeFixtureRun(projectRoot, {
      runId: 'deepl-nocontext-run',
      participants: [
        { participantId: 'deepl-api-nocontext', displayName: 'DeepL API (No context)', provider: 'deepl', providerModelId: 'deepl-api' },
      ],
      summaryRows: [
        { participant_id: 'deepl-api-nocontext', participant_display_name: 'DeepL API (No context)', mean_penalty: 5.7 },
      ],
      benchmarkValid: false,
      reuseOnly: true,
      unresolvedCells: 1,
      okCellsByParticipant: { 'deepl-api-nocontext': 1 },
    });

    const result = exportPublicReports({
      projectRoot,
      mainRunId: 'main-run',
      deeplContextRunId: 'deepl-context-run',
      deeplNoContextRunId: 'deepl-nocontext-run',
      generatedAtUtc: deterministicGeneratedAtUtc,
    });

    assert.deepEqual(result.files.map((filePath) => path.basename(filePath)).sort(), [...reportNames].sort());

    for (const reportName of reportNames) {
      assert.ok(result.files.includes(path.join(projectRoot, 'reports', reportName)), `${reportName} was not written`);
    }

    const overallCsv = readFileSync(path.join(projectRoot, 'reports', 'leaderboard.overall.csv'), 'utf8');
    const [header] = overallCsv.trim().split('\n');

    assert.equal(header, 'rank,participant_id,participant_display_name,mean_penalty,samples,benchmark_valid,caveat,source_run_id');
    assert.match(overallCsv, /^1,model-a,Model A,1\.000000,2,true,,main-run$/m);
    assert.match(
      overallCsv,
      /^3,deepl-api,DeepL API,4\.900000,1,false,"reuse-only partial row; 1\/2 valid cells; 1 unresolved cells",deepl-context-run$/m,
    );

    const runSummaryJson = readFileSync(path.join(projectRoot, 'reports', 'run-summary.json'), 'utf8');
    const runSummary = JSON.parse(runSummaryJson) as {
      benchmarkConfig?: string;
      sourceRuns?: Array<{ participantSet?: unknown[] }>;
    };
    const sourceRun = runSummary.sourceRuns?.[0];
    const sourceRunParticipant = sourceRun?.participantSet?.[0];

    assert.equal(runSummary.benchmarkConfig, 'data/benchmarks/fixture-benchmark-v1.json');
    assert.deepEqual(sortedKeys(sourceRun), [
      'benchmarkConfig',
      'benchmarkId',
      'datasetFingerprintSha256',
      'datasetKind',
      'datasetVersion',
      'judgeBackend',
      'judgeModelId',
      'judgePromptSetId',
      'judgePromptVersion',
      'limitApplied',
      'participantSampleCounts',
      'participantSet',
      'promptFingerprintSha256',
      'promptVersion',
      'runId',
      'runStatus',
      'targetLanguageLabels',
      'targetLanguages',
    ].sort());
    assert.deepEqual(sortedKeys(sourceRunParticipant), [
      'displayName',
      'participantId',
      'provider',
      'providerModelId',
    ].sort());
    assert.doesNotMatch(runSummaryJson, /private|promptFile|vertexProject|[A-Za-z]:\\|\/private\//);

    const byLanguageCsv = readFileSync(path.join(projectRoot, 'reports', 'leaderboard.by-language.csv'), 'utf8');
    assert.match(byLanguageCsv, /^en,1,model-a,Model A,1\.000000,1,0,true,,main-run$/m);
    assert.doesNotMatch(overallCsv, /1\.000000,2\.000000,true/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('exportPublicReports prefixes dangerous CSV string cells while leaving numeric columns formatted', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'public-report-export-formula-'));

  try {
    writeFixtureRun(projectRoot, {
      runId: '=formula-run',
      participants: [
        { participantId: 'formula-equals', displayName: '=Formula', provider: 'fixture', providerModelId: 'formula-equals-provider' },
        { participantId: 'formula-plus', displayName: '+Formula', provider: 'fixture', providerModelId: 'formula-plus-provider' },
        { participantId: 'formula-minus', displayName: '-Formula', provider: 'fixture', providerModelId: 'formula-minus-provider' },
        { participantId: 'formula-at', displayName: '@Formula', provider: 'fixture', providerModelId: 'formula-at-provider' },
        { participantId: 'formula-tab', displayName: '\tFormula', provider: 'fixture', providerModelId: 'formula-tab-provider' },
        { participantId: 'formula-cr', displayName: '\rFormula', provider: 'fixture', providerModelId: 'formula-cr-provider' },
        { participantId: 'formula-lf', displayName: '\nFormula', provider: 'fixture', providerModelId: 'formula-lf-provider' },
      ],
      summaryRows: [
        { participant_id: 'formula-equals', participant_display_name: '=Formula', mean_penalty: 1 },
        { participant_id: 'formula-plus', participant_display_name: '+Formula', mean_penalty: 2 },
        { participant_id: 'formula-minus', participant_display_name: '-Formula', mean_penalty: 3 },
        { participant_id: 'formula-at', participant_display_name: '@Formula', mean_penalty: 4 },
        { participant_id: 'formula-tab', participant_display_name: '\tFormula', mean_penalty: 5 },
        { participant_id: 'formula-cr', participant_display_name: '\rFormula', mean_penalty: 6 },
        { participant_id: 'formula-lf', participant_display_name: '\nFormula', mean_penalty: 7 },
      ],
      benchmarkValid: true,
      okCellsByParticipant: {
        'formula-equals': 2,
        'formula-plus': 2,
        'formula-minus': 2,
        'formula-at': 2,
        'formula-tab': 2,
        'formula-cr': 2,
        'formula-lf': 2,
      },
    });

    exportPublicReports({
      projectRoot,
      mainRunId: '=formula-run',
      generatedAtUtc: deterministicGeneratedAtUtc,
    });

    const overallCsv = readFileSync(path.join(projectRoot, 'reports', 'leaderboard.overall.csv'), 'utf8');

    assert.match(overallCsv, /formula-equals,'=Formula,1\.000000,2,true,,'=formula-run/);
    assert.match(overallCsv, /formula-plus,'\+Formula,2\.000000,2,true,,'=formula-run/);
    assert.match(overallCsv, /formula-minus,'-Formula,3\.000000,2,true,,'=formula-run/);
    assert.match(overallCsv, /formula-at,'@Formula,4\.000000,2,true,,'=formula-run/);
    assert.match(overallCsv, /formula-tab,'\tFormula,5\.000000,2,true,,'=formula-run/);
    assert.ok(overallCsv.includes(`formula-cr,"'\rFormula",6.000000,2,true,,'=formula-run`));
    assert.ok(overallCsv.includes(`formula-lf,"'\nFormula",7.000000,2,true,,'=formula-run`));
    assert.doesNotMatch(overallCsv, /,2\.000000,true/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('exportPublicReports writes plan-required cost efficiency metrics', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'public-report-export-cost-'));

  try {
    writeFixtureRun(projectRoot, {
      runId: 'main-run',
      participants: [
        { participantId: 'qwen-3.5-plus', displayName: 'Qwen 3.5 Plus', provider: 'qwen', providerModelId: 'qwen3.5-plus' },
        { participantId: 'qwen-3.5-flash', displayName: 'Qwen 3.5 Flash', provider: 'qwen', providerModelId: 'qwen3.5-flash' },
      ],
      summaryRows: [
        { participant_id: 'qwen-3.5-plus', participant_display_name: 'Qwen 3.5 Plus', mean_penalty: 1 },
        { participant_id: 'qwen-3.5-flash', participant_display_name: 'Qwen 3.5 Flash', mean_penalty: 2 },
      ],
      benchmarkValid: true,
      okCellsByParticipant: { 'qwen-3.5-plus': 2, 'qwen-3.5-flash': 2 },
    });

    exportPublicReports({
      projectRoot,
      mainRunId: 'main-run',
      generatedAtUtc: deterministicGeneratedAtUtc,
    });

    const costCsv = readFileSync(path.join(projectRoot, 'reports', 'cost-efficiency.csv'), 'utf8');
    const [header] = costCsv.trim().split('\n');

    assert.equal(
      header,
      'participant_id,participant_display_name,mean_penalty,cost_per_1k_app_translations_usd,translations_per_usd,translations_per_0_07_usd,translations_per_0_08_usd,translations_per_0_10_usd,quality_weighted_cost,value_index,source_run_id,provenance,note',
    );
    assert.match(
      costCsv,
      /^qwen-3\.5-plus,Qwen 3\.5 Plus,1\.000000,0\.141900,7047\.216350,493\.305144,563\.777308,704\.721635,0\.141900,100\.000000,main-run,/m,
    );
    assert.match(
      costCsv,
      /^qwen-3\.5-flash,Qwen 3\.5 Flash,2\.000000,0\.037100,26954\.177898,1886\.792453,2156\.334232,2695\.417790,0\.148400,95\.619946,main-run,/m,
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('export-public-reports CLI has deterministic generatedAtUtc by default and accepts an override', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'public-report-export-cli-'));

  try {
    writeFixtureRun(projectRoot, {
      runId: 'main-run',
      participants: [
        { participantId: 'model-a', displayName: 'Model A', provider: 'fixture', providerModelId: 'model-a-provider' },
      ],
      summaryRows: [
        { participant_id: 'model-a', participant_display_name: 'Model A', mean_penalty: 1 },
      ],
      benchmarkValid: true,
      okCellsByParticipant: { 'model-a': 2 },
    });
    writeFixtureRun(projectRoot, {
      runId: 'deepl-context-run',
      participants: [
        { participantId: 'deepl-api', displayName: 'DeepL API', provider: 'deepl', providerModelId: 'deepl-api' },
      ],
      summaryRows: [
        { participant_id: 'deepl-api', participant_display_name: 'DeepL API', mean_penalty: 4.9 },
      ],
      benchmarkValid: false,
      reuseOnly: true,
      unresolvedCells: 1,
      okCellsByParticipant: { 'deepl-api': 1 },
    });
    writeFixtureRun(projectRoot, {
      runId: 'deepl-nocontext-run',
      participants: [
        { participantId: 'deepl-api-nocontext', displayName: 'DeepL API (No context)', provider: 'deepl', providerModelId: 'deepl-api' },
      ],
      summaryRows: [
        { participant_id: 'deepl-api-nocontext', participant_display_name: 'DeepL API (No context)', mean_penalty: 5.7 },
      ],
      benchmarkValid: false,
      reuseOnly: true,
      unresolvedCells: 1,
      okCellsByParticipant: { 'deepl-api-nocontext': 1 },
    });

    const commonArgs = [
      '--output-root', path.join(projectRoot, 'output'),
      '--main-run-id', 'main-run',
      '--deepl-context-run-id', 'deepl-context-run',
      '--deepl-nocontext-run-id', 'deepl-nocontext-run',
    ];
    const defaultReportsDir = path.join(projectRoot, 'reports-default');
    execFileSync(process.execPath, [
      '--import', 'tsx', 'scripts/export-public-reports.ts',
      ...commonArgs,
      '--reports-dir', defaultReportsDir,
    ], { cwd: repositoryRoot });

    const defaultSummary = JSON.parse(readFileSync(path.join(defaultReportsDir, 'run-summary.json'), 'utf8')) as { generatedAtUtc?: string };
    assert.equal(defaultSummary.generatedAtUtc, deterministicGeneratedAtUtc);

    const overrideReportsDir = path.join(projectRoot, 'reports-override');
    execFileSync(process.execPath, [
      '--import', 'tsx', 'scripts/export-public-reports.ts',
      ...commonArgs,
      '--reports-dir', overrideReportsDir,
      '--generated-at-utc', '2026-05-01T12:34:56.000Z',
    ], { cwd: repositoryRoot });

    const overrideSummary = JSON.parse(readFileSync(path.join(overrideReportsDir, 'run-summary.json'), 'utf8')) as { generatedAtUtc?: string };
    assert.equal(overrideSummary.generatedAtUtc, '2026-05-01T12:34:56.000Z');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
