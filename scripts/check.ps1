$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  foreach ($file in @('index.js', 'client.js')) {
    node --check $file
    if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax failed: $file" }
  }

  foreach ($file in @('smtc-watcher.ps1', 'music-helper.ps1')) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $file), [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
      $errors | ForEach-Object { Write-Host $_.Message }
      throw "PowerShell syntax failed: $file"
    }
  }

  foreach ($file in @('package.json', 'locale/en.json', 'locale/ru.json')) {
    Get-Content -Raw $file | ConvertFrom-Json | Out-Null
  }

  Write-Host 'Checks passed.'
} finally {
  Pop-Location
}
