export interface PenaltySummaryRow {
  participant_id: string;
  participant_display_name: string;
  mean_penalty: number | null;
}

export interface SlideReadyRankingBarRow {
  kind: 'bar';
  participantId: string;
  label: string;
  meanPenalty: number;
  group: 'llm' | 'commercial';
  fill: string;
}

export interface SlideReadyRankingEllipsisRow {
  kind: 'ellipsis';
  label: string;
}

export type SlideReadyRankingRow = SlideReadyRankingBarRow | SlideReadyRankingEllipsisRow;

interface RenderSlideReadyRankingChartOptions {
  rows: readonly SlideReadyRankingRow[];
  title?: string;
  subtitle?: string;
  footnote?: string;
}

interface RunStatusJudgeCounts {
  ok: number;
  failed: number;
}

const TITLE = 'LLMs outperform commercial translation services on context-heavy translation';
const SUBTITLE = 'Raw mean MQM penalty (lower is better)';
const ELLIPSIS_LABEL = '… omitted models …';
const LLM_FILL = '#3b82f6';
const DEEPL_CONTEXT_FILL = '#15803d';
const DEEPL_NOCONTEXT_FILL = '#86efac';
const GOOGLE_FILL = '#94a3b8';
const COMMERCIAL_IDS = new Set(['deepl-api', 'deepl-api-nocontext', 'google-cloud-translate-basic', 'papago-web']);
const DEEPL_IDS = ['deepl-api', 'deepl-api-nocontext'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePenaltySummaryRow(value: unknown, index: number): PenaltySummaryRow {
  if (!isRecord(value)) {
    throw new Error(`Penalty summary row ${index} must be an object`);
  }

  if (typeof value.participant_id !== 'string' || value.participant_id.length === 0) {
    throw new Error(`Penalty summary row ${index} must define participant_id`);
  }

  if (typeof value.participant_display_name !== 'string' || value.participant_display_name.length === 0) {
    throw new Error(`Penalty summary row ${index} must define participant_display_name`);
  }

  if (value.mean_penalty !== null && typeof value.mean_penalty !== 'number') {
    throw new Error(`Penalty summary row ${index} must define mean_penalty as a number or null`);
  }

  return {
    participant_id: value.participant_id,
    participant_display_name: value.participant_display_name,
    mean_penalty: value.mean_penalty,
  };
}

function isNoContextVariant(row: PenaltySummaryRow): boolean {
  return row.participant_id.endsWith('-nocontext') || /\(No context\)/i.test(row.participant_display_name);
}

function sortPenaltyRows(left: PenaltySummaryRow, right: PenaltySummaryRow): number {
  if (left.mean_penalty === null && right.mean_penalty === null) {
    return left.participant_display_name.localeCompare(right.participant_display_name);
  }

  if (left.mean_penalty === null) {
    return 1;
  }

  if (right.mean_penalty === null) {
    return -1;
  }

  return left.mean_penalty - right.mean_penalty
    || left.participant_display_name.localeCompare(right.participant_display_name);
}

function toBarRow(row: PenaltySummaryRow): SlideReadyRankingBarRow {
  if (row.mean_penalty === null) {
    throw new Error(`Cannot render ${row.participant_id} without a mean penalty`);
  }

  if (row.participant_id === 'deepl-api') {
    return {
      kind: 'bar',
      participantId: row.participant_id,
      label: 'DeepL API (context)',
      meanPenalty: row.mean_penalty,
      group: 'commercial',
      fill: DEEPL_CONTEXT_FILL,
    };
  }

  if (row.participant_id === 'deepl-api-nocontext') {
    return {
      kind: 'bar',
      participantId: row.participant_id,
      label: 'DeepL API (No context)',
      meanPenalty: row.mean_penalty,
      group: 'commercial',
      fill: DEEPL_NOCONTEXT_FILL,
    };
  }

  if (row.participant_id === 'google-cloud-translate-basic') {
    return {
      kind: 'bar',
      participantId: row.participant_id,
      label: row.participant_display_name,
      meanPenalty: row.mean_penalty,
      group: 'commercial',
      fill: GOOGLE_FILL,
    };
  }

  return {
    kind: 'bar',
    participantId: row.participant_id,
    label: row.participant_display_name,
    meanPenalty: row.mean_penalty,
    group: 'llm',
    fill: LLM_FILL,
  };
}

function formatPenalty(value: number): string {
  return value.toFixed(2);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function parseJudgeCounts(value: unknown): RunStatusJudgeCounts | undefined {
  if (!isRecord(value) || typeof value.ok !== 'number' || typeof value.failed !== 'number') {
    return undefined;
  }

  return {
    ok: value.ok,
    failed: value.failed,
  };
}

function splitParticipantLanguageKey(key: string): { participantId: string; language: string } | undefined {
  const separatorIndex = key.indexOf('::');

  if (separatorIndex === -1) {
    return undefined;
  }

  return {
    participantId: key.slice(0, separatorIndex),
    language: key.slice(separatorIndex + 2),
  };
}

export function parsePenaltySummaryRows(jsonText: string): PenaltySummaryRow[] {
  const parsed = JSON.parse(jsonText) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('Penalty summary JSON must be an array');
  }

  return parsed.map((row, index) => parsePenaltySummaryRow(row, index));
}

export function selectSlideReadyRankingRows(rows: readonly PenaltySummaryRow[]): SlideReadyRankingRow[] {
  const llmRows = rows
    .filter((row) => row.mean_penalty !== null)
    .filter((row) => !COMMERCIAL_IDS.has(row.participant_id))
    .filter((row) => !isNoContextVariant(row))
    .sort(sortPenaltyRows)
    .slice(0, 5)
    .map(toBarRow);

  const commercialRows = rows
    .filter((row) => row.mean_penalty !== null)
    .filter((row) => COMMERCIAL_IDS.has(row.participant_id))
    .sort(sortPenaltyRows)
    .map(toBarRow);

  return [
    ...llmRows,
    {
      kind: 'ellipsis',
      label: ELLIPSIS_LABEL,
    },
    ...commercialRows,
  ];
}

export function buildDeepLFailureFootnoteFromRunStatusJson(jsonText: string): string | undefined {
  const parsed = JSON.parse(jsonText) as unknown;

  if (!isRecord(parsed) || !isRecord(parsed.judgeFailureRatesByParticipantLanguage)) {
    return undefined;
  }

  const expectedByLanguage = new Map<string, number>();
  const totalsByParticipantLanguage = new Map<string, number>();

  for (const [key, value] of Object.entries(parsed.judgeFailureRatesByParticipantLanguage)) {
    const splitKey = splitParticipantLanguageKey(key);
    const counts = parseJudgeCounts(value);

    if (!splitKey || !counts) {
      continue;
    }

    const total = counts.ok + counts.failed;
    totalsByParticipantLanguage.set(key, total);
    expectedByLanguage.set(splitKey.language, Math.max(expectedByLanguage.get(splitKey.language) ?? 0, total));
  }

  const presentDeepLIds = DEEPL_IDS.filter((participantId) =>
    [...totalsByParticipantLanguage.keys()].some((key) => key.startsWith(`${participantId}::`)));

  let unresolvedCount = 0;

  for (const participantId of presentDeepLIds) {
    for (const [language, expected] of expectedByLanguage.entries()) {
      const actual = totalsByParticipantLanguage.get(`${participantId}::${language}`) ?? 0;
      unresolvedCount += Math.max(expected - actual, 0);
    }
  }

  if (unresolvedCount === 0) {
    return undefined;
  }

  const failureLabel = unresolvedCount === 1 ? 'failure' : 'failures';
  return `DeepL variants had ${unresolvedCount} unresolved translation ${failureLabel} combined; bars reflect scored samples only.`;
}

export function renderSlideReadyRankingChartSvg(options: RenderSlideReadyRankingChartOptions): string {
  const title = options.title ?? TITLE;
  const subtitle = options.subtitle ?? SUBTITLE;
  const width = 1360;
  const plotLeft = 460;
  const plotWidth = 680;
  const plotRight = plotLeft + plotWidth;
  const labelX = plotLeft - 24;
  const valueX = plotRight + 20;
  const startY = 188;
  const rowStep = 54;
  const barHeight = 28;
  const footerHeight = options.footnote ? 72 : 40;
  const height = startY + (options.rows.length * rowStep) + footerHeight;
  const maxPenalty = Math.max(
    ...options.rows.flatMap((row) => row.kind === 'bar' ? [row.meanPenalty] : []),
    1,
  );
  const backgroundRows: string[] = [];
  const foregroundRows: string[] = [];
  const groupLabels: string[] = [];
  let lastGroup: SlideReadyRankingBarRow['group'] | undefined;

  options.rows.forEach((row, index) => {
    const centerY = startY + (index * rowStep);

    if (row.kind === 'ellipsis') {
      foregroundRows.push([
        `<g data-row-kind="ellipsis">`,
        `<line x1="${plotLeft}" y1="${centerY}" x2="${plotRight + 120}" y2="${centerY}" stroke="#cbd5e1" stroke-width="2" stroke-dasharray="6 8" />`,
        `<rect x="${plotLeft + 240}" y="${centerY - 14}" width="220" height="28" fill="#ffffff" />`,
        `<text x="${plotLeft + (plotWidth / 2)}" y="${centerY + 5}" font-size="18" font-weight="600" fill="#64748b" text-anchor="middle">${escapeXml(row.label)}</text>`,
        `</g>`,
      ].join(''));
      return;
    }

    if (row.group !== lastGroup) {
      groupLabels.push(
        `<text x="${plotLeft}" y="${centerY - 28}" font-size="15" font-weight="700" letter-spacing="1.8" fill="#475569">${row.group === 'llm' ? 'Top 5 LLMs' : 'Commercial services'}</text>`,
      );
      lastGroup = row.group;
    }

    const barWidth = (row.meanPenalty / maxPenalty) * plotWidth;
    const barY = centerY - (barHeight / 2);

    backgroundRows.push(`<rect x="${plotLeft}" y="${barY}" width="${plotWidth}" height="${barHeight}" rx="8" fill="#e2e8f0" />`);
    foregroundRows.push([
      `<g data-row-kind="bar" data-participant-id="${escapeXml(row.participantId)}">`,
      `<text x="${labelX}" y="${centerY + 6}" font-size="22" font-weight="600" fill="#0f172a" text-anchor="end">${escapeXml(row.label)}</text>`,
      `<rect x="${plotLeft}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="8" fill="${row.fill}" />`,
      `<text x="${valueX}" y="${centerY + 6}" font-size="22" font-weight="700" fill="#0f172a">${formatPenalty(row.meanPenalty)}</text>`,
      `</g>`,
    ].join(''));
  });

  const footnote = options.footnote
    ? `<text x="72" y="${height - 24}" font-size="15" fill="#475569">${escapeXml(options.footnote)}</text>`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="ranking-chart-title ranking-chart-subtitle">`,
    `<rect width="100%" height="100%" fill="#ffffff" />`,
    `<text id="ranking-chart-title" x="72" y="64" font-size="34" font-weight="700" fill="#0f172a">${escapeXml(title)}</text>`,
    `<text id="ranking-chart-subtitle" x="72" y="102" font-size="20" fill="#475569">${escapeXml(subtitle)}</text>`,
    `<line x1="${plotLeft}" y1="136" x2="${plotLeft}" y2="${height - footerHeight + 10}" stroke="#94a3b8" stroke-width="2" />`,
    ...groupLabels,
    ...backgroundRows,
    ...foregroundRows,
    footnote,
    `</svg>`,
  ].join('');
}

export function renderSlideReadyRankingChartHtml(svg: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '  <title>Slide-ready ranking chart preview</title>',
    '  <style>',
    '    body { margin: 0; font-family: Inter, Arial, sans-serif; background: #e2e8f0; }',
    '    main { min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }',
    '    .frame { background: white; box-shadow: 0 24px 64px rgba(15, 23, 42, 0.16); border-radius: 16px; overflow: auto; max-width: 100%; }',
    '    svg { display: block; height: auto; max-width: 100%; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <main>',
    '    <div class="frame">',
    svg,
    '    </div>',
    '  </main>',
    '</body>',
    '</html>',
  ].join('\n');
}
