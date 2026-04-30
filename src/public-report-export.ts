import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface PenaltySummaryRow {
  participant_id: string;
  participant_display_name: string;
  mean_penalty: number | null;
}

export interface SliceLeaderboardRow extends PenaltySummaryRow {
  samples: number;
  failed_samples: number;
}

export interface SanitizedManifestParticipant {
  participantId: string;
  displayName: string;
  provider: string;
  providerModelId: string;
}

export interface RunManifestPublicFields {
  runId: string;
  benchmarkId: string;
  datasetVersion: string;
  datasetKind?: string;
  datasetFingerprintSha256: string;
  promptVersion: string;
  promptFingerprintSha256?: string;
  judgePromptVersion?: string;
  judgePromptSetId?: string;
  judgeBackend: string;
  judgeModelId: string | null;
  targetLanguages: string[];
  targetLanguageLabels?: Record<string, string>;
  limitApplied?: number;
  participants: SanitizedManifestParticipant[];
}

export interface RunStatusPublicFields {
  benchmarkValid: boolean;
  reuseOnly?: boolean;
  benchmarkValidityNote?: string;
  totalExpected?: number;
  totalNormalized?: number;
  translationFailureHistoricalCount?: number;
  translationFailureUnresolvedCount?: number;
  missingDeepLKeys?: string[];
  judgeFailureRatesByParticipantLanguage?: Record<string, {
    ok?: number;
    failed?: number;
  }>;
}

export interface PublicOverallRow {
  rank: number;
  participant_id: string;
  participant_display_name: string;
  mean_penalty: number | null;
  samples: number;
  benchmark_valid: boolean;
  caveat: string;
  source_run_id: string;
}

export interface ExportPublicReportsOptions {
  projectRoot: string;
  outputRoot?: string;
  reportsDir?: string;
  mainRunId: string;
  deeplContextRunId?: string;
  deeplNoContextRunId?: string;
  generatedAtUtc?: string;
}

export interface ExportPublicReportsResult {
  reportsDir: string;
  files: string[];
}

const REPORT_FILE_NAMES = [
  'leaderboard.overall.csv',
  'leaderboard.by-language.csv',
  'leaderboard.by-context-expectation.csv',
  'context-behavior.csv',
  'run-summary.json',
] as const;

export const FIXED_DECIMAL_COLUMNS = new Set([
  'mean_penalty',
  'missed_required_context_rate',
  'misused_context_rate',
]);

const FORCE_QUOTE_COLUMNS = new Set(['caveat', 'provenance']);
const CSV_FORMULA_TRIGGER_PATTERN = /^[=+\-@\t\r\n]/;

interface LoadedRun {
  runId: string;
  runDir: string;
  reportsDir: string;
  manifest: RunManifestPublicFields;
  status: RunStatusPublicFields;
  participantsById: Map<string, SanitizedManifestParticipant>;
}

interface PublicScoredRow {
  participant_id: string;
  participant_display_name: string;
  mean_penalty: number | null;
  samples: number;
  failed_samples?: number;
  benchmark_valid: boolean;
  caveat: string;
  source_run_id: string;
}

type CsvCell = string | number | boolean | null | undefined;
type CsvRow = Record<string, CsvCell>;

