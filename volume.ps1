# System master volume for the music widget.
#
# SMTC has no per-session volume, so the widget controls the default playback
# device's master volume through Core Audio. This is the same volume the Windows
# volume keys change. One shot per action; the widget debounces slider moves.
param(
  [ValidateSet('get', 'set', 'mute', 'unmute', 'toggle')][string]$Action = 'get',
  [int]$Value = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator
{
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice
{
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    int OpenPropertyStore(int access, out IntPtr properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume
{
    int RegisterControlChangeNotify(IntPtr notify);
    int UnregisterControlChangeNotify(IntPtr notify);
    int GetChannelCount(out int count);
    int SetMasterVolumeLevel(float level, ref Guid eventContext);
    int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
    int GetMasterVolumeLevel(out float level);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float level, ref Guid eventContext);
    int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
    int GetChannelVolumeLevel(uint channel, out float level);
    int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute(int mute, ref Guid eventContext);
    int GetMute(out int mute);
}

public static class MusicSystemVolume
{
    public static IAudioEndpointVolume Get()
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDevice device;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object instance;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, 1, IntPtr.Zero, out instance));
        return (IAudioEndpointVolume)instance;
    }

    public static float GetVolume()
    {
        float value;
        Marshal.ThrowExceptionForHR(Get().GetMasterVolumeLevelScalar(out value));
        return value;
    }

    public static bool GetMute()
    {
        int value;
        Marshal.ThrowExceptionForHR(Get().GetMute(out value));
        return value != 0;
    }

    public static void SetVolume(float value)
    {
        Guid context = Guid.Empty;
        Marshal.ThrowExceptionForHR(Get().SetMasterVolumeLevelScalar(value, ref context));
    }

    public static void SetMute(bool value)
    {
        Guid context = Guid.Empty;
        Marshal.ThrowExceptionForHR(Get().SetMute(value ? 1 : 0, ref context));
    }
}
'@

function Write-Result($payload) {
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
}

try {
  $volume = [MusicSystemVolume]::GetVolume()
  $muted = [MusicSystemVolume]::GetMute()

  switch ($Action) {
    'set' {
      $next = [Math]::Max(0, [Math]::Min(100, $Value))
      [MusicSystemVolume]::SetVolume([single]($next / 100))
      if ($muted) { [MusicSystemVolume]::SetMute($false) }
    }
    'mute' { [MusicSystemVolume]::SetMute($true) }
    'unmute' { [MusicSystemVolume]::SetMute($false) }
    'toggle' { [MusicSystemVolume]::SetMute(-not $muted) }
  }

  $volume = [MusicSystemVolume]::GetVolume()
  $muted = [MusicSystemVolume]::GetMute()
  Write-Result @{
    ok = $true
    volume = [int][Math]::Round($volume * 100)
    muted = $muted
  }
} catch {
  Write-Result @{
    ok = $false
    error = 'volume-failed'
    message = $_.Exception.Message
  }
}
