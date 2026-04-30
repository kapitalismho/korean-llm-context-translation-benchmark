import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDeepLFailureFootnoteFromRunStatusJson,
  parsePenaltySummaryRows,
  renderSlideReadyRankingChartHtml,
  renderSlideReadyRankingChartSvg,
  selectSlideReadyRankingRows,
} from '../src/ranking-chart.js';

interface CliOptions {
  runId: string;
  outputRoot: string;
  summaryPath?: string;
  runStatusPath?: string;
  svgOut?: string;
  htmlOut?: string;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requireOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    outputRoot: path.join(projectRoot, 'output'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--run-id':
        options.runId = requireOptionValue(argv, index, '--run-id');
        index += 1;
        break;
      case '--output-root':
        options.outputRoot = path.resolve(projectRoot, requireOptionValue(argv, index, '--output-root'));
        index += 1;
        break;
      case '--summary-path':
        options.summaryPath = path.resolve(projectRoot, requireOptionValue(argv, index, '--summary-path'));
        index += 1;
        break;
      case '--run-status-path':
        options.runStatusPath = path.resolve(projectRoot, requireOptionValue(argv, index, '--run-status-path'));
        index += 1;
        break;
      case '--svg-out':
        options.svgOut = path.resolve(projectRoot, requireOptionValue(argv, index, '--svg-out'));
        index += 1;
        break;
      case '--html-out':
        options.htmlOut = path.resolve(projectRoot, requireOptionValue(argv, index, '--html-out'));
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.runId) {
    throw new Error('--run-id is required');
  }

  return options as CliOptions;
}

function ensureParentDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

const options = parseArgs(process.argv.slice(2));
const reportsDir = path.join(options.outputRoot, options.runId, 'reports');
const summaryPath = options.summaryPath ?? path.join(reportsDir, 'summary-overall.penalty.json');
const runStatusPath = options.runStatusPath ?? path.join(reportsDir, 'run-status.json');
const svgOut = options.svgOut ?? path.join(reportsDir, 'slide-ranking.top-llms-vs-commercial.svg');
const htmlOut = options.htmlOut ?? path.join(reportsDir, 'slide-ranking.top-llms-vs-commercial.html');

const summaryRows = parsePenaltySummaryRows(readFileSync(summaryPath, 'utf8'));
const selectedRows = selectSlideReadyRankingRows(summaryRows);
const footnote = existsSync(runStatusPath)
  ? buildDeepLFailureFootnoteFromRunStatusJson(readFileSync(runStatusPath, 'utf8'))
  : undefined;
const svg = renderSlideReadyRankingChartSvg({
  rows: selectedRows,
  footnote,
});
const html = renderSlideReadyRankingChartHtml(svg);

ensureParentDir(svgOut);
ensureParentDir(htmlOut);
writeFileSync(svgOut, `${svg}\n`, 'utf8');
writeFileSync(htmlOut, `${html}\n`, 'utf8');

console.log(`Wrote SVG: ${svgOut}`);
console.log(`Wrote HTML: ${htmlOut}`);