function resolveProjectPath(projectRoot: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeParticipant(value: unknown): SanitizedManifestParticipant | null {
  if (!isRecord(value)) {
    return null;
  }

  const participantId = asString(value.participantId);

  if (participantId.length === 0) {
    return null;
  }

  return {
    participantId,
    displayName: asString(value.displayName, participantId),
    provider: asString(value.provider),
    providerModelId: asString(value.providerModelId),
  };
}

function sanitizeManifest(raw: unknown, fallbackRunId: string): RunManifestPublicFields {
  if (!isRecord(raw)) {
    throw new Error(`Run manifest for ${fallbackRunId} must be an object`);
  }

  const participants = Array.isArray(raw.participants)
    ? raw.participants.map(sanitizeParticipant).filter((participant): participant is SanitizedManifestParticipant => participant !== null)
    : [];

  return {
    runId: asString(raw.runId, fallbackRunId),
    benchmarkId: asString(raw.benchmarkId),
    datasetVersion: asString(raw.datasetVersion),
    datasetKind: asOptionalString(raw.datasetKind),
    datasetFingerprintSha256: asString(raw.datasetFingerprintSha256),
    promptVersion: asString(raw.promptVersion),
    promptFingerprintSha256: asOptionalString(raw.promptFingerprintSha256),
    judgePromptVersion: asOptionalString(raw.judgePromptVersion),
    judgePromptSetId: asOptionalString(raw.judgePromptSetId),
    judgeBackend: asString(raw.judgeBackend),
    judgeModelId: raw.judgeModelId === null ? null : asString(raw.judgeModelId),
    targetLanguages: Array.isArray(raw.targetLanguages) ? raw.targetLanguages.map((item) => asString(item)).filter(Boolean) : [],
    targetLanguageLabels: isRecord(raw.targetLanguageLabels)
      ? Object.fromEntries(Object.entries(raw.targetLanguageLabels).map(([key, value]) => [key, asString(value)]))
      : undefined,
    limitApplied: asOptionalNumber(raw.limitApplied),
    participants,
  };
}

function sanitizeRunStatus(raw: unknown): RunStatusPublicFields {
  if (!isRecord(raw)) {
    throw new Error('Run status must be an object');
  }

  const judgeFailureRatesByParticipantLanguage = isRecord(raw.judgeFailureRatesByParticipantLanguage)
    ? Object.fromEntries(
      Object.entries(raw.judgeFailureRatesByParticipantLanguage)
        .filter(([, value]) => isRecord(value))
        .map(([key, value]) => [key, {
          ok: asOptionalNumber((value as Record<string, unknown>).ok),
          failed: asOptionalNumber((value as Record<string, unknown>).failed),
        }]),
    )
    : undefined;

  return {
    benchmarkValid: raw.benchmarkValid === true,
    reuseOnly: raw.reuseOnly === undefined ? undefined : raw.reuseOnly === true,
    benchmarkValidityNote: asOptionalString(raw.benchmarkValidityNote),
    totalExpected: asOptionalNumber(raw.totalExpected),
    totalNormalized: asOptionalNumber(raw.totalNormalized),
    translationFailureHistoricalCount: asOptionalNumber(raw.translationFailureHistoricalCount),
    translationFailureUnresolvedCount: asOptionalNumber(raw.translationFailureUnresolvedCount),
    missingDeepLKeys: Array.isArray(raw.missingDeepLKeys)
      ? raw.missingDeepLKeys.map((item) => asString(item)).filter(Boolean)
      : undefined,
    judgeFailureRatesByParticipantLanguage,
  };
}

function loadRun(outputRoot: string, runId: string): LoadedRun {
  const runDir = path.join(outputRoot, runId);
  const reportsDir = path.join(runDir, 'reports');
  const manifest = sanitizeManifest(readJson(path.join(runDir, 'manifest.json')), runId);
  const status = sanitizeRunStatus(readJson(path.join(reportsDir, 'run-status.json')));
  const participantsById = new Map(manifest.participants.map((participant) => [participant.participantId, participant]));

  return {
    runId: manifest.runId || runId,
    runDir,
    reportsDir,
    manifest,
    status,
    participantsById,
  };
}

function readPenaltyRows(run: LoadedRun): PenaltySummaryRow[] {
  const rows = readJson<unknown>(path.join(run.reportsDir, 'summary-overall.penalty.json'));

  if (!Array.isArray(rows)) {
    throw new Error(`summary-overall.penalty.json for ${run.runId} must be an array`);
  }

  return rows.map((row) => {
    if (!isRecord(row)) {
      throw new Error(`Penalty summary row for ${run.runId} must be an object`);
    }

    return {
      participant_id: asString(row.participant_id),
      participant_display_name: asString(row.participant_display_name, asString(row.participant_id)),
      mean_penalty: row.mean_penalty === null ? null : asOptionalNumber(row.mean_penalty) ?? null,
    };
  });
}

function readByLanguage(run: LoadedRun): Record<string, SliceLeaderboardRow[]> {
  const raw = readJson<unknown>(path.join(run.reportsDir, 'leaderboard.by-language.json'));

  if (!isRecord(raw)) {
    throw new Error(`leaderboard.by-language.json for ${run.runId} must be an object`);
  }

  return Object.fromEntries(
    Object.entries(raw).map(([language, value]) => [language, normalizeSliceRows(value)]),
  );
}

function readByContextExpectation(run: LoadedRun): Record<string, SliceLeaderboardRow[]> {
  const raw = readJson<unknown>(path.join(run.reportsDir, 'leaderboard.by-context-expectation.json'));

  if (!isRecord(raw)) {
    throw new Error(`leaderboard.by-context-expectation.json for ${run.runId} must be an object`);
  }

  return Object.fromEntries(
    Object.entries(raw).map(([contextExpectation, value]) => [contextExpectation, normalizeSliceRows(value)]),
  );
}

function normalizeSliceRows(value: unknown): SliceLeaderboardRow[] {
  const rawRows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.leaderboard)
      ? value.leaderboard
      : [];

  return rawRows.map((row) => {
    if (!isRecord(row)) {
      throw new Error('Slice leaderboard row must be an object');
    }

    return {
      participant_id: asString(row.participant_id),
      participant_display_name: asString(row.participant_display_name, asString(row.participant_id)),
      mean_penalty: row.mean_penalty === null ? null : asOptionalNumber(row.mean_penalty) ?? null,
      samples: asOptionalNumber(row.samples) ?? 0,
      failed_samples: asOptionalNumber(row.failed_samples) ?? 0,
    };
  });
}

