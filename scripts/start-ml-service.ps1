$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $repoRoot "ml-service")

$env:ML_BIND_HOST = "127.0.0.1"
$env:ML_BIND_PORT = "8099"

if (Test-Path ".\.venv\Scripts\python.exe") {
  & ".\.venv\Scripts\python.exe" "service\server.py"
} else {
  python "service\server.py"
}
