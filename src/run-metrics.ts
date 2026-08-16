export type BenchmarkPhase = 'translation' | 'judge';
export type CostStatus = 'exact' | 'estimated' | 'unknown';

export interface CallUsageMetrics {
  provider: string;
  model: string;
  phase: BenchmarkPhase;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens?: number | null;
  latencyMs: number;
  costStatus?: CostStatus;
  computedCostUsd?: number | null;
}

export interface CostBucket {
  totalCostUsd: number;
  unknownCostRecordCount: number;
}

export interface CostSummary {
  byPhase: Record<BenchmarkPhase, CostBucket>;
  byModel: Record<string, CostBucket>;
  overall: CostBucket;
}

type PricingEntry = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
};

const USD_PER_CNY_SNAPSHOT_2026_04_20 = 1 / 7.25;

function cnyToUsdPerMillion(cnyPerMillion: number): number {
  return Number((cnyPerMillion * USD_PER_CNY_SNAPSHOT_2026_04_20).toFixed(6));
}

const PRICING_SNAPSHOT: Record<string, PricingEntry> = {
  'vertex:gemini-3.1-pro-preview': { inputPerMillionUsd: 2, outputPerMillionUsd: 12 },
  'vertex:gemini-2.5-flash': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 1.25 },
  'gemini:gemini-3-flash-preview': { inputPerMillionUsd: 0.5, outputPerMillionUsd: 3 },
  'gemini:gemini-3.1-flash-lite-preview': { inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.5 },
  'gemini:gemini-2.5-flash-lite': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 },
  'qwen:qwen3.6-plus': {
    inputPerMillionUsd: cnyToUsdPerMillion(2),
    outputPerMillionUsd: cnyToUsdPerMillion(12),
  },
  'qwen:qwen3.6-flash': {
    inputPerMillionUsd: cnyToUsdPerMillion(1.2),
    outputPerMillionUsd: cnyToUsdPerMillion(7.2),
  },
  'qwen:qwen3.5-plus': {
    inputPerMillionUsd: cnyToUsdPerMillion(0.8),
    outputPerMillionUsd: cnyToUsdPerMillion(4.8),
  },
  'qwen:qwen3.5-flash': {
    inputPerMillionUsd: cnyToUsdPerMillion(0.2),
    outputPerMillionUsd: cnyToUsdPerMillion(2),
  },
  'deepseek:deepseek-v4-flash': {
    inputPerMillionUsd: 0.14,
    outputPerMillionUsd: 0.28,
  },
  'openrouter:deepseek/deepseek-v4-flash': {
    inputPerMillionUsd: 0.14,
    outputPerMillionUsd: 0.28,
  },
  'deepseek:deepseek-v4-pro': {
    inputPerMillionUsd: 0.435,
    outputPerMillionUsd: 0.87,
  },
  'openrouter:deepseek/deepseek-v4-pro': {
    inputPerMillionUsd: 0.435,
    outputPerMillionUsd: 0.87,
  },
  'openrouter:google/gemini-3.7-flash': {
    inputPerMillionUsd: 0.375,
    outputPerMillionUsd: 1.875,
  },
  'openrouter-batch:google/gemini-3.7-flash': {
    inputPerMillionUsd: 0.1875,
    outputPerMillionUsd: 0.9375,
  },
};

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

export function computeCallCost(metrics: CallUsageMetrics, _pricingVersion: string): CallUsageMetrics {
  const pricing = PRICING_SNAPSHOT[`${metrics.provider}:${metrics.model}`];

  if (!pricing || metrics.inputTokens === null || metrics.outputTokens === null) {
    return {
      ...metrics,
      costStatus: 'unknown',
      computedCostUsd: null,
    };
  }

  // Reasoning/thinking tokens are billed at output-token rates for every provider
  // that reports them (Gemini thoughtsTokenCount, OpenRouter reasoning tokens, ...).
  const effectiveOutputTokens = metrics.outputTokens + (metrics.reasoningTokens ?? 0);

  const computedCostUsd = roundUsd(
    ((metrics.inputTokens / 1_000_000) * pricing.inputPerMillionUsd)
      + ((effectiveOutputTokens / 1_000_000) * pricing.outputPerMillionUsd),
  );

  return {
    ...metrics,
    costStatus: 'estimated',
    computedCostUsd,
  };
}

export function aggregateRunCosts(metrics: CallUsageMetrics[]): CostSummary {
  const byPhase: Record<BenchmarkPhase, CostBucket> = {
    translation: { totalCostUsd: 0, unknownCostRecordCount: 0 },
    judge: { totalCostUsd: 0, unknownCostRecordCount: 0 },
  };
  const byModel: Record<string, CostBucket> = {};

  for (const metric of metrics) {
    const cost = metric.computedCostUsd ?? 0;
    byPhase[metric.phase].totalCostUsd = roundUsd(byPhase[metric.phase].totalCostUsd + cost);
    byModel[metric.model] ??= { totalCostUsd: 0, unknownCostRecordCount: 0 };
    byModel[metric.model].totalCostUsd = roundUsd(byModel[metric.model].totalCostUsd + cost);

    if (metric.computedCostUsd === null || metric.computedCostUsd === undefined) {
      byPhase[metric.phase].unknownCostRecordCount += 1;
      byModel[metric.model].unknownCostRecordCount += 1;
    }
  }

  return {
    byPhase,
    byModel,
    overall: {
      totalCostUsd: roundUsd(byPhase.translation.totalCostUsd + byPhase.judge.totalCostUsd),
      unknownCostRecordCount:
        byPhase.translation.unknownCostRecordCount + byPhase.judge.unknownCostRecordCount,
    },
  };
}
