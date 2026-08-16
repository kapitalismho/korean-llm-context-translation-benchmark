# Issue-1 experiment launcher — visible PowerShell terminal (AGENTS.md pattern).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/experiment/launch-issue1.ps1           # fresh launch
#   powershell -ExecutionPolicy Bypass -File scripts/experiment/launch-issue1.ps1 -Resume   # resume interrupted run
#
# The agent copies this script into output/<RunId>/launch-visible.ps1 before the
# real launch (per AGENTS.md), so the run directory always contains the exact
# launch script and console log for that run. It also works when run in place.
#
# Resume/reuse model (fail-safe):
#   - translations.jsonl: completed cells are keyed by stable key; a resume
#     never re-translates a completed cell.
#   - translation-failures.jsonl: unresolved failures are skipped on resume
#     (fail-closed) and reported; the fork carries historical failures forward
#     (DeepL's 4 missing cells are never regenerated).
#   - judge-batch-custom-ids.json + manifest.openRouterBatchJobIds: batch job
#     ids are persisted before polling; a resume re-polls the recorded jobs and
#     NEVER submits a duplicate batch. A lost submit response fails closed
#     (judge-batch-submission-attempts.jsonl reconciliation) instead of
#     double-submitting paid lines.
#   - fork runs resume only after fork-prepared.json exists (atomic fork copy).
#   - Console log: output/<RunId>/<RunId>.console.log (Tee-Object).
#
# Monitoring: scripts/experiment/issue1-watch.ps1 -RunId <id>

param(
  [switch]$Resume
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$RunId       = 'issue1-milmmt-e4b-20260815'
$SourceRunId = 'gemba-mqm-context-v1-gemini-context-v2-expanded-deepl-reuse-20260429-052309'

# Console log always lives in the run directory (AGENTS.md: RUN_ID/LOG printed,
# Tee-Object to a run-specific console log).
$RunDir = Join-Path $ProjectRoot "output\$RunId"
$Log    = Join-Path $RunDir "$RunId.console.log"
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

if ($Host.UI -and $Host.UI.RawUI) {
    $Host.UI.RawUI.WindowTitle = "bench issue1 :: $RunId :: $($(if ($Resume) { 'RESUME' } else { 'FRESH' }))"
}

Write-Host "RUN_ID=$RunId"
Write-Host "LOG=$Log"
Write-Host "MODE=$($(if ($Resume) { 'resume' } else { 'fresh fork' }))"
Write-Host "FORK_FROM=$SourceRunId"

Set-Location -LiteralPath $ProjectRoot

# Production llama.cpp servers (started separately, see scripts/llama-server.ps1):
#   8080 gemma-4-E4B-it-qat-UD-Q2_K_XL (chat)   8081 gemma-4-E4B-it-qat-UD-Q4_K_XL (chat)
#   8082 gemma-4-E4B-it fp16 (chat)             8083 MiLMMT-46-4B-v1.0.f16 (completion)

$Participants = @(
  'gemma4-e4b-qat-q2',
  'gemma4-e4b-qat-q4',
  'gemma4-e4b-fp16',
  'milmmt-4b-native',
  'milmmt-4b-puripuly-policy',
  'gemma4-31b',
  'gemma-4-26b-openrouter',
  'google-cloud-translate-basic',
  'deepl-api'
) -join ','

if (-not $Resume) {
  Write-Host "=== preflight ==="
  npx tsx scripts/experiment/preflight-issue1.ts --run-id "$RunId"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "PREFLIGHT FAILED (exit $LASTEXITCODE). Aborting before any paid work."
    exit $LASTEXITCODE
  }
  Write-Host "=== preflight passed ==="
}

if ($Resume) {
  npm run bench:cli -- `
    --benchmark-config "data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json" `
    --judge-model "google/gemini-3.7-flash:batch" `
    --judge-backend openrouter-batch `
    --run-id "$RunId" `
    --resume `
    --translation-concurrency-per-model 4 `
    --judge-concurrency 6 2>&1 | Tee-Object -FilePath $Log
} else {
  npm run bench:cli -- `
    --benchmark-config "data/benchmarks/gemba-mqm-context-v1-milmmt-e4b.json" `
    --participants "$Participants" `
    --judge-model "google/gemini-3.7-flash:batch" `
    --judge-backend openrouter-batch `
    --run-id "$RunId" `
    --fork-from-run "$SourceRunId" `
    --fork-allow-prompt-mismatch `
    --translation-concurrency-per-model 4 `
    --judge-concurrency 6 2>&1 | Tee-Object -FilePath $Log
}

$ExitCode = $LASTEXITCODE
Write-Host "=== issue-1 run finished (exit $ExitCode); terminal left open for inspection ==="
exit $ExitCode
