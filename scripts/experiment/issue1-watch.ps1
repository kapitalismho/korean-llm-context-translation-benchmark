# Issue-1 run progress monitor.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/experiment/issue1-watch.ps1 -RunId <run-id>
#
# Prints a compact snapshot of the run state so an interrupted run can be
# reported/resumed precisely:
#   - translations done per participant
#   - unresolved translation failures (fail-closed skips)
#   - judge batch jobs recorded in the manifest
#   - judge records (raw/normalized/metrics/failures) counts
#   - report status
#   - last console log lines
#
# Reuse points after an interruption:
#   - completed translation cells are never regenerated (stable-key skip)
#   - recorded batch job ids are re-polled, never resubmitted
#   - run with: scripts/experiment/launch-issue1.ps1 -Resume

param(
  [Parameter(Mandatory = $true)]
  [string]$RunId
)

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$RunDir = Join-Path $ProjectRoot "output\$RunId"

if (-not (Test-Path -LiteralPath $RunDir)) {
  Write-Host "RUN_ID=$RunId"
  Write-Host "ERROR: run directory not found: $RunDir"
  exit 1
}

Write-Host "RUN_ID=$RunId"
Write-Host "RUN_DIR=$RunDir"

$ManifestPath = Join-Path $RunDir 'manifest.json'
if (Test-Path -LiteralPath $ManifestPath) {
  $Manifest = Get-Content $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "benchmarkId=$($Manifest.benchmarkId) prompt=$($Manifest.promptVersion) judge=$($Manifest.judgeBackend)/$($Manifest.judgeModelId)"
  Write-Host "forkFromRun=$($Manifest.forkFromRunId) promptMismatchAllowed=$($Manifest.forkPromptMismatchAllowed)"
  Write-Host "participants=$($Manifest.participants.Count) limitApplied=$($Manifest.limitApplied)"
  if ($Manifest.openRouterBatchJobIds -and @($Manifest.openRouterBatchJobIds).Count -gt 0) {
    Write-Host "batchJobs=$(@($Manifest.openRouterBatchJobIds) -join ',')"
  } else {
    Write-Host "batchJobs=none yet"
  }
} else {
  Write-Host "manifest: NOT YET WRITTEN (fork prepare not started)"
}

# translations
$Translations = @()
$TranslationsPath = Join-Path $RunDir 'translations.jsonl'
if (Test-Path -LiteralPath $TranslationsPath) {
  $Translations = @(Get-Content $TranslationsPath -Encoding UTF8 | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
  $ByParticipant = $Translations | Group-Object participant_id | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Count)" }
  Write-Host "translations total=$($Translations.Count) | $($ByParticipant -join ' ')"
} else {
  Write-Host "translations: none"
}

# failures (carried-forward historical failures included)
$Failures = @()
$FailuresPath = Join-Path $RunDir 'translation-failures.jsonl'
if (Test-Path -LiteralPath $FailuresPath) {
  $Failures = @(Get-Content $FailuresPath -Encoding UTF8 | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
}
$TranslatedKeys = @($Translations | ForEach-Object { $_.stable_key })
$Unresolved = @($Failures | Where-Object { $TranslatedKeys -notcontains $_.stable_key })
Write-Host "translation-failures historical=$($Failures.Count) unresolved=$($Unresolved.Count)"
if ($Unresolved.Count -gt 0) {
  $Unresolved | Select-Object -First 10 | ForEach-Object { Write-Host "  UNRESOLVED $($_.participant_id) $($_.source_id) $($_.target_language) [$($_.final_disposition)]" }
}

# judge records
foreach ($Name in @('judge-raw', 'judge-normalized', 'judge-metrics', 'judge-failures')) {
  $Path = Join-Path $RunDir "$Name.jsonl"
  $Count = if (Test-Path -LiteralPath $Path) { @(Get-Content $Path -Encoding UTF8 | Where-Object { $_.Trim() }).Count } else { 0 }
  Write-Host "$Name=$Count"
}

$IdsPath = Join-Path $RunDir 'judge-batch-custom-ids.json'
if (Test-Path -LiteralPath $IdsPath) {
  $Ids = Get-Content $IdsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "batch-custom-id map entries=$(@($Ids).Count)"
}

$AttemptsPath = Join-Path $RunDir 'judge-batch-submission-attempts.jsonl'
if (Test-Path -LiteralPath $AttemptsPath) {
  Write-Host "batch-submission-attempts=$(@(Get-Content $AttemptsPath -Encoding UTF8 | Where-Object { $_.Trim() }).Count)"
}

# fork prepare marker
$MarkerPath = Join-Path $RunDir 'fork-prepared.json'
if (Test-Path -LiteralPath $MarkerPath) {
  Write-Host "fork-prepared=yes"
} else {
  Write-Host "fork-prepared=NO (fork copy incomplete — do not resume; delete this run dir and re-run fresh fork)"
}

# reports
$RunStatusPath = Join-Path $RunDir 'reports\run-status.json'
if (Test-Path -LiteralPath $RunStatusPath) {
  $Status = Get-Content $RunStatusPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host "reports: benchmarkValid=$($Status.benchmarkValid) totalExpected=$($Status.totalExpected) totalNormalized=$($Status.totalNormalized) commonCells=$($Status.commonCellCount)"
} else {
  Write-Host "reports: not yet generated"
}

# console log tail
$LogPath = Join-Path $RunDir "$RunId.console.log"
if (Test-Path -LiteralPath $LogPath) {
  Write-Host "--- console log tail ---"
  Get-Content $LogPath -Tail 12
} else {
  Write-Host "console log: not found ($LogPath)"
}
