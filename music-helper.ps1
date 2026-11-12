# Persistent helper for the music widget: per-app volume, system fallback,
# live audio levels and one-shot SMTC transport commands over stdin.
#
# The helper is started once by the Host, receives one JSON command per line,
# and writes JSON responses plus level messages. Audio capability comes from
# Core Audio; SMTC transport comes from the same WinRT manager the state
# watcher uses.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -Language CSharp @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

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

[ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl
{
    int GetState(out int state);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid eventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid eventContext);
    int GetGroupingParam(out Guid groupingParam);
    int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
    int RegisterAudioSessionNotification(IntPtr newNotifications);
    int UnregisterAudioSessionNotification(IntPtr newNotifications);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2
{
    int GetState(out int state);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid eventContext);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid eventContext);
    int GetGroupingParam(out Guid groupingParam);
    int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
    int RegisterAudioSessionNotification(IntPtr newNotifications);
    int UnregisterAudioSessionNotification(IntPtr newNotifications);
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string identifier);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string identifier);
    int GetProcessId(out uint processId);
    int IsSystemSoundsSession();
    int SetDuckingPreference(bool optOut);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2
{
    int GetAudioSessionControl(ref Guid sessionGuid, uint streamFlags, out IAudioSessionControl sessionControl);
    int GetSimpleAudioVolume(ref Guid sessionGuid, uint streamFlags, out ISimpleAudioVolume audioVolume);
    int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnumerator);
    int RegisterSessionNotification(IntPtr sessionNotification);
    int UnregisterSessionNotification(IntPtr sessionNotification);
    int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
    int UnregisterDuckNotification(IntPtr duckNotification);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator
{
    int GetCount(out int sessionCount);
    int GetSession(int sessionIndex, out IAudioSessionControl sessionControl);
}

