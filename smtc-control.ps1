# One-shot SMTC transport command for the music board.
#
# The watcher owns state delivery; commands such as play/pause, next and
# previous are rare enough to run in a fresh PowerShell process. The session is
# addressed by the SourceAppUserModelId already present in the latest snapshot,
# and the action name is restricted by the Host half before this script runs.
param(
  [Parameter(Mandatory = $true)][string]$AppId,
  [Parameter(Mandatory = $true)][string]$Action,
  [int]$Index = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $netTask = $asTask.Invoke($null, @($operation))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

function Write-Payload($payload) {
  $json = $payload | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

try {
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $manager = Await ($managerType::RequestAsync()) ($managerType)

  $session = $null
  $matched = 0
  foreach ($candidate in $manager.GetSessions()) {
    if ([string]$candidate.SourceAppUserModelId -eq $AppId) {
      if ($matched -eq $Index) {
        $session = $candidate
        break
      }
      $matched++
    }
  }
  if ($null -eq $session) {
    Write-Payload @{ ok = $false; error = 'not-found' }
    exit 0
  }

  $ok = $false
  switch ($Action) {
    'toggle' { $ok = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
    'play' { $ok = Await ($session.TryPlayAsync()) ([bool]) }
    'pause' { $ok = Await ($session.TryPauseAsync()) ([bool]) }
    'next' { $ok = Await ($session.TrySkipNextAsync()) ([bool]) }
    'previous' { $ok = Await ($session.TrySkipPreviousAsync()) ([bool]) }
    default {
      Write-Payload @{ ok = $false; error = 'unknown-action' }
      exit 0
    }
  }

  if ($ok) {
    Write-Payload @{ ok = $true }
  } else {
    Write-Payload @{ ok = $false; error = 'rejected' }
  }
} catch {
  Write-Payload @{ ok = $false; error = 'failed'; message = $_.Exception.Message }
}
