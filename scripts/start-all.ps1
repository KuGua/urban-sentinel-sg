$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $scriptDir "start-ml-service.ps1")
)

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $scriptDir "start-backend.ps1")
)

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $scriptDir "start-web.ps1")
)

Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $scriptDir "start-mobile.ps1")
)
