# Windows SMTC watcher for the music board.
#
# The Windows Runtime exposes media sessions only through WinRT events, and
# Windows PowerShell cannot run scriptblock event handlers on WinRT's threads.
# A tiny compiled .NET helper (Add-Type below) is used as the event sink: it
# only signals an AutoResetEvent, while this script rebuilds and prints one
# JSON snapshot per change. Nothing here polls the session state.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ProgressPreference = 'SilentlyContinue'

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

Add-Type -TypeDefinition @'
using System;
using System.Threading;

public static class DshMusicSignal
{
    public static readonly AutoResetEvent Signal = new AutoResetEvent(false);

    public static void OnChanged(object sender, object args)
    {
        Signal.Set();
    }
}
'@

function Write-Payload($payload) {
  $json = $payload | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Get-AppName([string]$appId) {
  if ([string]::IsNullOrWhiteSpace($appId)) { return 'Media' }

  $known = @{
    'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' = 'Spotify'
    'Spotify.exe' = 'Spotify'
    'MSEdge' = 'Microsoft Edge'
    'Microsoft.MicrosoftEdge_8wekyb3d8bbwe!MicrosoftEdge' = 'Microsoft Edge'
    'Chrome' = 'Google Chrome'
    'Google Chrome' = 'Google Chrome'
    'Yandex' = 'Yandex'
    'A025C540.Yandex.Music_vfvw9svesycw6!App' = 'Yandex Music'
    'Opera' = 'Opera'
    'Mozilla.Firefox' = 'Firefox'
    'Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic' = 'Media Player'
    'Microsoft.ZuneVideo_8wekyb3d8bbwe!Microsoft.ZuneVideo' = 'Films & TV'
    'vlc' = 'VLC'
    'AIMP' = 'AIMP'
    'foobar2000' = 'foobar2000'
    'MusicBee' = 'MusicBee'
  }
  if ($known.ContainsKey($appId)) { return $known[$appId] }

  if ($appId -match '(?i)Yandex\.Music') { return 'Yandex Music' }
  if ($appId -match '(?i)Yandex') { return 'Yandex' }
  if ($appId -match '(?i)Spotify') { return 'Spotify' }
  if ($appId -match '(?i)Firefox') { return 'Firefox' }
  if ($appId -match '(?i)Edge') { return 'Microsoft Edge' }
  if ($appId -match '(?i)Chrome') { return 'Google Chrome' }
  if ($appId -match '(?i)vlc') { return 'VLC' }

  $name = $appId
  $bang = $name.LastIndexOf('!')
  if ($bang -ge 0) { $name = $name.Substring($bang + 1) }
  $name = $name -replace '\.exe$', ''
  $name = $name -replace '_[a-z0-9]{10,}$', ''
  $name = $name -replace '^Microsoft\.', ''
  $name = $name -replace '^([A-Za-z0-9]+)\..*$', '$1'
  $name = $name -creplace '([a-z])([A-Z])', '$1 $2'
  if ([string]::IsNullOrWhiteSpace($name)) { return $appId }
  return $name
}

function Get-StatusName($status) {
  switch ([string]$status) {
    'Playing' { return 'playing' }
    'Paused' { return 'paused' }
    default { return 'idle' }
  }
}

function Get-DurationMs($timeline) {
  $start = $timeline.StartTime.TotalMilliseconds
  $end = $timeline.EndTime.TotalMilliseconds
  $value = $end - $start
  if ($value -lt 0) { return 0 }
  return [long]$value
}

function Get-PositionMs($timeline) {
  $start = $timeline.StartTime.TotalMilliseconds
  $value = $timeline.Position.TotalMilliseconds - $start
  if ($value -lt 0) { return 0 }
  return [long]$value
}

function New-Snapshot {
  $sessions = @()
  try {
    $sessions = $script:manager.GetSessions()
  } catch {
    return $null
  }

  $rows = New-Object System.Collections.Generic.List[object]
  $seen = @{}

  foreach ($session in $sessions) {
    try {
      $appId = [string]$session.SourceAppUserModelId
      $playback = $session.GetPlaybackInfo()
      $status = Get-StatusName $playback.PlaybackStatus
      $media = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $timeline = $session.GetTimelineProperties()

      $title = ([string]$media.Title).Trim()
      $artist = ([string]$media.Artist).Trim()
      $album = ([string]$media.AlbumTitle).Trim()

      # Closed sessions can linger without metadata; keep real paused/stopped
      # sources, drop empty ghosts so the widget can disappear when music ends.
      if ($status -eq 'idle' -and $title -eq '' -and $artist -eq '') { continue }
      if ($appId -eq '' -and $title -eq '' -and $artist -eq '') { continue }

      $base = if ($appId -eq '') { 'source' } else { $appId }
      if ($seen.ContainsKey($base)) {
        $seen[$base] = $seen[$base] + 1
      } else {
        $seen[$base] = 1
      }
      $id = if ($seen[$base] -eq 1) { $base } else { $base + '#' + $seen[$base] }

      $canPlayPause = $true
      $canNext = $true
      $canPrevious = $true
      $canSeek = $false
      $controls = $playback.Controls
      if ($null -ne $controls) {
        $canPlayPause = [bool]($controls.IsPlayPauseToggleEnabled -or $controls.IsPlayEnabled -or $controls.IsPauseEnabled)
        $canNext = [bool]$controls.IsNextEnabled
        $canPrevious = [bool]$controls.IsPreviousEnabled
        $canSeek = [bool]$controls.IsPlaybackPositionEnabled
      }

      $row = [ordered]@{
        id = $id
        appId = $appId
        app = Get-AppName $appId
        title = $title
        artist = $artist
        album = $album
        status = $status
        positionMs = Get-PositionMs $timeline
        durationMs = Get-DurationMs $timeline
        canPlayPause = $canPlayPause
        canNext = $canNext
        canPrevious = $canPrevious
        canSeek = $canSeek
      }
      $rows.Add($row)
    } catch {
      # A session can disappear between enumeration and property reads.
    }
  }

  return ,$rows.ToArray()
}

$script:subs = @{}
$script:managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$script:sessionType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSession, Windows.Media.Control, ContentType=WindowsRuntime]
$script:handler = [DshMusicSignal].GetMethod('OnChanged')

