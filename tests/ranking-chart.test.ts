import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeepLFailureFootnoteFromRunStatusJson,
  parsePenaltySummaryRows,
  renderSlideReadyRankingChartHtml,
  renderSlideReadyRankingChartSvg,
  selectSlideReadyRankingRows,
  type PenaltySummaryRow,
} from '../src/ranking-chart.js';

const SAMPLE_ROWS: PenaltySummaryRow[] = [
  {
    participant_id: 'qwen-3.6-plus',
    participant_display_name: 'Qwen 3.6 Plus',
    mean_penalty: 0.8287037037037037,
  },
  {
    participant_id: 'qwen-3.6-flash',
    participant_display_name: 'Qwen 3.6 Flash',
    mean_penalty: 2.242283950617284,
  },
  {
    participant_id: 'qwen-3.5-plus',
    participant_display_name: 'Qwen 3.5 Plus',
    mean_penalty: 1.1157407407407407,
  },
  {
    participant_id: 'gemini-3-flash',
    participant_display_name: 'Gemini 3 Flash',
    mean_penalty: 0.5524691358024691,
  },
  {
    participant_id: 'gemini-3.1-flash-lite',
    participant_display_name: 'Gemini 3.1 Flash-lite',
    mean_penalty: 0.8580246913580247,
  },
  {
    participant_id: 'gemma-4-26b-openrouter',
    participant_display_name: 'Gemma 4 26B via OpenRouter',
    mean_penalty: 0.8132716049382716,
  },
  {
    participant_id: 'google-cloud-translate-basic',
    participant_display_name: 'Google Cloud Translation Basic',
    mean_penalty: 5.9984567901234565,
  },
  {
    participant_id: 'deepl-api',
    participant_display_name: 'DeepL API',
    mean_penalty: 4.962732919254658,
  },
  {
    participant_id: 'deepl-api-nocontext',
    participant_display_name: 'DeepL API (No context)',
    mean_penalty: 5.717391304347826,
  },
  {
    participant_id: 'gemini-2.5-flash-lite',
    participant_display_name: 'Gemini 2.5 Flash-lite',
    mean_penalty: 1.6419753086419753,
  },
  {
    participant_id: 'gemini-2.5-flash-lite-nocontext',
    participant_display_name: 'Gemini 2.5 Flash-lite (No context)',
    mean_penalty: 2.146604938271605,
  },
  {
    participant_id: 'gemini-3-flash-nocontext',
    participant_display_name: 'Gemini 3 Flash (No context)',
    mean_penalty: 0.9074074074074074,
  },
  {
    participant_id: 'broken-row',
    participant_display_name: 'Broken Row',
    mean_penalty: null,
  },
];

test('parsePenaltySummaryRows parses summary JSON and validates required fields', () => {
  const rows = parsePenaltySummaryRows(JSON.stringify(SAMPLE_ROWS));

  assert.equal(rows.length, SAMPLE_ROWS.length);
  assert.equal(rows[0]?.participant_id, 'qwen-3.6-plus');
  assert.equal(rows[0]?.mean_penalty, 0.8287037037037037);
});

test('selectSlideReadyRankingRows keeps top five context-capable LLMs and appends the commercial service rows', () => {
  const rows = selectSlideReadyRankingRows(SAMPLE_ROWS);

  assert.deepEqual(
    rows.map((row) => ({
      kind: row.kind,
      label: row.label,
      participantId: row.kind === 'bar' ? row.participantId : null,
    })),
    [
      {
        kind: 'bar',
        label: 'Gemini 3 Flash',
        participantId: 'gemini-3-flash',
      },
      {
        kind: 'bar',
        label: 'Gemma 4 26B via OpenRouter',
        participantId: 'gemma-4-26b-openrouter',
      },
      {
        kind: 'bar',
        label: 'Qwen 3.6 Plus',
        participantId: 'qwen-3.6-plus',
      },
      {
        kind: 'bar',
        label: 'Gemini 3.1 Flash-lite',
        participantId: 'gemini-3.1-flash-lite',
      },
      {
        kind: 'bar',
        label: 'Qwen 3.5 Plus',
        participantId: 'qwen-3.5-plus',
      },
      {
        kind: 'ellipsis',
        label: '… omitted models …',
        participantId: null,
      },
      {
        kind: 'bar',
        label: 'DeepL API (context)',
        participantId: 'deepl-api',
      },
      {
        kind: 'bar',
        label: 'DeepL API (No context)',
        participantId: 'deepl-api-nocontext',
      },
      {
        kind: 'bar',
        label: 'Google Cloud Translation Basic',
        participantId: 'google-cloud-translate-basic',
      },
    ],
  );
});

test('buildDeepLFailureFootnoteFromRunStatusJson reports unresolved DeepL sample gaps when present', () => {
  const footnote = buildDeepLFailureFootnoteFromRunStatusJson(JSON.stringify({
    judgeFailureRatesByParticipantLanguage: {
      'gemini-3-flash::en': { ok: 216, failed: 0 },
      'gemini-3-flash::ja': { ok: 216, failed: 0 },
      'deepl-api::en': { ok: 214, failed: 0 },
      'deepl-api::ja': { ok: 216, failed: 0 },
      'deepl-api-nocontext::en': { ok: 215, failed: 0 },
      'deepl-api-nocontext::ja': { ok: 214, failed: 0 },
    },
  }));

  assert.equal(
    footnote,
    'DeepL variants had 5 unresolved translation failures combined; bars reflect scored samples only.',
  );
});

test('renderSlideReadyRankingChartSvg renders slide-ready labels, values, groups, and footnote', () => {
  const svg = renderSlideReadyRankingChartSvg({
    rows: selectSlideReadyRankingRows(SAMPLE_ROWS),
    footnote: 'DeepL variants had 8 unresolved translation failures combined; bars reflect scored samples only.',
  });

  assert.match(svg, /<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /LLMs outperform commercial translation services on context-heavy translation/);
  assert.match(svg, /Raw mean MQM penalty \(lower is better\)/);
  assert.match(svg, /Top 5 LLMs/);
  assert.match(svg, /Commercial services/);
  assert.match(svg, /Gemini 3 Flash/);
  assert.match(svg, /DeepL API \(context\)/);
  assert.match(svg, /DeepL API \(No context\)/);
  assert.match(svg, /Google Cloud Translation Basic/);
  assert.match(svg, />0\.55</);
  assert.match(svg, />0\.81</);
  assert.match(svg, />4\.96</);
  assert.match(svg, />5\.72</);
  assert.match(svg, />6\.00</);
  assert.match(svg, /… omitted models …/);
  assert.match(svg, /DeepL variants had 8 unresolved translation failures combined; bars reflect scored samples only\./);

  assert.equal((svg.match(/data-row-kind="bar"/g) ?? []).length, 8);
  assert.equal((svg.match(/data-row-kind="ellipsis"/g) ?? []).length, 1);
});

test('renderSlideReadyRankingChartHtml wraps the SVG in a directly openable preview page', () => {
  const svg = renderSlideReadyRankingChartSvg({
    rows: selectSlideReadyRankingRows(SAMPLE_ROWS),
  });
  const html = renderSlideReadyRankingChartHtml(svg);

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<title>Slide-ready ranking chart preview<\/title>/);
  assert.match(html, /<body>/);
  assert.match(html, /<svg/);
});
