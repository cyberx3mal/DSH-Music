# Changelog

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
