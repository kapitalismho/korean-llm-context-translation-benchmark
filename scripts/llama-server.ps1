# Starts a llama.cpp server (Vulkan compute backend) for one benchmark model.
#
# Launch this script in its own visible PowerShell window (or via Start-Process).
# The server must be built with Vulkan support (GGML_VULKAN=ON) — e.g. the
# official llama.cpp release binaries for Windows ship with multiple backends
# including Vulkan, or build with: cmake -B build -DGGML_VULKAN=ON.
#
# Example (E4B QAT Q2 on port 8080, full GPU offload to Vulkan device 0):
#   powershell -ExecutionPolicy Bypass -File scripts\llama-server.ps1 `
#     -ModelPath "D:\models\gemma-4-E4B-it-qat-Q2.gguf" -Port 8080 -Device Vulkan0
#
# One server instance per model/port. Suggested layout for issue #1:
#   8080  gemma-4-E4B-it-qat-Q2.gguf (UD-Q2_K_XL)
#   8081  gemma-4-E4B-it-qat-Q4.gguf (UD-Q4_K_XL)
#   8082  gemma-4-E4B-it-fp16.gguf
#   8083  MiLMMT-46-4B-v1.0.f16.gguf (completion mode)

param(
    [Parameter(Mandatory = $true)][string]$ModelPath,
    [int]$Port = 8080,
    [int]$ContextSize = 8192,
    [int]$GpuLayers = 999,
    [string]$Device = '',
    [string]$LlamaServerExe = 'llama-server',
    [string]$LogPath = ''
)

$ErrorActionPreference = 'Stop'

$modelName = [System.IO.Path]::GetFileNameWithoutExtension($ModelPath)
$runId = "llamacpp-$modelName-port$Port"

if (-not $LogPath) {
    $logDir = Join-Path (Join-Path (Get-Location) 'output') 'llamacpp-logs'
    $LogPath = Join-Path $logDir "$runId.console.log"
}

New-Item -ItemType Directory -Force -Path (Split-Path $LogPath -Parent) | Out-Null
$host.UI.RawUI.WindowTitle = "llamacpp $modelName :$Port [$runId]"
Write-Host "Run ID: $runId"
Write-Host "Log: $LogPath"

$serverArgs = @(
    '-m', $ModelPath,
    '--host', '127.0.0.1',
    '--port', "$Port",
    '-c', "$ContextSize",
    '-ngl', "$GpuLayers"
)

if ($Device) {
    $serverArgs += @('--device', $Device)
}

Write-Host "llama-server $($serverArgs -join ' ')"

# llama-server writes its log to stderr; with ErrorActionPreference=Stop those
# lines surface as NativeCommandError and kill the pipeline. Relax it for the
# long-running server invocation (the server's own exit code is checked after).
$ErrorActionPreference = 'Continue'

& $LlamaServerExe @serverArgs 2>&1 | Tee-Object -FilePath $LogPath

Write-Host "llama-server exited (code $LASTEXITCODE). Window kept open for inspection."
