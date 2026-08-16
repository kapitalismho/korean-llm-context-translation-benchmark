// Issue-1 preflight gate (Phase 2): validates servers, credentials, and the
// OpenRouter batch judge pipeline BEFORE any full-workload paid work, then
// writes provenance.json into the run directory (Phase 0 identity freeze).
//
// Usage:
//   npx tsx scripts/experiment/preflight-issue1.ts --run-id <id> [--skip-probe]
//
// Checks:
//   1. benchmark config + participant registry + models.json load
//   2. each llama.cpp server: GET /health returns ok, GET /v1/models non-empty
//      (actual served model id recorded in provenance)
//   3. OPENROUTER_API_KEY present (batch judge + 31B interactive row)
//   4. fork source run artifacts exist
//   5. batch judge probe: ONE real line through submit -> poll -> retrieve ->
//      MQM parse (paid, ~$0.001); probe artifacts kept under output/<runId>/probe/
//   6. provenance.json written: repo commits, config/dataset/prompt hashes,
//      model file SHA-256s, llama.cpp version, served model ids, judge identity,
//      probe job id, source run id
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import 'dotenv/config';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sha256Of(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function gitHead(repoPath: string): string {
  const head = run('git', ['-C', repoPath, 'rev-parse', 'HEAD']);
  return head || '(unavailable)';
}

function fail(message: string): never {
  console.error(`PREFLIGHT FAIL: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const runId = args.find((a) => a.startsWith('--run-id='))?.split('=')[1]
  ?? args[args.indexOf('--run-id') + 1];
const skipProbe = args.includes('--skip-probe');

if (!runId) {
  fail('--run-id <id> is required');
}

const outDir = path.join(projectRoot, 'output', runId);
mkdirSync(outDir, { recursive: true });

// ---- 1. config / registry / models manifest ----
const { loadBenchmarkConfig } = await import(pathToFileURL(path.join(projectRoot, 'src', 'benchmark-config.ts')).href);
const { loadParticipantRegistry, resolveSelectedParticipants } = await import(pathToFileURL(path.join(projectRoot, 'src', 'participant-registry.ts')).href);
const config = loadBenchmarkConfig(path.join(projectRoot, 'data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json'));
const registry = loadParticipantRegistry(path.join(projectRoot, 'data/participants/registry.json'));
const experimentIds = ['gemma4-e4b-qat-q2', 'gemma4-e4b-qat-q4', 'gemma4-e4b-fp16', 'milmmt-4b-native', 'milmmt-4b-puripuly-policy', 'gemma4-31b', 'gemma-4-26b-openrouter', 'google-cloud-translate-basic', 'deepl-api'];
const participants = resolveSelectedParticipants(registry, experimentIds);
console.log(`config ok: ${config.benchmarkId}; participants ok: ${participants.length}`);

const modelsManifest = JSON.parse(readFileSync(path.join(projectRoot, 'scripts/experiment/models.json'), 'utf8')) as Array<{
  participantId: string;
  expectedRepo: string;
  expectedRevision: string;
  ggufFile: string;
  localPath: string;
  sha256: string | null;
  llamaCppServerUrl: string;
  llamaCppMode: string;
}>;
const localModels = participants.filter((p: { provider: string }) => p.provider === 'llamacpp');
if (modelsManifest.length !== localModels.length) {
  fail(`models.json (${modelsManifest.length}) must cover all llamacpp participants (${localModels.length})`);
}

// ---- 2. llama.cpp server health + served model identity ----
const servedModels: Array<{ participantId: string; serverUrl: string; servedModelId: string | null }> = [];
for (const participant of localModels) {
  const entry = modelsManifest.find((m) => m.participantId === participant.participantId);
  if (!entry) {
    fail(`models.json missing entry for ${participant.participantId}`);
  }

  if (!existsSync(entry.localPath)) {
    fail(`GGUF not found for ${participant.participantId}: ${entry.localPath}`);
  }

  if (entry.sha256 === null) {
    console.log(`hashing ${entry.localPath} ...`);
    entry.sha256 = sha256Of(entry.localPath);
  }

  const serverUrl = participant.llamaCppServerUrl ?? entry.llamaCppServerUrl;
  const healthUrl = `${serverUrl.replace(/\/+$/, '')}/health`;

  let healthOk = false;
  try {
    const health = await (await fetch(healthUrl)).json() as { status?: string };
    healthOk = health.status === 'ok';
  } catch {
    healthOk = false;
  }

  if (!healthOk) {
    fail(`llama.cpp server ${serverUrl} for ${participant.participantId} is not healthy (GET /health). Start scripts/llama-server.ps1 for this model first.`);
  }

  let servedModelId: string | null = null;
  try {
    const models = await (await fetch(`${serverUrl.replace(/\/+$/, '')}/v1/models`)).json() as { data?: Array<{ id?: string }> };
    servedModelId = (models.data?.[0]?.id ?? null);
  } catch {
    servedModelId = null;
  }

  if (!servedModelId) {
    fail(`llama.cpp server ${serverUrl} returned no model id (GET /v1/models)`);
  }

  console.log(`server ok: ${participant.participantId} @ ${serverUrl} serves "${servedModelId}"`);
  servedModels.push({ participantId: participant.participantId, serverUrl, servedModelId });
}

// ---- 3. credentials ----
const openRouterApiKey = process.env.OPENROUTER_API_KEY;
if (!openRouterApiKey) {
  fail('OPENROUTER_API_KEY is not set (required for the batch judge and the Gemma 4 31B row)');
}

// ---- 4. fork source run ----
const sourceRunId = 'gemba-mqm-context-v1-gemini-context-v2-expanded-deepl-reuse-20260429-052309';
const sourceRunDir = path.join(projectRoot, 'output', sourceRunId);
if (!existsSync(path.join(sourceRunDir, 'manifest.json')) || !existsSync(path.join(sourceRunDir, 'translations.jsonl'))) {
  fail(`fork source run artifacts missing: ${sourceRunDir}`);
}

console.log(`source run ok: ${sourceRunId}`);

// ---- 5. batch judge probe (one real line) ----
let probeJobId: string | null = null;
let probeCostUsd: number | null = null;
let probeRawText: string | null = null;

if (skipProbe) {
  console.log('batch probe skipped (--skip-probe)');
} else {
const { OpenRouterBatchGembaJudge } = await import(pathToFileURL(path.join(projectRoot, 'src', 'openrouter-batch-judge.ts')).href);
const { buildVertexJudgeRequest } = await import(pathToFileURL(path.join(projectRoot, 'src', 'vertex-judge.ts')).href);
const { loadGembaAssets } = await import(pathToFileURL(path.join(projectRoot, 'src', 'gemba-assets.ts')).href);
const { renderContextJudgeTemplateVariables } = await import(pathToFileURL(path.join(projectRoot, 'src', 'context-serialization.ts')).href);

  const assets = loadGembaAssets(projectRoot, 'gemba-mqm-context-v1');
  const dataset = JSON.parse(readFileSync(path.join(projectRoot, 'data/datasets/gemba-mqm-context-v1/runtime.json'), 'utf8'));
  const sample = dataset[0];
  const probeStableKey = `${runId}::preflight-probe::en::judge`;
  const request = buildVertexJudgeRequest({
    model: 'google/gemini-3.7-flash:batch',
    systemPrompt: assets.systemPrompt,
    fewShotMessages: assets.fewShotMessages,
    userPromptTemplate: assets.userPromptTemplate,
    templateVariables: renderContextJudgeTemplateVariables(sample, 'Preflight probe translation.', 'English'),
  });

  const probeDir = path.join(outDir, 'probe');
  mkdirSync(probeDir, { recursive: true });
  const judge = new OpenRouterBatchGembaJudge({
    apiKey: openRouterApiKey,
    model: 'google/gemini-3.7-flash:batch',
    apiBaseUrl: process.env.OPENROUTER_BATCH_API_BASE_URL,
    pollIntervalMs: 10_000,
    maxPollDurationMs: 30 * 60_000,
    maxResidualSubmitRounds: 1,
  });

  console.log(`batch probe: submitting 1 line ...`);
  const prepared = await judge.prepareBatch({
    runDir: probeDir,
    requests: [{ stableKey: probeStableKey, request }],
    existingJobIds: [],
    onJobStatus: (info: { jobId: string; status: string; completed: number; total: number }) => console.log(`  probe job ${info.jobId}: ${info.status} (${info.completed}/${info.total})`),
  });
  probeJobId = prepared.jobIds[0] ?? null;

  const result = await judge.judgeItem(probeStableKey);
  if (!result.ok) {
    fail(`batch probe line failed: ${result.rawText}`);
  }

  probeRawText = result.rawText.slice(0, 120);
  probeCostUsd = result.usage.computedCostUsd;
  console.log(`batch probe ok: job ${probeJobId}, cost $${probeCostUsd ?? 'n/a'} (MQM annotation parsed client-side)`);
}

// ---- 6. provenance.json ----
const puripulyRepo = 'C:\\Users\\salee\\Documents\\dev\\puripuly_heart';
const llamaVersion = run('llama-server', ['--version']).split(/\r?\n/)[0] || '(llama-server not on PATH; record version at server start)';
const provenance = {
  runId,
  generatedAtUtc: new Date().toISOString(),
  benchmarkRepository: {
    branch: 'feat/issue1-phase1',
    commit: gitHead(projectRoot),
  },
  puripulyHeart: {
    repo: 'kapitalismho/PuriPuly-heart',
    translationPromptFile: 'prompts/translation_prompt.md',
    commit: gitHead(puripulyRepo),
  },
  benchmarkConfig: {
    benchmarkId: config.benchmarkId,
    file: 'data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json',
    sha256: sha256Of(path.join(projectRoot, 'data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json')),
  },
  dataset: {
    file: 'data/datasets/gemba-mqm-context-v1/runtime.json',
    sha256: sha256Of(path.join(projectRoot, 'data/datasets/gemba-mqm-context-v1/runtime.json')),
  },
  prompts: {
    'data/prompts/puripuly-translation-latest.md': sha256Of(path.join(projectRoot, 'data/prompts/puripuly-translation-latest.md')),
    'data/prompts/milmmt-x0-native.md': sha256Of(path.join(projectRoot, 'data/prompts/milmmt-x0-native.md')),
    'data/prompts/milmmt-x2-puripuly.md': sha256Of(path.join(projectRoot, 'data/prompts/milmmt-x2-puripuly.md')),
  },
  llamaCpp: {
    version: llamaVersion,
    computeBackend: 'Vulkan',
  },
  models: modelsManifest.map((m) => ({
    participantId: m.participantId,
    expectedRepo: m.expectedRepo,
    expectedRevision: m.expectedRevision,
    ggufFile: m.ggufFile,
    localPath: m.localPath,
    sha256: m.sha256,
    serverUrl: m.llamaCppServerUrl,
    mode: m.llamaCppMode,
    servedModelId: servedModels.find((s) => s.participantId === m.participantId)?.servedModelId ?? null,
  })),
  judge: {
    backend: 'openrouter-batch',
    model: 'google/gemini-3.7-flash:batch',
    endpoint: process.env.OPENROUTER_BATCH_API_BASE_URL ?? 'https://openrouter.ai/api',
    reasoning: 'medium (catalog default, not sent explicitly)',
    probe: skipProbe ? null : {
      jobId: probeJobId,
      costUsd: probeCostUsd,
      rawTextPreview: probeRawText,
    },
  },
  forkSourceRunId: sourceRunId,
};

writeFileSync(path.join(outDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`provenance written: ${path.join(outDir, 'provenance.json')}`);
console.log('PREFLIGHT OK');

