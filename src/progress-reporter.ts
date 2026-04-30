import type { BenchmarkPhase } from './run-metrics.js';

const SUMMARY_INTERVAL_MS = 10_000;

export interface ParticipantProgressSnapshot {
  participantId: string;
  completed: number;
  failed: number;
  inflight: number;
  retries: number;
  remaining: number;
  initialCompleted?: number;
  lastFailureAt?: string | null;
}

export interface ProgressSnapshot {
  completed: number;
  succeeded: number;
  failed: number;
  activeWorkers: number;
  totalCostUsd: number;
  participantSnapshots?: ParticipantProgressSnapshot[];
  initialCompleted?: number;
  retryCount?: number;
}

function calculateRateAndEta(input: {
  completed: number;
  total: number;
  elapsedMs: number;
  initialCompleted?: number;
}) {
  const elapsedMinutes = Math.max(input.elapsedMs / 60_000, 1 / 60_000);
  const workDoneThisSession = Math.max(input.completed - (input.initialCompleted ?? 0), 0);
  const rate = workDoneThisSession <= 0 ? 0 : workDoneThisSession / elapsedMinutes;
  const remaining = Math.max(input.total - input.completed, 0);
  const etaMinutes = rate === 0 ? 0 : Math.ceil(remaining / rate);

  return {
    rate,
    etaMinutes,
  };
}

function compareFailedParticipants(
  left: ParticipantProgressSnapshot & { order: number },
  right: ParticipantProgressSnapshot & { order: number },
): number {
  const leftFailureTime = left.lastFailureAt === undefined || left.lastFailureAt === null
    ? -Infinity
    : Date.parse(left.lastFailureAt);
  const rightFailureTime = right.lastFailureAt === undefined || right.lastFailureAt === null
    ? -Infinity
    : Date.parse(right.lastFailureAt);

  if (leftFailureTime !== rightFailureTime) {
    return rightFailureTime - leftFailureTime;
  }

  if (left.failed !== right.failed) {
    return right.failed - left.failed;
  }

  return left.order - right.order;
}

function compareRemainingParticipants(
  left: ParticipantProgressSnapshot & { order: number },
  right: ParticipantProgressSnapshot & { order: number },
): number {
  if (left.remaining !== right.remaining) {
    return right.remaining - left.remaining;
  }

  return left.order - right.order;
}

function selectParticipantSnapshots(
  snapshots: ParticipantProgressSnapshot[],
  threshold: number,
): ParticipantProgressSnapshot[] {
  if (snapshots.length <= threshold) {
    return snapshots;
  }

  const ranked = snapshots.map((snapshot, order) => ({
    ...snapshot,
    order,
  }));
  const selected: ParticipantProgressSnapshot[] = [];
  const seen = new Set<string>();

  const push = (snapshot: ParticipantProgressSnapshot | undefined) => {
    if (!snapshot || seen.has(snapshot.participantId)) {
      return;
    }

    seen.add(snapshot.participantId);
    selected.push(snapshot);
  };

  for (const snapshot of ranked.filter((item) => item.inflight > 0)) {
    push(snapshot);
  }

  for (const snapshot of ranked
    .filter((item) => item.failed > 0)
    .sort(compareFailedParticipants)
    .slice(0, 10)) {
    push(snapshot);
  }

  for (const snapshot of ranked
    .filter((item) => item.remaining > 0)
    .sort(compareRemainingParticipants)
    .slice(0, 5)) {
    push(snapshot);
  }

  return selected;
}

export function createProgressReporter(input: {
  phase: BenchmarkPhase;
  total: number;
  log?: (line: string) => void;
  now?: () => number;
  participantLineLimit?: number;
}) {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const log = input.log ?? console.log;
  const participantLineLimit = input.participantLineLimit ?? 10;
  let lastSummaryAt: number | null = null;

  const emitSummary = (snapshot: ProgressSnapshot, nowMs: number) => {
    lastSummaryAt = nowMs;

    const overall = calculateRateAndEta({
      completed: snapshot.completed,
      total: input.total,
      elapsedMs: nowMs - startedAt,
      initialCompleted: snapshot.initialCompleted,
    });
    const retryCount = snapshot.retryCount
      ?? snapshot.participantSnapshots?.reduce((sum, participant) => sum + participant.retries, 0)
      ?? 0;

    log(
      `${input.phase} overall ${snapshot.completed}/${input.total}`
      + ` | ok ${snapshot.succeeded} fail ${snapshot.failed} retry ${retryCount}`
      + ` | ${overall.rate.toFixed(1)} items/min`
      + ` | ETA ${overall.etaMinutes}m`
      + ` | est $${snapshot.totalCostUsd.toFixed(2)}`,
    );

    if (input.phase !== 'translation' || !snapshot.participantSnapshots || snapshot.participantSnapshots.length === 0) {
      return;
    }

    for (const participant of selectParticipantSnapshots(snapshot.participantSnapshots, participantLineLimit)) {
      const total = participant.completed + participant.remaining;
      const rateAndEta = calculateRateAndEta({
        completed: participant.completed,
        total,
        elapsedMs: nowMs - startedAt,
        initialCompleted: participant.initialCompleted,
      });
      const succeeded = Math.max(participant.completed - participant.failed, 0);

      log(
        `${input.phase} ${participant.participantId} ${participant.completed}/${total}`
        + ` | ok ${succeeded} fail ${participant.failed} retry ${participant.retries}`
        + ` | ${rateAndEta.rate.toFixed(1)} items/min`
        + ` | ETA ${rateAndEta.etaMinutes}m`
        + ` | inflight ${participant.inflight}`,
      );
    }
  };

  const shouldEmitSummary = (nowMs: number) => lastSummaryAt === null || nowMs - lastSummaryAt >= SUMMARY_INTERVAL_MS;

  return {
    update(snapshot: ProgressSnapshot) {
      const nowMs = now();
      if (!shouldEmitSummary(nowMs)) {
        return;
      }

      emitSummary(snapshot, nowMs);
    },
    flush(snapshot: ProgressSnapshot) {
      emitSummary(snapshot, now());
    },
  };
}
