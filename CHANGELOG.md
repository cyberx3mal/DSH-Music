# Changelog

## 1.2.6 — 2026-11-13

- The widget stays visible for 5 seconds when the media session list is
  temporarily empty (for example while switching tracks), then hides if there
  is still nothing to show. This removes the blink during track changes.

## 1.2.5 — 2026-11-13

- Quiet passages now fall almost to the bottom: the shared floor is reduced,
  low-level bands are gated, and the height curve is steeper.
- Left and right halves still rise together on loud material.
- Reduced the extra high-band gain so loud sections no longer look over-inflated.

## 1.2.4 — 2026-11-13

- High-frequency bars are lifted: FFT display range capped at 8 kHz, +1 dB per
  band tilt and a high-band display gain. Left and right halves now rise at
  similar heights instead of the right side staying low.
- A shared level floor keeps bars readable during loud sections while they still
  fall when the music gets quiet.

## 1.2.3 — 2026-11-13

- Equalizer now animates at 60 fps with requestAnimationFrame instead of
  re-rendering in 20 Hz steps, removing the choppy, fragment-like motion.
- Bars are interpolated across the FFT spectrum; the random per-bar multipliers
  are gone, so the shape follows the actual low-to-high frequency content.
- Full-height bars and fast attack/release remain.

## 1.2.2 — 2026-11-13

- Equalizer now spans the full widget height: quiet bands fall to almost
  nothing, loud bands jump instantly and reach close to the top.
- Instant attack, fast decay and faster FFT band release for real rises/falls.

## 1.2.1 — 2026-11-13

- Equalizer is more responsive: 20 Hz level updates, stronger amplitude mapping,
  per-bar attack/decay, larger bars, higher contrast and a subtle glow.
- Refreshed preview for the plugin index.

## 1.2.0 — 2026-11-13

- Persistent audio/transport helper: app volume, system fallback, transport
  commands and live levels are handled by one long-lived process instead of a
  PowerShell process per click.
- Per-app volume for the active media source through WASAPI; system volume is
  used only when no app session exists.
- Audio-reactive background equalizer driven by WASAPI loopback RMS instead of
  a synthetic animation.
- Cover art is cached on disk, external lookups can be disabled with
  `DSH_MUSIC_COVER_ART=off`, and unchanged art is no longer sent on every
  snapshot.
- Larger hit targets, an accessible volume popover (focus, aria, Escape,
  reposition on resize/scroll), and reduced-motion handling.
- English README, MIT license, local check script and a GitHub Actions
  workflow template.

## 1.1.0 — 2026-11-13

- Cover chain: Apple iTunes → Deezer → MusicBrainz/Cover Art Archive, with a
  generated fallback.
- Accent frame, background, buttons and progress colors derived from the cover.
- Draggable seek slider when the source exposes a timeline.
- Volume button and popover in both expanded and collapsed layouts.
- Header cleanup, full-width transport, and a subtle audio background.

## 1.0.0 — 2026-11-13

- Initial left-sidebar music widget for Windows SMTC sources.
- Play/pause, previous/next, progress and multi-source list.
- Collapsible 31 px strip with quick controls and locale files (ru/en).