[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISimpleAudioVolume
{
    int SetMasterVolume(float level, ref Guid eventContext);
    int GetMasterVolume(out float level);
    int SetMute(int mute, ref Guid eventContext);
    int GetMute(out int mute);
}

[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioMeterInformation
{
    int GetPeakValue(out float peak);
    int GetMeteringChannelCount(out int count);
    int GetChannelsPeakValues(int channelCount, [MarshalAs(UnmanagedType.LPArray)] out float[] peaks);
    int QueryHardwareSupport(out int mask);
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

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient
{
    int Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr format, IntPtr audioSessionGuid);
    int GetBufferSize(out uint frames);
    int GetStreamLatency(out long latency);
    int GetCurrentPadding(out uint padding);
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    int GetMixFormat(out IntPtr format);
    int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr eventHandle);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioCaptureClient
{
    int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    int ReleaseBuffer(uint frames);
    int GetNextPacketSize(out uint frames);
}

[StructLayout(LayoutKind.Sequential, Pack = 2)]
public struct WAVEFORMATEX
{
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
}

public static class MusicLoopback
{
    private const int FftSize = 2048;
    private const int BandCount = 16;
    private static readonly float[] fftBuffer = new float[FftSize];
    private static readonly float[] bands = new float[BandCount];
    private static readonly object bandGate = new object();
    private static int fftIndex;
    private static volatile float currentLevel;
    private static int started;
    private static bool available;

    public static float Level()
    {
        return available ? currentLevel : 0f;
    }

    public static float[] Bands()
    {
        lock (bandGate) return (float[])bands.Clone();
    }

    private static void FeedSample(float sample, int sampleRate)
    {
        fftBuffer[fftIndex++] = sample;
        if (fftIndex < FftSize) return;
        fftIndex = 0;
        ComputeBands(sampleRate);
    }

    private static void ComputeBands(int sampleRate)
    {
        var re = new float[FftSize];
        var im = new float[FftSize];
        for (int i = 0; i < FftSize; i++)
        {
            double window = 0.5 - 0.5 * Math.Cos(2.0 * Math.PI * i / (FftSize - 1));
            re[i] = (float)(fftBuffer[i] * window);
        }
        FFT(re, im);

        float[] next = new float[BandCount];
        double minFrequency = 40.0;
        double maxFrequency = Math.Min(14000.0, sampleRate / 2.0);
        for (int band = 0; band < BandCount; band++)
        {
            double from = minFrequency * Math.Pow(maxFrequency / minFrequency, (double)band / BandCount);
            double to = minFrequency * Math.Pow(maxFrequency / minFrequency, (double)(band + 1) / BandCount);
            int first = Math.Max(1, (int)(from * FftSize / sampleRate));
            int last = Math.Min(FftSize / 2 - 1, (int)(to * FftSize / sampleRate));
            if (last < first) last = first;
            double sum = 0.0;
            int count = 0;
            for (int i = first; i <= last; i++)
            {
                sum += re[i] * re[i] + im[i] * im[i];
                count++;
            }
            double magnitude = Math.Sqrt(sum / Math.Max(1, count)) / FftSize;
            double db = 20.0 * Math.Log10(magnitude + 1e-9);
            next[band] = (float)Math.Max(0.0, Math.Min(1.0, (db + 68.0) / 58.0));
        }

        lock (bandGate)
        {
            for (int i = 0; i < BandCount; i++)
            {
                bands[i] = Math.Max(next[i], bands[i] * 0.82f);
            }
        }
    }

    private static void FFT(float[] re, float[] im)
    {
        int n = re.Length;
        int j = 0;
        for (int i = 1; i < n; i++)
        {
            int bit = n >> 1;
            while ((j & bit) != 0)
            {
                j ^= bit;
                bit >>= 1;
            }
            j ^= bit;
            if (i < j)
            {
                float tmp = re[i]; re[i] = re[j]; re[j] = tmp;
                tmp = im[i]; im[i] = im[j]; im[j] = tmp;
            }
        }
        for (int length = 2; length <= n; length <<= 1)
        {
            double angle = -2.0 * Math.PI / length;
            float wLengthRe = (float)Math.Cos(angle);
            float wLengthIm = (float)Math.Sin(angle);
            for (int start = 0; start < n; start += length)
            {
                float wRe = 1f;
                float wIm = 0f;
                for (int offset = 0; offset < length / 2; offset++)
                {
                    int even = start + offset;
                    int odd = even + length / 2;
                    float oddRe = re[odd] * wRe - im[odd] * wIm;
                    float oddIm = re[odd] * wIm + im[odd] * wRe;
                    re[odd] = re[even] - oddRe;
                    im[odd] = im[even] - oddIm;
                    re[even] += oddRe;
                    im[even] += oddIm;
                    float nextRe = wRe * wLengthRe - wIm * wLengthIm;
                    wIm = wRe * wLengthIm + wIm * wLengthRe;
                    wRe = nextRe;
                }
            }
        }
    }

    public static void Start()
    {
        if (Interlocked.Exchange(ref started, 1) == 1) return;
        var thread = new Thread(CaptureLoop);
        thread.IsBackground = true;
        thread.Start();
    }

    private static void CaptureLoop()
    {
        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDevice device;
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
            Guid clientIid = typeof(IAudioClient).GUID;
            object clientObject;
            Marshal.ThrowExceptionForHR(device.Activate(ref clientIid, 1, IntPtr.Zero, out clientObject));
            var client = (IAudioClient)clientObject;

            IntPtr formatPointer;
            Marshal.ThrowExceptionForHR(client.GetMixFormat(out formatPointer));
            var format = (WAVEFORMATEX)Marshal.PtrToStructure(formatPointer, typeof(WAVEFORMATEX));
            Marshal.ThrowExceptionForHR(client.Initialize(0, 0x00020000, 2000000, 0, formatPointer, IntPtr.Zero));

            Guid captureIid = typeof(IAudioCaptureClient).GUID;
            object captureObject;
            Marshal.ThrowExceptionForHR(client.GetService(ref captureIid, out captureObject));
            var capture = (IAudioCaptureClient)captureObject;
            Marshal.ThrowExceptionForHR(client.Start());
            available = true;

            var floatSamples = new float[4096];
            var shortSamples = new short[4096];
            float accumulated = 0f;
            long sampleCount = 0;
            var window = System.Diagnostics.Stopwatch.StartNew();

            while (true)
            {
                uint packet;
                if (capture.GetNextPacketSize(out packet) != 0) break;
                while (packet > 0)
                {
                    IntPtr data;
                    uint frames;
                    uint flags;
                    ulong devicePosition;
                    ulong qpcPosition;
                    if (capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition) != 0) break;
                    int count = (int)frames * format.nChannels;
                    if ((flags & 2) == 0 && data != IntPtr.Zero && count > 0)
                    {
                        if (format.wBitsPerSample == 32 && floatSamples.Length < count) floatSamples = new float[count];
                        if (format.wBitsPerSample == 16 && shortSamples.Length < count) shortSamples = new short[count];
                        if (format.wBitsPerSample == 32)
                        {
                            Marshal.Copy(data, floatSamples, 0, count);
                            int channels = Math.Max(1, (int)format.nChannels);
                            for (int frame = 0; frame < (int)frames; frame++)
                            {
                                float mono = 0f;
                                for (int channel = 0; channel < channels; channel++) mono += floatSamples[frame * channels + channel];
                                mono /= channels;
                                FeedSample(mono, (int)format.nSamplesPerSec);
                                accumulated += mono * mono;
                                sampleCount++;
                            }
                        }
                        else if (format.wBitsPerSample == 16)
                        {
                            Marshal.Copy(data, shortSamples, 0, count);
                            int channels = Math.Max(1, (int)format.nChannels);
                            for (int frame = 0; frame < (int)frames; frame++)
                            {
                                float mono = 0f;
                                for (int channel = 0; channel < channels; channel++) mono += shortSamples[frame * channels + channel] / 32768f;
                                mono /= channels;
                                FeedSample(mono, (int)format.nSamplesPerSec);
                                accumulated += mono * mono;
                                sampleCount++;
                            }
                        }
                    }
                    capture.ReleaseBuffer(frames);
                    if (capture.GetNextPacketSize(out packet) != 0) break;
                }

                if (window.ElapsedMilliseconds >= 60)
                {
                    float target = 0f;
                    if (sampleCount > 0)
                    {
                        float rms = (float)Math.Sqrt(accumulated / sampleCount);
                        target = Math.Min(1f, rms * 5f);
                    }
                    if (target > currentLevel) currentLevel = currentLevel * 0.35f + target * 0.65f;
                    else currentLevel = currentLevel * 0.82f + target * 0.18f;
                    accumulated = 0f;
                    sampleCount = 0;
                    window.Restart();
                }
                Thread.Sleep(15);
            }

            try { client.Stop(); } catch { }
            available = false;
        }
        catch
        {
            available = false;
        }
    }
}