function participantValidSamples(run: LoadedRun, participantId: string): number {
  return participantLanguageCounts(run, participantId).reduce((sum, counts) => sum + (counts.ok ?? 0), 0);
}

function participantFailedSamples(run: LoadedRun, participantId: string): number {
  return participantLanguageCounts(run, participantId).reduce((sum, counts) => sum + (counts.failed ?? 0), 0);
}

function participantLanguageCounts(run: LoadedRun, participantId: string): Array<{ ok?: number; failed?: number }> {
  const rates = run.status.judgeFailureRatesByParticipantLanguage ?? {};
  const prefix = `${participantId}::`;

  return Object.entries(rates)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, counts]) => counts);
}

function participantExpectedSamples(run: LoadedRun, participantId: string): number {
  const manifestExpected = run.manifest.limitApplied !== undefined && run.manifest.targetLanguages.length > 0
    ? run.manifest.limitApplied * run.manifest.targetLanguages.length
    : undefined;

  if (manifestExpected !== undefined) {
    return manifestExpected;
  }

  const valid = participantValidSamples(run, participantId);
  const failed = participantFailedSamples(run, participantId);
  const unresolved = participantUnresolvedSamples(run, participantId);

  return valid + failed + unresolved;
}

function participantUnresolvedSamples(run: LoadedRun, participantId: string): number {
  const unresolved = run.status.translationFailureUnresolvedCount;

  if (unresolved !== undefined && isDeepLParticipant(run, participantId)) {
    return unresolved;
  }

  const expected = run.manifest.limitApplied !== undefined && run.manifest.targetLanguages.length > 0
    ? run.manifest.limitApplied * run.manifest.targetLanguages.length
    : undefined;

  if (expected === undefined) {
    return 0;
  }

  return Math.max(0, expected - participantValidSamples(run, participantId) - participantFailedSamples(run, participantId));
}

function isDeepLParticipant(run: LoadedRun, participantId: string): boolean {
  return run.participantsById.get(participantId)?.provider === 'deepl' || participantId.startsWith('deepl-');
}

function participantDisplayName(run: LoadedRun, row: PenaltySummaryRow): string {
  return run.participantsById.get(row.participant_id)?.displayName || row.participant_display_name || row.participant_id;
}

function caveatFor(run: LoadedRun, participantId: string): string {
  if (!run.status.benchmarkValid && run.status.reuseOnly === true) {
    const valid = participantValidSamples(run, participantId);
    const expected = participantExpectedSamples(run, participantId);
    const unresolved = participantUnresolvedSamples(run, participantId);

    return `reuse-only partial row; ${valid}/${expected} valid cells; ${unresolved} unresolved cells`;
  }

  if (!run.status.benchmarkValid && run.status.benchmarkValidityNote) {
    return run.status.benchmarkValidityNote;
  }

  return '';
}

function scoredRowFromPenalty(run: LoadedRun, row: PenaltySummaryRow): PublicScoredRow {
  return {
    participant_id: row.participant_id,
    participant_display_name: participantDisplayName(run, row),
    mean_penalty: row.mean_penalty,
    samples: participantValidSamples(run, row.participant_id),
    failed_samples: participantFailedSamples(run, row.participant_id),
    benchmark_valid: run.status.benchmarkValid,
    caveat: caveatFor(run, row.participant_id),
    source_run_id: run.runId,
  };
}