$script:addPlayback = $script:sessionType.GetMethod('add_PlaybackInfoChanged')
$script:addMedia = $script:sessionType.GetMethod('add_MediaPropertiesChanged')
$script:addTimeline = $script:sessionType.GetMethod('add_TimelinePropertiesChanged')
$script:playbackDelegate = [System.Delegate]::CreateDelegate($script:addPlayback.GetParameters()[0].ParameterType, $script:handler)
$script:mediaDelegate = [System.Delegate]::CreateDelegate($script:addMedia.GetParameters()[0].ParameterType, $script:handler)
$script:timelineDelegate = [System.Delegate]::CreateDelegate($script:addTimeline.GetParameters()[0].ParameterType, $script:handler)

function Remove-Subscription($record) {
  if ($null -eq $record) { return }
  try {
    if ($null -ne $record.Playback) { $record.Session.remove_PlaybackInfoChanged($record.Playback) }
  } catch { }
  try {
    if ($null -ne $record.Media) { $record.Session.remove_MediaPropertiesChanged($record.Media) }
  } catch { }
  try {
    if ($null -ne $record.Timeline) { $record.Session.remove_TimelinePropertiesChanged($record.Timeline) }
  } catch { }
}

function Sync-Subscriptions($sessions) {
  $present = @{}
  foreach ($session in $sessions) {
    try {
      $appId = [string]$session.SourceAppUserModelId
      if ($appId -eq '') { continue }
      $present[$appId] = $true
      $record = $script:subs[$appId]
      $same = $false
      if ($null -ne $record) {
        try { $same = [object]::ReferenceEquals($record.Session, $session) } catch { $same = $false }
      }
      if ($same) { continue }
      if ($null -ne $record) { Remove-Subscription $record }
      $fresh = [pscustomobject]@{
        Session = $session
        Playback = $null
        Media = $null
        Timeline = $null
      }
      try { $fresh.Playback = $session.add_PlaybackInfoChanged($script:playbackDelegate) } catch { }
      try { $fresh.Media = $session.add_MediaPropertiesChanged($script:mediaDelegate) } catch { }
      try { $fresh.Timeline = $session.add_TimelinePropertiesChanged($script:timelineDelegate) } catch { }
      $script:subs[$appId] = $fresh
    } catch { }
  }

  foreach ($appId in @($script:subs.Keys)) {
    if (-not $present.ContainsKey($appId)) {
      Remove-Subscription $script:subs[$appId]
      $script:subs.Remove($appId)
    }
  }
}

try {
  $script:manager = Await ($script:managerType::RequestAsync()) ($script:managerType)
} catch {
  Write-Payload @{ type = 'unsupported'; message = $_.Exception.Message }
  exit 1
}

try {
  $managerAdd = $script:managerType.GetMethod('add_SessionsChanged')
  $managerDelegate = [System.Delegate]::CreateDelegate($managerAdd.GetParameters()[0].ParameterType, $script:handler)
  $managerToken = $managerAdd.Invoke($script:manager, @($managerDelegate))
} catch {
  Write-Payload @{ type = 'unsupported'; message = $_.Exception.Message }
  exit 1
}

try {
  $initial = $script:manager.GetSessions()
  Sync-Subscriptions $initial
  Write-Payload @{ type = 'snapshot'; sessions = (New-Snapshot) }
} catch {
  Write-Payload @{ type = 'error'; message = $_.Exception.Message }
}

while ($true) {
  [void][DshMusicSignal]::Signal.WaitOne()
  try {
    $current = $script:manager.GetSessions()
    Sync-Subscriptions $current
    $snapshot = New-Snapshot
    if ($null -ne $snapshot) {
      Write-Payload @{ type = 'snapshot'; sessions = $snapshot }
    }
  } catch {
    Write-Payload @{ type = 'error'; message = $_.Exception.Message }
    Start-Sleep -Milliseconds 250
  }
}