public sealed class AudioSessionInfo
{
    public int Index;
    public uint ProcessId;
    public string ProcessName;
    public string Identifier;
    public string DisplayName;
    public float Volume;
    public bool Muted;
    public float Peak;
}

public static class MusicOutput
{
    private static readonly object Gate = new object();
    public static void WriteLine(string line)
    {
        lock (Gate) { Console.Out.WriteLine(line); Console.Out.Flush(); }
    }
}

public static class MusicAudio
{
    private static uint lastPid;

    private static IMMDevice Device()
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDevice device;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
        return device;
    }

    private static IAudioSessionManager2 Manager()
    {
        var device = Device();
        Guid iid = typeof(IAudioSessionManager2).GUID;
        object instance;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, 1, IntPtr.Zero, out instance));
        return (IAudioSessionManager2)instance;
    }

    private static IAudioEndpointVolume EndpointVolume()
    {
        var device = Device();
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object instance;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, 1, IntPtr.Zero, out instance));
        return (IAudioEndpointVolume)instance;
    }

    public static AudioSessionInfo[] List()
    {
        var manager = Manager();
        IAudioSessionEnumerator sessions;
        Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessions));
        int count;
        Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
        var result = new System.Collections.Generic.List<AudioSessionInfo>();
        for (int index = 0; index < count; index++)
        {
            IAudioSessionControl control;
            if (sessions.GetSession(index, out control) != 0 || control == null) continue;
            var info = new AudioSessionInfo { Index = index };
            try
            {
                var control2 = (IAudioSessionControl2)control;
                uint pid;
                if (control2.GetProcessId(out pid) == 0)
                {
                    info.ProcessId = pid;
                    try { info.ProcessName = Process.GetProcessById((int)pid).ProcessName; } catch { info.ProcessName = ""; }
                }
                try { control2.GetSessionIdentifier(out info.Identifier); } catch { info.Identifier = ""; }
                try { control2.GetDisplayName(out info.DisplayName); } catch { info.DisplayName = ""; }
            }
            catch { }
            try
            {
                var volume = (ISimpleAudioVolume)control;
                float level;
                if (volume.GetMasterVolume(out level) == 0) info.Volume = level;
                int mute;
                if (volume.GetMute(out mute) == 0) info.Muted = mute != 0;
            }
            catch { }
            try
            {
                var meter = (IAudioMeterInformation)control;
                float peak;
                if (meter.GetPeakValue(out peak) == 0) info.Peak = peak;
            }
            catch { }
            result.Add(info);
        }
        return result.ToArray();
    }

    public static AudioSessionInfo Best()
    {
        var list = List();
        AudioSessionInfo best = null;
        foreach (var item in list)
        {
            if (item.ProcessId == 0) continue;
            if (best == null || item.Peak > best.Peak) best = item;
        }
        if (best != null && best.Peak > 0.002f)
        {
            lastPid = best.ProcessId;
            return best;
        }
        if (lastPid != 0)
        {
            foreach (var item in list)
            {
                if (item.ProcessId == lastPid) return item;
            }
        }
        return best;
    }

    public static bool SetVolume(uint pid, float level)
    {
        bool changed = false;
        foreach (var item in List())
        {
            if (item.ProcessId != pid) continue;
            try
            {
                var manager = Manager();
                IAudioSessionEnumerator sessions;
                Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessions));
                int count;
                Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
                IAudioSessionControl control;
                if (sessions.GetSession(item.Index, out control) != 0 || control == null) continue;
                var volume = (ISimpleAudioVolume)control;
                Guid context = Guid.Empty;
                if (volume.SetMasterVolume(level, ref context) == 0) changed = true;
            }
            catch { }
        }
        return changed;
    }

    public static bool SetMute(uint pid, bool muted)
    {
        bool changed = false;
        foreach (var item in List())
        {
            if (item.ProcessId != pid) continue;
            try
            {
                var manager = Manager();
                IAudioSessionEnumerator sessions;
                Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessions));
                int count;
                Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
                IAudioSessionControl control;
                if (sessions.GetSession(item.Index, out control) != 0 || control == null) continue;
                var volume = (ISimpleAudioVolume)control;
                Guid context = Guid.Empty;
                if (volume.SetMute(muted ? 1 : 0, ref context) == 0) changed = true;
            }
            catch { }
        }
        return changed;
    }

    public static float GetSystemVolume()
    {
        float value;
        Marshal.ThrowExceptionForHR(EndpointVolume().GetMasterVolumeLevelScalar(out value));
        return value;
    }

    public static bool GetSystemMute()
    {
        int value;
        Marshal.ThrowExceptionForHR(EndpointVolume().GetMute(out value));
        return value != 0;
    }

    public static void SetSystemVolume(float value)
    {
        Guid context = Guid.Empty;
        Marshal.ThrowExceptionForHR(EndpointVolume().SetMasterVolumeLevelScalar(value, ref context));
    }

    public static void SetSystemMute(bool value)
    {
        Guid context = Guid.Empty;
        Marshal.ThrowExceptionForHR(EndpointVolume().SetMute(value ? 1 : 0, ref context));
    }
}