function withRanks(rows: PublicScoredRow[]): PublicOverallRow[] {
  return sortByMeanPenalty(rows).map((row, index) => ({
    rank: index + 1,
    participant_id: row.participant_id,
    participant_display_name: row.participant_display_name,
    mean_penalty: row.mean_penalty,
    samples: row.samples,
    benchmark_valid: row.benchmark_valid,
    caveat: row.caveat,
    source_run_id: row.source_run_id,
  }));
}

function sortByMeanPenalty<T extends { mean_penalty: number | null; participant_id: string }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    if (left.mean_penalty === null && right.mean_penalty === null) {
      return left.participant_id.localeCompare(right.participant_id);
    }

    if (left.mean_penalty === null) {
      return 1;
    }

    if (right.mean_penalty === null) {
      return -1;
    }

    return left.mean_penalty - right.mean_penalty || left.participant_id.localeCompare(right.participant_id);
  });
}

function buildOverallRows(mainRun: LoadedRun, deeplRuns: LoadedRun[]): PublicOverallRow[] {
  const rows = readPenaltyRows(mainRun).map((row) => scoredRowFromPenalty(mainRun, row));

  for (const deeplRun of deeplRuns) {
    rows.push(...readPenaltyRows(deeplRun)
      .filter((row) => isDeepLParticipant(deeplRun, row.participant_id))
      .map((row) => scoredRowFromPenalty(deeplRun, row)));
  }

  return withRanks(rows);
}

function buildSliceCsvRows(
  mainRun: LoadedRun,
  deeplRuns: LoadedRun[],
  readSlices: (run: LoadedRun) => Record<string, SliceLeaderboardRow[]>,
  sliceColumn: string,
): CsvRow[] {
  const groupedRows = new Map<string, PublicScoredRow[]>();

  function appendRun(run: LoadedRun, deeplOnly: boolean): void {
    const slices = readSlices(run);

    for (const [slice, rows] of Object.entries(slices)) {
      const sliceRows = groupedRows.get(slice) ?? [];

      sliceRows.push(...rows
        .filter((row) => !deeplOnly || isDeepLParticipant(run, row.participant_id))
        .map((row) => ({
          participant_id: row.participant_id,
          participant_display_name: participantDisplayName(run, row),
          mean_penalty: row.mean_penalty,
          samples: row.samples,
          failed_samples: row.failed_samples,
          benchmark_valid: run.status.benchmarkValid,
          caveat: caveatFor(run, row.participant_id),
          source_run_id: run.runId,
        })));
      groupedRows.set(slice, sliceRows);
    }
  }

  appendRun(mainRun, false);
  deeplRuns.forEach((run) => appendRun(run, true));

  return [...groupedRows.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .flatMap(([slice, rows]) => sortByMeanPenalty(rows).map((row, index) => ({
      [sliceColumn]: slice,
      rank: index + 1,
      participant_id: row.participant_id,
      participant_display_name: row.participant_display_name,
      mean_penalty: row.mean_penalty,
      samples: row.samples,
      failed_samples: row.failed_samples,
      benchmark_valid: row.benchmark_valid,
      caveat: row.caveat,
      source_run_id: row.source_run_id,
    })));
}

function buildContextBehaviorRows(mainRun: LoadedRun, deeplRuns: LoadedRun[]): CsvRow[] {
  function rowsForRun(run: LoadedRun, deeplOnly: boolean): CsvRow[] {
    const counts = readJson<Record<string, Record<string, number>>>(path.join(run.reportsDir, 'context-behavior.counts.json'));
    const rates = readJson<Record<string, Record<string, number>>>(path.join(run.reportsDir, 'context-behavior.rates.json'));
    const participantIds = [...new Set([...Object.keys(counts), ...Object.keys(rates)])]
      .filter((participantId) => !deeplOnly || isDeepLParticipant(run, participantId));

    return participantIds.sort().map((participantId) => {
      const participantCounts = counts[participantId] ?? {};
      const participantRates = rates[participantId] ?? {};
      const usedCorrectly = participantCounts.used_correctly ?? 0;
      const missedRequiredContext = participantCounts.missed_required_context ?? 0;
      const ignoredIrrelevantContext = participantCounts.ignored_irrelevant_context ?? 0;
      const misusedContext = participantCounts.misused_context ?? 0;
      const unclear = participantCounts.unclear ?? 0;
      const samples = usedCorrectly + missedRequiredContext + ignoredIrrelevantContext + misusedContext + unclear;

      return {
        participant_id: participantId,
        participant_display_name: run.participantsById.get(participantId)?.displayName ?? participantId,
        used_correctly: usedCorrectly,
        missed_required_context: missedRequiredContext,
        ignored_irrelevant_context: ignoredIrrelevantContext,
        misused_context: misusedContext,
        unclear,
        missed_required_context_rate: participantRates.missed_required_context_rate ?? 0,
        misused_context_rate: participantRates.misused_context_rate ?? 0,
        samples,
        benchmark_valid: run.status.benchmarkValid,
        caveat: caveatFor(run, participantId),
        source_run_id: run.runId,
      };
    });
  }

  return [
    ...rowsForRun(mainRun, false),
    ...deeplRuns.flatMap((run) => rowsForRun(run, true)),
  ];
}

function formatCsvCell(column: string, value: CsvCell): string {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return '';
    }

    return FIXED_DECIMAL_COLUMNS.has(column) ? value.toFixed(6) : String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  const text = CSV_FORMULA_TRIGGER_PATTERN.test(value) ? `'${value}` : value;
  const shouldQuote = text.length > 0 && (FORCE_QUOTE_COLUMNS.has(column) || /[",\r\n]/.test(text));

  if (!shouldQuote) {
    return text;
  }

  return `"${text.replaceAll('"', '""')}"`;
}

function writeCsv<T extends object>(filePath: string, columns: string[], rows: T[]): void {
  const lines = [
    columns.join(','),
    ...rows.map((row) => {
      const cells = row as Record<string, CsvCell>;

      return columns.map((column) => formatCsvCell(column, cells[column])).join(',');
    }),
  ];

  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function buildParticipantSampleCounts(run: LoadedRun): Array<{
  participantId: string;
  validSamples: number;
  expectedSamples: number;
  unresolvedCells: number;
}> {
  return run.manifest.participants.map((participant) => ({
    participantId: participant.participantId,
    validSamples: participantValidSamples(run, participant.participantId),
    expectedSamples: participantExpectedSamples(run, participant.participantId),
    unresolvedCells: participantUnresolvedSamples(run, participant.participantId),
  }));
}

function benchmarkConfigPathForBenchmarkId(benchmarkId: string): string {
  return `data/benchmarks/${benchmarkId}.json`;
}

function buildRunSummary(
  generatedAtUtc: string,
  mainRun: LoadedRun,
  deeplRuns: LoadedRun[],
  overallRows: PublicOverallRow[],
): unknown {
  const benchmarkConfig = benchmarkConfigPathForBenchmarkId(mainRun.manifest.benchmarkId);
  const sourceRuns = [mainRun, ...deeplRuns].map((run) => ({
    runId: run.runId,
    benchmarkConfig: benchmarkConfigPathForBenchmarkId(run.manifest.benchmarkId),
    benchmarkId: run.manifest.benchmarkId,
    datasetVersion: run.manifest.datasetVersion,
    datasetKind: run.manifest.datasetKind,
    datasetFingerprintSha256: run.manifest.datasetFingerprintSha256,
    promptVersion: run.manifest.promptVersion,
    promptFingerprintSha256: run.manifest.promptFingerprintSha256,
    judgePromptVersion: run.manifest.judgePromptVersion,
    judgePromptSetId: run.manifest.judgePromptSetId,
    judgeBackend: run.manifest.judgeBackend,
    judgeModelId: run.manifest.judgeModelId,
    targetLanguages: run.manifest.targetLanguages,
    targetLanguageLabels: run.manifest.targetLanguageLabels,
    limitApplied: run.manifest.limitApplied,
    participantSet: run.manifest.participants,
    runStatus: {
      benchmarkValid: run.status.benchmarkValid,
      reuseOnly: run.status.reuseOnly,
      benchmarkValidityNote: run.status.benchmarkValidityNote,
      totalExpected: run.status.totalExpected,
      totalNormalized: run.status.totalNormalized,
      translationFailureHistoricalCount: run.status.translationFailureHistoricalCount,
      translationFailureUnresolvedCount: run.status.translationFailureUnresolvedCount,
      missingDeepLKeys: run.status.missingDeepLKeys,
    },
    participantSampleCounts: buildParticipantSampleCounts(run),
  }));

  return {
    generatedAtUtc,
    reportVersion: 1,
    benchmarkConfig,
    publicReports: REPORT_FILE_NAMES,
    primaryScore: {
      metric: 'raw mean penalty',
      lowerIsBetter: true,
    },
    sourceRuns,
    leaderboard: overallRows.map((row) => ({
      rank: row.rank,
      participantId: row.participant_id,
      displayName: row.participant_display_name,
      meanPenalty: row.mean_penalty,
      samples: row.samples,
      benchmarkValid: row.benchmark_valid,
      caveat: row.caveat,
      sourceRunId: row.source_run_id,
    })),
    caveats: [
      'Raw mean penalty is the primary score; lower is better.',
      'DeepL rows are reuse-only partial rows with missing cells and are marked benchmark_valid=false.',
      'Full reruns require paid APIs, credentials, and the configured judge backend/model.',
    ],
  };
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function exportPublicReports(options: ExportPublicReportsOptions): ExportPublicReportsResult {
  const projectRoot = path.resolve(options.projectRoot);
  const outputRoot = resolveProjectPath(projectRoot, options.outputRoot ?? 'output');
  const reportsDir = resolveProjectPath(projectRoot, options.reportsDir ?? 'reports');
  const generatedAtUtc = options.generatedAtUtc ?? new Date().toISOString();

  mkdirSync(reportsDir, { recursive: true });
  rmSync(path.join(reportsDir, 'cost-efficiency.csv'), { force: true });

  const mainRun = loadRun(outputRoot, options.mainRunId);
  const deeplRuns = [options.deeplContextRunId, options.deeplNoContextRunId]
    .filter((runId): runId is string => typeof runId === 'string' && runId.length > 0)
    .map((runId) => loadRun(outputRoot, runId));
  const overallRows = buildOverallRows(mainRun, deeplRuns);
  const files: string[] = [];

  const overallPath = path.join(reportsDir, 'leaderboard.overall.csv');
  writeCsv(
    overallPath,
    ['rank', 'participant_id', 'participant_display_name', 'mean_penalty', 'samples', 'benchmark_valid', 'caveat', 'source_run_id'],
    overallRows,
  );
  files.push(overallPath);

  const byLanguagePath = path.join(reportsDir, 'leaderboard.by-language.csv');
  writeCsv(
    byLanguagePath,
    ['language', 'rank', 'participant_id', 'participant_display_name', 'mean_penalty', 'samples', 'failed_samples', 'benchmark_valid', 'caveat', 'source_run_id'],
    buildSliceCsvRows(mainRun, deeplRuns, readByLanguage, 'language'),
  );
  files.push(byLanguagePath);

  const byContextExpectationPath = path.join(reportsDir, 'leaderboard.by-context-expectation.csv');
  writeCsv(
    byContextExpectationPath,
    ['context_expectation', 'rank', 'participant_id', 'participant_display_name', 'mean_penalty', 'samples', 'failed_samples', 'benchmark_valid', 'caveat', 'source_run_id'],
    buildSliceCsvRows(mainRun, deeplRuns, readByContextExpectation, 'context_expectation'),
  );
  files.push(byContextExpectationPath);

  const contextBehaviorPath = path.join(reportsDir, 'context-behavior.csv');
  writeCsv(
    contextBehaviorPath,
    ['participant_id', 'participant_display_name', 'used_correctly', 'missed_required_context', 'ignored_irrelevant_context', 'misused_context', 'unclear', 'missed_required_context_rate', 'misused_context_rate', 'samples', 'benchmark_valid', 'caveat', 'source_run_id'],
    buildContextBehaviorRows(mainRun, deeplRuns),
  );
  files.push(contextBehaviorPath);

  const runSummaryPath = path.join(reportsDir, 'run-summary.json');
  writeJson(runSummaryPath, buildRunSummary(generatedAtUtc, mainRun, deeplRuns, overallRows));
  files.push(runSummaryPath);

  return { reportsDir, files };
}