public static class MusicLevelPump
{
    public static volatile uint LastPid;

    public static void Start()
    {
        MusicLoopback.Start();
        var thread = new Thread(() =>
        {
            var invariant = CultureInfo.InvariantCulture;
            while (true)
            {
                try
                {
                    var best = MusicAudio.Best();
                    float level = MusicLoopback.Level();
                    if (level <= 0.001f && best != null)
                    {
                        LastPid = best.ProcessId;
                        level = Math.Max(0f, Math.Min(1f, best.Peak));
                    }
                    var bands = MusicLoopback.Bands();
                    var bandText = string.Join(",", Array.ConvertAll(bands, value => value.ToString("0.###", invariant)));
                    MusicOutput.WriteLine("{\"type\":\"level\",\"value\":" + level.ToString("0.###", invariant) + ",\"bands\":[" + bandText + "]}");
                }
                catch { }
                Thread.Sleep(80);
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }
}
'@

# WinRT manager and async helpers for transport commands.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($operation, $resultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
  $netTask = $asTask.Invoke($null, @($operation))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$manager = $null
try {
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
} catch { }

function Find-Session([string]$appId) {
  if ($null -eq $manager) { return $null }
  foreach ($session in $manager.GetSessions()) {
    if ([string]$session.SourceAppUserModelId -eq $appId) { return $session }
  }
  return $null
}

function Volume-State([string]$appId) {
  $forceSystem = $env:DSH_MUSIC_VOLUME -eq 'system'
  $best = if ($forceSystem) { $null } else { [MusicAudio]::Best() }
  if ($null -ne $best -and $best.ProcessId -ne 0) {
    return @{
      ok = $true
      volume = [int][Math]::Round($best.Volume * 100)
      muted = [bool]$best.Muted
      scope = 'app'
      appPid = [int]$best.ProcessId
    }
  }
  return @{
    ok = $true
    volume = [int][Math]::Round([MusicAudio]::GetSystemVolume() * 100)
    muted = [MusicAudio]::GetSystemMute()
    scope = 'system'
  }
}

function Set-VolumeState($cmd) {
  $forceSystem = $env:DSH_MUSIC_VOLUME -eq 'system'
  $best = if ($forceSystem) { $null } else { [MusicAudio]::Best() }
  $targetPid = 0
  $scope = 'system'
  if ($null -ne $best -and $best.ProcessId -ne 0) {
    $targetPid = [int]$best.ProcessId
    $scope = 'app'
  }
  $value = $cmd.volume
  $muted = $cmd.muted
  if ($null -ne $value) {
    $next = [Math]::Max(0, [Math]::Min(100, [int]$value))
    if ($scope -eq 'app') { [void][MusicAudio]::SetVolume([uint32]$targetPid, [single]($next / 100)) }
    else { [MusicAudio]::SetSystemVolume([single]($next / 100)) }
  }
  if ($null -ne $muted) {
    if ($scope -eq 'app') { [void][MusicAudio]::SetMute([uint32]$targetPid, [bool]$muted) }
    else { [MusicAudio]::SetSystemMute([bool]$muted) }
  }
  $state = Volume-State $cmd.appId
  $state.scope = if ($null -ne $best -and $best.ProcessId -ne 0) { 'app' } else { 'system' }
  return $state
}

[MusicLevelPump]::Start()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  try { $cmd = $line | ConvertFrom-Json } catch { continue }

  $response = @{ type = 'response'; requestId = $cmd.requestId; ok = $false }
  try {
    switch ($cmd.kind) {
      'control' {
        $session = Find-Session ([string]$cmd.appId)
        if ($null -eq $session) { $response.error = 'not-found' }
        else {
          $ok = $false
          switch ([string]$cmd.action) {
            'toggle' { $ok = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
            'play' { $ok = Await ($session.TryPlayAsync()) ([bool]) }
            'pause' { $ok = Await ($session.TryPauseAsync()) ([bool]) }
            'next' { $ok = Await ($session.TrySkipNextAsync()) ([bool]) }
            'previous' { $ok = Await ($session.TrySkipPreviousAsync()) ([bool]) }
            'seek' {
              $ticks = [long]([Math]::Max(0, [Math]::Min(86400000, [long]$cmd.positionMs)) * 10000)
              $ok = Await ($session.TryChangePlaybackPositionAsync($ticks)) ([bool])
            }
            default { $response.error = 'invalid-action' }
          }
          $response.ok = [bool]$ok
          if (-not $ok -and -not $response.ContainsKey('error')) { $response.error = 'rejected' }
        }
      }
      'volume.get' { $response = Volume-State ([string]$cmd.appId); $response.type = 'response'; $response.requestId = $cmd.requestId }
      'volume.set' { $response = Set-VolumeState $cmd; $response.type = 'response'; $response.requestId = $cmd.requestId }
      default { $response.error = 'invalid-kind' }
    }
  } catch {
    $response.ok = $false
    $response.error = 'failed'
  }
  [MusicOutput]::WriteLine(($response | ConvertTo-Json -Compress))
}
