/**
 * Browser half of the music board.
 *
 * A compact, always-visible widget in the sidebar foot (`sidebar.footer.action`)
 * shows every Windows media source, its current track and transport state. The
 * Host half pushes snapshots over an authenticated SSE route; this half never
 * polls, and folds them into the same collapsible shell as the projects board.
 */
window.__ModuleLoader__.load({
  id: '@local/music-board',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'musicBoard'
    const STREAM_PATH = '/api/dsh-music/stream'
    const ACTION_PATH = '/api/dsh-music/action'
    const VOLUME_PATH = '/api/dsh-music/volume'
    const COLLAPSE_KEY = 'music-board:collapsed'
    const STATE_RANK = { playing: 0, paused: 1, idle: 2 }

    const dictionaries = {
      en: {
        panel: 'Music',
        collapseWidget: 'Collapse music',
        expandWidget: 'Expand music',
        noTitle: 'Untitled',
        mediaSource: 'Media source',
        play: 'Play',
        pause: 'Pause',
        next: 'Next track',
        previous: 'Previous track',
        openSource: 'Open {app} in the player',
        otherSources: 'More sources',
        volume: 'Volume',
        appVolume: 'App volume',
        systemVolume: 'System volume',
        mute: 'Mute',
        unmute: 'Unmute',
        seek: 'Seek',
        progress: 'Playback position',
        progressValue: '{position} of {duration}',
        actionFailed: 'Could not control the player.',
        statusPlaying: 'playing',
        statusPaused: 'paused',
        statusIdle: 'stopped',
      },
      ru: {
        panel: 'Музыка',
        collapseWidget: 'Свернуть музыку',
        expandWidget: 'Развернуть музыку',
        noTitle: 'Без названия',
        mediaSource: 'Источник',
        play: 'Играть',
        pause: 'Пауза',
        next: 'Следующий трек',
        previous: 'Предыдущий трек',
        openSource: 'Открыть {app} в плеере',
        otherSources: 'Другие источники',
        volume: 'Громкость',
        appVolume: 'Громкость приложения',
        systemVolume: 'Системная громкость',
        mute: 'Выключить звук',
        unmute: 'Включить звук',
        seek: 'Перемотка',
        progress: 'Позиция воспроизведения',
        progressValue: '{position} из {duration}',
        actionFailed: 'Не удалось управлять плеером.',
        statusPlaying: 'играет',
        statusPaused: 'пауза',
        statusIdle: 'остановлено',
      },
    }

    /* ------------------------------------------------------------------ *
     * Reading and normalizing the pushed snapshots
     * ------------------------------------------------------------------ */

    /** Coerce an unknown value into bounded text. */
    function text(value, max) {
      if (typeof value !== 'string') return ''
      return value.length > max ? value.slice(0, max) : value
    }

    /** Coerce an unknown value into a non-negative number. */
    function millis(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, 86_400_000) : 0
    }

    /**
     * Keep the payload defensive: the Host is trusted, but a malformed snapshot
     * must never blank the slot.
     * @param raw - session array from a stream message.
     * @returns normalized sessions.
     */
    function normalizeSessions(raw) {
      const sessions = []
      if (!Array.isArray(raw)) return sessions
      for (const row of raw.slice(0, 32)) {
        if (row === null || typeof row !== 'object') continue
        if (typeof row.id !== 'string' || row.id === '') continue
        const status = row.status === 'playing' || row.status === 'paused' ? row.status : 'idle'
        const durationMs = millis(row.durationMs)
        sessions.push({
          id: row.id,
          appId: text(row.appId, 200),
          app: text(row.app, 80) || text(row.appId, 80) || 'Media',
          appKnown: text(row.appId, 200) !== '',
          title: text(row.title, 240),
          artist: text(row.artist, 200),
          album: text(row.album, 200),
          art: typeof row.art === 'string' && /^data:image\//.test(row.art) ? row.art : '',
          artIncluded: Object.prototype.hasOwnProperty.call(row, 'art'),
          status,
          positionMs: Math.min(millis(row.positionMs), durationMs > 0 ? durationMs : 86_400_000),
          durationMs,
          canPlayPause: row.canPlayPause !== false,
          canNext: row.canNext !== false,
          canPrevious: row.canPrevious !== false,
          canSeek: row.canSeek === true,
        })
      }
      return sessions
    }

    /**
     * Fold a stream message into the store snapshot.
     * @param message - decoded SSE message.
     * @returns the next snapshot, or undefined when the message is not a snapshot.
     */
    function nextSnapshot(message, previous) {
      if (message === null || typeof message !== 'object') return undefined
      if (message.supported === false) {
        return { supported: false, ready: true, sessions: [], at: Date.now() }
      }
      if (!Array.isArray(message.sessions)) return undefined
      const sessions = normalizeSessions(message.sessions)
      if (previous !== undefined && Array.isArray(previous.sessions)) {
        for (const session of sessions) {
          if (session.art !== '' || session.artIncluded) continue
          const before = previous.sessions.find(item => item.id === session.id)
          if (before !== undefined && before.art !== '') session.art = before.art
        }
      }
      return {
        supported: true,
        ready: true,
        sessions,
        at: typeof message.at === 'number' ? message.at : Date.now(),
      }
    }

    /**
     * Own the authenticated SSE subscription and the control endpoint.
     * @returns the store consumed by `useSyncExternalStore`.
     */
    function createMusicStore() {
      let snapshot = { supported: true, ready: false, sessions: [], at: 0 }
      let level = 0
      let bands = []
      const listeners = new Set()
      const levelListeners = new Set()
      let controller = null
      let retryTimer = null
      let retryCount = 0
      let disposed = false

      const publish = next => {
        snapshot = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('[music-board] listener', error)
          }
        }
      }

      const schedule = () => {
        if (disposed || retryTimer !== null) return
        const delay = Math.min(15000, 700 * 2 ** Math.min(retryCount, 4))
        retryCount += 1
        retryTimer = setTimeout(() => {
          retryTimer = null
          void connect()
        }, delay)
        if (typeof retryTimer.unref === 'function') retryTimer.unref()
      }

      const connect = async () => {
        if (disposed || controller !== null) return
        const abort = new AbortController()
        controller = abort
        try {
          const response = await fetch(STREAM_PATH, {
            method: 'GET',
            headers: { accept: 'text/event-stream' },
            credentials: 'same-origin',
            cache: 'no-store',
            signal: abort.signal,
          })
          if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
          retryCount = 0
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (!disposed) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let boundary = buffer.indexOf('\n\n')
            while (boundary >= 0) {
              const block = buffer.slice(0, boundary)
              buffer = buffer.slice(boundary + 2)
              boundary = buffer.indexOf('\n\n')
              const data = block
                .split(/\r?\n/)
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trim())
                .join('\n')
              if (data === '') continue
              let message
              try {
                message = JSON.parse(data)
              } catch {
                continue
              }
              if (message?.type === 'level') {
                const value = Number(message.value)
                if (Number.isFinite(value)) {
                  level = Math.max(0, Math.min(1, value))
                  bands = Array.isArray(message.bands)
                    ? message.bands
                        .slice(0, 32)
                        .map(band => (Number.isFinite(band) ? Math.max(0, Math.min(1, band)) : 0))
                    : []
                  for (const listener of [...levelListeners]) {
                    try {
                      listener()
                    } catch (error) {
                      console.error('[music-board] level listener', error)
                    }
                  }
                }
                continue
              }
              const next = nextSnapshot(message, snapshot)
              if (next !== undefined) publish(next)
            }
          }
        } catch (error) {
          if (!disposed && !abort.signal.aborted) console.error('[music-board] stream', error)
        } finally {
          if (controller === abort) controller = null
          if (!disposed) schedule()
        }
      }

      const action = async (id, appId, verb, positionMs) => {
        if (typeof id !== 'string' || id === '') return { ok: false, error: 'invalid-target' }
        if (typeof appId !== 'string' || appId === '') return { ok: false, error: 'invalid-target' }
        try {
          const response = await fetch(ACTION_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
            body: JSON.stringify(
              Number.isFinite(positionMs)
                ? { id, appId, action: verb, positionMs }
                : { id, appId, action: verb },
            ),
          })
          if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
          const answer = await response.json()
          return answer !== null && typeof answer === 'object' ? answer : { ok: false, error: 'invalid-answer' }
        } catch (error) {
          console.error('[music-board] action', error)
          return { ok: false, error: 'transport' }
        }
      }

      const getVolume = async (appId) => {
        try {
          const query = typeof appId === 'string' && appId !== '' ? `?appId=${encodeURIComponent(appId)}` : ''
          const response = await fetch(VOLUME_PATH + query, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
          })
          if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
          const answer = await response.json()
          return answer !== null && typeof answer === 'object' ? answer : { ok: false, error: 'invalid-answer' }
        } catch (error) {
          console.error('[music-board] volume', error)
          return { ok: false, error: 'transport' }
        }
      }

      const setVolume = async (payload) => {
        try {
          const response = await fetch(VOLUME_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
            body: JSON.stringify(payload),
          })
          if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
          const answer = await response.json()
          return answer !== null && typeof answer === 'object' ? answer : { ok: false, error: 'invalid-answer' }
        } catch (error) {
          console.error('[music-board] volume', error)
          return { ok: false, error: 'transport' }
        }
      }

      return {
        getSnapshot: () => snapshot,
        getLevel: () => level,
        getBands: () => bands,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        subscribeLevel(listener) {
          levelListeners.add(listener)
          return () => {
            levelListeners.delete(listener)
          }
        },
        start() {
          if (!disposed) void connect()
        },
        action,
        getVolume,
        setVolume,
        dispose() {
          disposed = true
          if (retryTimer !== null) {
            clearTimeout(retryTimer)
            retryTimer = null
          }
          if (controller !== null) {
            controller.abort()
            controller = null
          }
          listeners.clear()
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * Preferences
     * ------------------------------------------------------------------ */

    /** Read whether the widget was left collapsed. */
    function readCollapsedPreference() {
      try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSE_KEY) === '1'
      } catch (error) {
        console.error('[music-board] read collapsed', error)
        return false
      }
    }

    /** Persist the collapsed state. */
    function writeCollapsedPreference(value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0')
      } catch (error) {
        console.error('[music-board] save collapsed', error)
      }
    }

    /* ------------------------------------------------------------------ *
     * Derived view
     * ------------------------------------------------------------------ */

    /**
     * Order sessions for the compact source list. Playing sources come first,
     * then paused, then the rest; within a status the ordering is stable by app
     * and track so the list does not jump between snapshots.
     * @param sessions - normalized sessions.
     * @returns the rows and the preferred primary source.
     */
    function deriveView(sessions) {
      const compareText = (left, right) =>
        left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })

      const rows = sessions
        .slice()
        .sort((left, right) => {
          const rank = STATE_RANK[left.status] - STATE_RANK[right.status]
          return rank !== 0 ? rank : compareText(left.app, right.app) || compareText(left.title, right.title)
        })

      return {
        rows,
        primary: rows.find(session => session.status === 'playing') ?? rows[0],
      }
    }

    /**
     * Pick one of four artwork gradients from the source and track. The tone is
     * stable per track and only drives decorative artwork.
     * @param session - normalized session.
     * @returns a tone index from 0 to 3.
     */
    function coverTone(session) {
      const text = `${session.app}|${session.title}`
      let hash = 0
      for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) | 0
      }
      return Math.abs(hash) % 4
    }

    /** Format milliseconds as m:ss, or h:mm:ss for long tracks. */
    function formatClock(value) {
      if (!Number.isFinite(value) || value <= 0) return ''
      const total = Math.max(0, Math.round(value / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (hours > 0) {
        return `${String(hours)}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      }
      return `${String(minutes)}:${String(seconds).padStart(2, '0')}`
    }

    /**
     * Extrapolate a playing source's position for display between host
     * snapshots. This is presentation-only: the authoritative position still
     * arrives with the next SMTC event.
     * @param session - normalized session.
     * @param snapshotAt - epoch milliseconds when the snapshot was received.
     * @param now - current epoch milliseconds.
     * @returns the display position in milliseconds.
     */
    function displayedPosition(session, snapshotAt, now) {
      if (session.status !== 'playing' || session.durationMs <= 0) return session.positionMs
      const drift = Math.max(0, Math.min(now - snapshotAt, 86_400_000))
      return Math.min(session.durationMs, session.positionMs + drift)
    }

    /**
     * Keep the display clock moving only while a source is playing.
     * @param active - whether any visible source is playing.
     * @returns the current epoch milliseconds.
     */
    function useNow(active) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        if (!active) return undefined
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 500)
        return () => clearInterval(timer)
      }, [active])
      return now
    }

    /** Convert an RGB triplet to HSL. */
    function rgbToHsl(red, green, blue) {
      const r = red / 255
      const g = green / 255
      const b = blue / 255
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const lightness = (max + min) / 2
      if (max === min) return { h: 0, s: 0, l: lightness }
      const delta = max - min
      const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
      let hue
      if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6
      else if (max === g) hue = ((b - r) / delta + 2) / 6
      else hue = ((r - g) / delta + 4) / 6
      return { h: hue * 360, s: saturation, l: lightness }
    }

    /**
     * Extract a usable accent from an album cover. The result is kept in a
     * middle-lightness range so the widget background and buttons stay legible
     * in both themes.
     * @param image - loaded cover image.
     * @returns a CSS HSL color, or undefined for a grayscale cover.
     */
    function accentFromImage(image) {
      try {
        if (typeof document === 'undefined') return undefined
        const size = 32
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (context === null) return undefined
        context.drawImage(image, 0, 0, size, size)
        const pixels = context.getImageData(0, 0, size, size).data
        const buckets = new Map()
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] < 160) continue
          const red = pixels[index]
          const green = pixels[index + 1]
          const blue = pixels[index + 2]
          const hsl = rgbToHsl(red, green, blue)
          if (hsl.l < 0.12 || hsl.l > 0.9 || hsl.s < 0.16) continue
          const key = Math.floor(hsl.h / 30) % 12
          const weight = hsl.s * (1 - Math.abs(hsl.l - 0.55))
          const bucket = buckets.get(key) ?? { red: 0, green: 0, blue: 0, weight: 0 }
          bucket.red += red * weight
          bucket.green += green * weight
          bucket.blue += blue * weight
          bucket.weight += weight
          buckets.set(key, bucket)
        }
        let best
        for (const bucket of buckets.values()) {
          if (best === undefined || bucket.weight > best.weight) best = bucket
        }
        if (best === undefined || best.weight <= 0) return undefined
        const average = rgbToHsl(best.red / best.weight, best.green / best.weight, best.blue / best.weight)
        if (average.s < 0.12) return undefined
        const saturation = Math.max(0.42, Math.min(0.85, average.s))
        const lightness = Math.max(0.45, Math.min(0.62, average.l))
        return `hsl(${Math.round(average.h)}, ${Math.round(saturation * 100)}%, ${Math.round(lightness * 100)}%)`
      } catch {
        return undefined
      }
    }

    /**
     * Derive the widget accent from the current cover art.
     * @param art - data URL, or an empty string.
     * @returns the accent color, or undefined.
     */
    function useCoverAccent(art) {
      const [accent, setAccent] = React.useState(null)
      React.useEffect(() => {
        if (typeof art !== 'string' || art === '' || typeof Image === 'undefined') {
          setAccent(null)
          return undefined
        }
        let cancelled = false
        const image = new Image()
        image.onload = () => {
          if (cancelled) return
          setAccent(accentFromImage(image) ?? null)
        }
        image.onerror = () => {
          if (!cancelled) setAccent(null)
        }
        image.src = art
        return () => {
          cancelled = true
          image.onload = null
          image.onerror = null
        }
      }, [art])
      return accent
    }

    /**
     * Subscribe a component to a store snapshot.
     * @param store - store with `subscribe` and `getSnapshot`.
     * @returns the current snapshot.
     */
    function useSnapshot(store) {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      }
      const [value, setValue] = React.useState(store.getSnapshot)
      React.useEffect(() => store.subscribe(() => setValue(store.getSnapshot())), [store])
      return value
    }

    /* ------------------------------------------------------------------ *
     * Icons
     * ------------------------------------------------------------------ */

    /** Chevron for the collapsible header and source rows. */
    function Chevron(props) {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 10 10',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          className: 'mb-chevronIcon',
          'data-open': props.open ? 'true' : 'false',
        },
        h('path', {
          d: 'M3.5 1.5L7 5l-3.5 3.5',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Play or pause glyph. */
    function PlayPauseIcon(props) {
      const size = props.size ?? 10
      if (props.playing) {
        return h(
          'svg',
          { width: size, height: size, viewBox: '0 0 10 10', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
          h('rect', { x: 2.2, y: 1.8, width: 1.9, height: 6.4, rx: 0.6, fill: 'currentColor' }),
          h('rect', { x: 5.9, y: 1.8, width: 1.9, height: 6.4, rx: 0.6, fill: 'currentColor' }),
        )
      }
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 10 10', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M3 1.8l5 3.2-5 3.2z', fill: 'currentColor' }),
      )
    }

    /** Previous or next glyph. */
    function SkipIcon(props) {
      const previous = props.direction === 'previous'
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: previous ? 'M3.2 2v8M9.5 2L4.2 6l5.3 4z' : 'M8.8 2v8M2.5 2l5.3 4-5.3 4z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          fill: 'none',
        }),
      )
    }

    /** Musical note for generated cover artwork. */
    function NoteIcon(props) {
      const size = props.size ?? 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M6.2 2.4l6.4-1.4v8.2a2.25 2.25 0 1 1-1.5-2.12V4.2L7.7 5.3v7.9A2.25 2.25 0 1 1 6.2 11z',
          fill: 'currentColor',
        }),
      )
    }

    /** Speaker glyph, optionally muted. */
    function VolumeIcon(props) {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M2 4.2h2L7 2v8L4 7.8H2z', fill: 'currentColor' }),
        props.muted
          ? h('path', {
              d: 'M8.2 4.2l3.2 3.6M11.4 4.2L8.2 7.8',
              stroke: 'currentColor',
              strokeWidth: 1.2,
              strokeLinecap: 'round',
            })
          : h('path', {
              d: 'M8.6 4.2a2.6 2.6 0 0 1 0 3.6M10.2 2.8a4.6 4.6 0 0 1 0 6.4',
              stroke: 'currentColor',
              strokeWidth: 1.1,
              strokeLinecap: 'round',
            }),
      )
    }

    /** Animated equalizer for the cover of a playing source. */
    function EqualizerIcon() {
      return h(
        'span',
        { className: 'mb-eq', 'aria-hidden': 'true' },
        [0, 1, 2].map(index =>
          h('span', { key: index, className: 'mb-eqBar', style: { animationDelay: `${index * 0.18}s` } }),
        ),
      )
    }

    /** Audio-reactive equalizer bars behind the expanded widget. */
    function BackgroundEq(props) {
      const barsRef = React.useRef([])
      const targetsRef = React.useRef(new Array(28).fill(2))
      const displayRef = React.useRef(new Array(28).fill(2))
      const bars = []
      for (let index = 0; index < 28; index += 1) {
        bars.push(
          h('span', {
            key: index,
            className: 'mb-bgEqBar',
            ref: element => {
              barsRef.current[index] = element
            },
          }),
        )
      }

      React.useEffect(() => {
        const computeTargets = () => {
          const bands = props.music.getBands()
          const level = props.music.getLevel()
          const normalized = []
          const floor = Math.min(1, level * 0.08)
          const silent = level < 0.03
          if (bands.length > 1) {
            for (let band = 0; band < bands.length; band += 1) {
              const raw = Math.max(0, Math.min(1, bands[band]))
              const highGain = 1 + (band / Math.max(1, bands.length - 1)) * 0.45
              const spectrum = raw < 0.03 ? 0 : Math.min(1, raw * highGain)
              normalized[band] = silent ? 0 : Math.max(spectrum, floor)
            }
          } else {
            normalized[0] = silent ? 0 : level
          }
          for (let index = 0; index < 28; index += 1) {
            let value = normalized[0] ?? level
            if (normalized.length > 1) {
              const position = ((index + 0.5) * normalized.length) / 28 - 0.5
              const lower = Math.max(0, Math.min(normalized.length - 1, Math.floor(position)))
              const upper = Math.max(0, Math.min(normalized.length - 1, lower + 1))
              const fraction = Math.max(0, Math.min(1, position - lower))
              value = normalized[lower] * (1 - fraction) + normalized[upper] * fraction
            }
            const shaped = Math.pow(Math.max(0, Math.min(1, (value - 0.04) / 0.96)), 1.15)
            targetsRef.current[index] = props.playing ? 2 + shaped * 94 : 2
          }
        }

        computeTargets()
        const unsubscribe = props.music.subscribeLevel(computeTargets)
        let frame
        const animate = () => {
          for (let index = 0; index < 28; index += 1) {
            const element = barsRef.current[index]
            if (element === null || element === undefined) continue
            const target = targetsRef.current[index] ?? 2
            const current = displayRef.current[index] ?? 2
            const next = current + (target - current) * (target >= current ? 0.55 : 0.22)
            displayRef.current[index] = next
            element.style.height = `${Math.max(2, Math.min(98, next)).toFixed(2)}%`
          }
          frame = requestAnimationFrame(animate)
        }
        frame = requestAnimationFrame(animate)
        return () => {
          unsubscribe()
          cancelAnimationFrame(frame)
        }
      }, [props.music, props.playing])

      return h(
        'div',
        { className: 'mb-bgEq', 'data-playing': props.playing ? 'true' : 'false', 'aria-hidden': 'true' },
        bars,
      )
    }

    /* ------------------------------------------------------------------ *
     * Widget
     * ------------------------------------------------------------------ */

    /**
     * Always-visible music widget with a now-playing card and compact sources.
     * @param props - slot props (`wide`) plus the registration's injected props.
     * @returns the widget element, or null when it should stay hidden.
     */
    function MusicFooter(props) {
      const { music, tr, wide } = props
      const snapshot = useSnapshot(music)
      const [collapsed, setCollapsed] = React.useState(readCollapsedPreference)
      const [selectedId, setSelectedId] = React.useState(null)
      const [pending, setPending] = React.useState(() => ({}))
      const [error, setError] = React.useState(null)
      const [volume, setVolume] = React.useState(null)
      const [muted, setMuted] = React.useState(false)
      const [volumeScope, setVolumeScope] = React.useState('system')
      const [volumeOpen, setVolumeOpen] = React.useState(false)
      const [volumeAnchor, setVolumeAnchor] = React.useState({ left: 0, top: 0, width: 184 })
      const [scrub, setScrub] = React.useState(null)
      const timers = React.useRef(new Set())
      const volumeTimer = React.useRef(null)
      const scrubTimer = React.useRef(null)
      const volumePopRef = React.useRef(null)
      const volumeTriggerRef = React.useRef(null)
      const volumeRangeRef = React.useRef(null)

      const view = React.useMemo(() => deriveView(snapshot.sessions), [snapshot])
      const primary = view.rows.find(session => session.id === selectedId) ?? view.primary
      const others = primary === undefined ? [] : view.rows.filter(session => session.id !== primary.id)
      const anyPlaying = !collapsed && view.rows.some(session => session.status === 'playing')
      const now = useNow(anyPlaying)
      const accent = useCoverAccent(primary?.art)

      React.useEffect(
        () => () => {
          for (const timer of timers.current) clearTimeout(timer)
          timers.current.clear()
          if (volumeTimer.current !== null) clearTimeout(volumeTimer.current)
          if (scrubTimer.current !== null) clearTimeout(scrubTimer.current)
        },
        [],
      )

      React.useEffect(() => {
        let cancelled = false
        void music.getVolume(primary?.appId ?? '').then(answer => {
          if (cancelled) return
          if (answer !== null && answer.ok === true && Number.isFinite(answer.volume)) {
            setVolume(Math.max(0, Math.min(100, Math.round(answer.volume))))
            setMuted(answer.muted === true)
            setVolumeScope(answer.scope === 'app' ? 'app' : 'system')
          }
        })
        return () => {
          cancelled = true
        }
      }, [music, primary?.appId])

      React.useEffect(() => {
        if (!volumeOpen) return undefined
        const onPointerDown = event => {
          const popover = volumePopRef.current
          if (popover !== null && popover.contains(event.target)) return
          if (event.target instanceof Element && event.target.closest('[data-volume-button="true"]') !== null) return
          closeVolumePopover(false)
        }
        const onKeyDown = event => {
          if (event.key === 'Escape') closeVolumePopover(true)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [volumeOpen])

      React.useEffect(() => {
        if (!volumeOpen) return undefined
        const frame = requestAnimationFrame(() => volumeRangeRef.current?.focus())
        const reposition = () => {
          const trigger = volumeTriggerRef.current
          if (trigger === null || !trigger.isConnected) {
            closeVolumePopover(false)
            return
          }
          positionVolumePopover(trigger.getBoundingClientRect())
        }
        window.addEventListener('resize', reposition)
        window.addEventListener('scroll', reposition, true)
        return () => {
          cancelAnimationFrame(frame)
          window.removeEventListener('resize', reposition)
          window.removeEventListener('scroll', reposition, true)
        }
      }, [volumeOpen])

      React.useEffect(() => {
        if (error === null) return undefined
        const timer = setTimeout(() => setError(null), 4000)
        return () => clearTimeout(timer)
      }, [error])

      if (!wide) return null
      if (!snapshot.ready || !snapshot.supported || snapshot.sessions.length === 0) return null

      const toggleCollapsed = () => {
        setVolumeOpen(false)
        const next = !collapsed
        setCollapsed(next)
        writeCollapsedPreference(next)
      }

      const clearPending = id => {
        setPending(previous => {
          if (previous[id] !== true) return previous
          const next = { ...previous }
          delete next[id]
          return next
        })
      }

      const act = (session, verb) => {
        if (pending[session.id] === true) return
        if (session.appId === '') {
          setError({ text: tr('actionFailed'), id: Date.now() })
          return
        }
        setPending(previous => ({ ...previous, [session.id]: true }))
        setError(null)
        void music
          .action(session.id, session.appId, verb)
          .then(answer => {
            if (answer === null || answer.ok !== true) {
              setError({ text: tr('actionFailed'), id: Date.now() })
            }
          })
          .catch(() => setError({ text: tr('actionFailed'), id: Date.now() }))
          .finally(() => {
            const timer = setTimeout(() => {
              timers.current.delete(timer)
              clearPending(session.id)
            }, 1400)
            timers.current.add(timer)
          })
      }

      const actionFor = session => (session.status === 'playing' ? 'pause' : 'play')
      const appNameOf = session =>
        session.appKnown === false ? tr('mediaSource') : session.app || tr('mediaSource')

      const applyVolume = next => {
        const value = Math.max(0, Math.min(100, Math.round(next)))
        setVolume(value)
        if (volumeTimer.current !== null) clearTimeout(volumeTimer.current)
        volumeTimer.current = setTimeout(() => {
          volumeTimer.current = null
          void music.setVolume({ volume: value, appId: primary?.appId ?? '' }).then(answer => {
            if (answer !== null && answer.ok === true) {
              if (Number.isFinite(answer.volume)) setVolume(Math.max(0, Math.min(100, Math.round(answer.volume))))
              setMuted(answer.muted === true)
              setVolumeScope(answer.scope === 'app' ? 'app' : 'system')
            }
          })
        }, 180)
      }

      const toggleMute = () => {
        const next = !muted
        setMuted(next)
        void music.setVolume({ muted: next, appId: primary?.appId ?? '' }).then(answer => {
          if (answer !== null && answer.ok === true) {
            if (Number.isFinite(answer.volume)) setVolume(Math.max(0, Math.min(100, Math.round(answer.volume))))
            setMuted(answer.muted === true)
            setVolumeScope(answer.scope === 'app' ? 'app' : 'system')
          }
        })
      }

      const positionVolumePopover = rect => {
        if (typeof window === 'undefined') return
        const width = Math.min(184, Math.max(120, window.innerWidth - 16))
        const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))
        const top = rect.top - 58 >= 8 ? rect.top - 58 : rect.bottom + 6
        setVolumeAnchor({ left, top, width })
      }

      const closeVolumePopover = (focus = true) => {
        setVolumeOpen(false)
        if (focus) volumeTriggerRef.current?.focus()
      }

      const toggleVolumePopover = event => {
        if (volumeOpen) {
          closeVolumePopover(true)
          return
        }
        volumeTriggerRef.current = event.currentTarget
        positionVolumePopover(event.currentTarget.getBoundingClientRect())
        setVolumeOpen(true)
      }

      const commitSeek = (session, value) => {
        const target = Math.max(0, Math.min(session.durationMs, Math.round(value)))
        setScrub({ id: session.id, value: target })
        if (scrubTimer.current !== null) clearTimeout(scrubTimer.current)
        void music.action(session.id, session.appId, 'seek', target).then(answer => {
          if (answer === null || answer.ok !== true) {
            setError({ text: tr('actionFailed'), id: Date.now() })
          }
        })
        scrubTimer.current = setTimeout(() => {
          scrubTimer.current = null
          setScrub(null)
        }, 1600)
      }

      const volumeTitle = volumeScope === 'app' ? tr('appVolume') : tr('systemVolume')
      const volumeButton = h(
        'button',
        {
          type: 'button',
          className: 'mb-volumeButton',
          'data-volume-button': 'true',
          'data-muted': muted ? 'true' : 'false',
          'aria-label': tr('volume'),
          'aria-haspopup': 'dialog',
          'aria-expanded': volumeOpen ? 'true' : 'false',
          'aria-controls': 'mb-volume-popover',
          title: volumeTitle,
          onClick: toggleVolumePopover,
        },
        h(VolumeIcon, { muted }),
      )

      const volumePopover = volumeOpen
        ? h(
            'div',
            {
              ref: volumePopRef,
              id: 'mb-volume-popover',
              className: 'mb-volumePop',
              role: 'dialog',
              'aria-label': tr('volume'),
              style: { left: volumeAnchor.left, top: volumeAnchor.top, width: volumeAnchor.width },
            },
            h(
              'button',
              {
                type: 'button',
                className: 'mb-volumeButton',
                'data-muted': muted ? 'true' : 'false',
                'aria-label': muted ? tr('unmute') : tr('mute'),
                title: muted ? tr('unmute') : tr('mute'),
                onClick: toggleMute,
              },
              h(VolumeIcon, { muted }),
            ),
            h('input', {
              ref: volumeRangeRef,
              type: 'range',
              className: 'mb-volumeRange',
              min: 0,
              max: 100,
              step: 1,
              value: volume ?? 0,
              disabled: volume === null,
              'aria-label': tr('volume'),
              title: volumeTitle,
              onChange: event => applyVolume(Number(event.target.value)),
            }),
            h('span', { className: 'mb-volumeValue' }, volume === null ? '—' : `${volume}%`),
          )
        : null

      const cover = (session, hero) => {
        const playing = session.status === 'playing'
        return h(
          'span',
          {
            className: hero ? 'mb-cover mb-coverHero' : 'mb-cover mb-coverSmall',
            'data-tone': String(coverTone(session)),
            'data-playing': playing ? 'true' : 'false',
            'aria-hidden': 'true',
          },
          session.art !== ''
            ? h('img', { className: 'mb-coverImage', src: session.art, alt: '' })
            : playing
              ? h(EqualizerIcon)
              : h(NoteIcon, { size: hero ? 22 : 13 }),
          session.art !== '' && playing
            ? h('span', { className: 'mb-coverPlaying' }, h(EqualizerIcon))
            : null,
        )
      }

      const headControls =
        collapsed && primary !== undefined
          ? h(
              'span',
              { className: 'mb-headControls' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mb-headButton',
                  'aria-label': tr('previous') + ' — ' + (primary.title || tr('noTitle')),
                  title: tr('previous'),
                  disabled: pending[primary.id] === true || primary.canPrevious === false,
                  onClick: () => act(primary, 'previous'),
                },
                h(SkipIcon, { direction: 'previous' }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mb-headPlay',
                  'aria-label': (primary.status === 'playing' ? tr('pause') : tr('play')) + ' — ' + (primary.title || tr('noTitle')),
                  title: primary.status === 'playing' ? tr('pause') : tr('play'),
                  'aria-busy': pending[primary.id] === true ? 'true' : 'false',
                  disabled: pending[primary.id] === true || primary.canPlayPause === false,
                  onClick: () => act(primary, actionFor(primary)),
                },
                h(PlayPauseIcon, { playing: primary.status === 'playing', size: 11 }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mb-headButton',
                  'aria-label': tr('next') + ' — ' + (primary.title || tr('noTitle')),
                  title: tr('next'),
                  disabled: pending[primary.id] === true || primary.canNext === false,
                  onClick: () => act(primary, 'next'),
                },
                h(SkipIcon, { direction: 'next' }),
              ),
              volumeButton,
            )
          : null

      const hero = session => {
        const title = session.title || tr('noTitle')
        const app = appNameOf(session)
        const tone = coverTone(session)
        const basePosition = displayedPosition(session, snapshot.at, now)
        const position = scrub !== null && scrub.id === session.id ? scrub.value : basePosition
        const seekable = session.durationMs > 0 && session.canSeek === true
        const rawElapsed = formatClock(position)
        const duration = formatClock(session.durationMs)
        const elapsed = rawElapsed !== '' ? rawElapsed : duration !== '' ? '0:00' : ''
        const percent = session.durationMs > 0 ? Math.max(0, Math.min(100, (position / session.durationMs) * 100)) : 0
        const playLabel = tr(session.status === 'playing' ? 'pause' : 'play')
        const busy = pending[session.id] === true

        return h(
          'div',
          {
            className: 'mb-hero',
            'data-tone': String(tone),
            'data-status': session.status,
          },
          h(
            'div',
            { className: 'mb-heroTop' },
            cover(session, true),
            h(
              'div',
              { className: 'mb-heroText' },
              h('span', { className: 'mb-eyebrow', title: app }, app),
              h('span', { className: 'mb-heroTitle', title }, title),
              session.artist !== '' ? h('span', { className: 'mb-heroArtist', title: session.artist }, session.artist) : null,
            ),
          ),
          duration !== ''
            ? h(
                'div',
                { className: 'mb-heroProgress' },
                h('span', { className: 'mb-time' }, elapsed !== '' ? elapsed : '0:00'),
                seekable
                  ? h('input', {
                      type: 'range',
                      className: 'mb-seek',
                      min: 0,
                      max: session.durationMs,
                      step: 1000,
                      value: Math.round(position),
                      style: { '--mb-seek': percent.toFixed(1) + '%' },
                      'aria-label': tr('seek'),
                      'aria-valuetext': tr('progressValue', {
                        position: elapsed !== '' ? elapsed : '0:00',
                        duration,
                      }),
                      onChange: event => setScrub({ id: session.id, value: Number(event.target.value) }),
                      onPointerUp: event => commitSeek(session, Number(event.currentTarget.value)),
                      onKeyUp: event => {
                        if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
                          commitSeek(session, Number(event.currentTarget.value))
                        }
                      },
                    })
                  : h(
                      'div',
                      {
                        className: 'mb-progress',
                        role: 'progressbar',
                        'aria-label': tr('progress'),
                        'aria-valuemin': 0,
                        'aria-valuemax': 100,
                        'aria-valuenow': Math.round(percent),
                        'aria-valuetext': tr('progressValue', { position: elapsed !== '' ? elapsed : '0:00', duration }),
                      },
                      h('span', { className: 'mb-progressFill', style: { width: percent.toFixed(1) + '%' } }),
                    ),
                h('span', { className: 'mb-time' }, duration),
              )
            : null,
          h(
            'div',
            { className: 'mb-heroControls' },
            h(
              'button',
              {
                type: 'button',
                className: 'mb-transportButton',
                'aria-label': tr('previous') + ' — ' + title,
                title: tr('previous'),
                disabled: busy || session.canPrevious === false,
                onClick: () => act(session, 'previous'),
              },
              h(SkipIcon, { direction: 'previous' }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mb-playButton mb-playButtonHero',
                'aria-label': playLabel + ' — ' + title,
                title: playLabel + ' — ' + title,
                'aria-busy': busy ? 'true' : 'false',
                disabled: busy || session.canPlayPause === false,
                onClick: () => act(session, actionFor(session)),
              },
              h(PlayPauseIcon, { playing: session.status === 'playing', size: 14 }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mb-transportButton',
                'aria-label': tr('next') + ' — ' + title,
                title: tr('next'),
                disabled: busy || session.canNext === false,
                onClick: () => act(session, 'next'),
              },
              h(SkipIcon, { direction: 'next' }),
            ),
          ),
        )
      }

      const row = session => {
        const title = session.title || tr('noTitle')
        const app = appNameOf(session)
        const playLabel = tr(session.status === 'playing' ? 'pause' : 'play')
        const busy = pending[session.id] === true
        return h(
          'div',
          { className: 'mb-other', key: session.id, 'data-pending': busy ? 'true' : 'false' },
          h(
            'button',
            {
              type: 'button',
              className: 'mb-otherMain',
              'aria-label': tr('openSource', { app }),
              title: tr('openSource', { app }),
              onClick: () => setSelectedId(session.id),
            },
            cover(session, false),
            h(
              'span',
              { className: 'mb-otherText' },
              h('span', { className: 'mb-otherTitle', title }, title),
              h('span', { className: 'mb-otherApp', title: app }, app),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'mb-otherPlay',
              'aria-label': playLabel + ' — ' + title,
              title: playLabel + ' — ' + title,
              disabled: busy || session.canPlayPause === false,
              onClick: () => act(session, actionFor(session)),
            },
            h(PlayPauseIcon, { playing: session.status === 'playing' }),
          ),
        )
      }

      return h(
        'div',
        {
          className: 'mb-foot',
          'data-collapsed': collapsed ? 'true' : 'false',
          'data-tone': primary === undefined ? '0' : String(coverTone(primary)),
          'data-single': others.length === 0 ? 'true' : 'false',
          style: accent === null ? undefined : { '--mb-accent': accent },
        },
        h(StyleSheet),
        collapsed ? null : h(BackgroundEq, { music, playing: primary !== undefined && primary.status === 'playing' }),
        collapsed
          ? h(
              'div',
              { className: 'mb-head' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mb-expand',
                  'aria-expanded': 'false',
                  title: tr('expandWidget'),
                  onClick: toggleCollapsed,
                },
                h(Chevron, { open: false }),
                primary?.artist
                  ? h('span', { className: 'mb-headArtist', title: primary.artist }, primary.artist)
                  : null,
                primary?.artist ? h('span', { className: 'mb-headSep', 'aria-hidden': 'true' }, '·') : null,
                h(
                  'span',
                  { className: 'mb-headTitle', title: primary?.title || tr('noTitle') },
                  primary?.title || tr('noTitle'),
                ),
              ),
              headControls,
            )
          : h(
              'div',
              { className: 'mb-topActions' },
              volumeButton,
              h(
                'button',
                {
                  type: 'button',
                  className: 'mb-collapse',
                  title: tr('collapseWidget'),
                  'aria-label': tr('collapseWidget'),
                  'aria-expanded': 'true',
                  onClick: toggleCollapsed,
                },
                h(Chevron, { open: false }),
              ),
            ),
        collapsed
          ? null
          : h(
              'div',
              { className: 'mb-list' },
              error !== null ? h('p', { className: 'mb-error', role: 'status' }, error.text) : null,
              primary !== undefined ? hero(primary) : null,
              others.length > 0
                ? h(
                    React.Fragment,
                    null,
                    h('div', { className: 'mb-sectionLabel' }, tr('otherSources')),
                    others.map(row),
                  )
                : null,
            ),
        volumePopover,
      )
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const CSS = `
.mb-foot{--mb-color:var(--mb-accent,var(--mb-tone,var(--dsw-alias-brand-primary)));box-sizing:border-box;width:100%;padding:6px 6px 5px;border:.5px solid color-mix(in srgb,var(--mb-color) 28%,var(--dsw-alias-border-l1));border-radius:10px;background:linear-gradient(180deg,color-mix(in srgb,var(--mb-color) 11%,var(--dsw-alias-bg-layer-1)) 0%,var(--dsw-alias-bg-layer-1) 54%);display:flex;flex-direction:column;gap:2px;margin-bottom:2px;flex:none;position:relative;overflow:hidden;}
.mb-foot[data-tone='0']{--mb-tone:var(--dsw-alias-brand-primary);}
.mb-foot[data-tone='1']{--mb-tone:var(--dsw-alias-state-success-primary);}
.mb-foot[data-tone='2']{--mb-tone:var(--dsw-alias-state-warn-primary);}
.mb-foot[data-tone='3']{--mb-tone:var(--dsw-alias-brand-primary);}
.mb-foot[data-collapsed='true']{height:31px;min-height:31px;padding:3px 5px 2px;justify-content:center;}
.mb-head{display:flex;align-items:center;gap:4px;padding:0 2px;min-width:0;position:relative;z-index:1;}
.mb-foot[data-collapsed='true'] .mb-head{padding:0 2px;min-height:24px;}
.mb-expand{display:flex;align-items:center;gap:4px;flex:1;min-width:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;padding:1px 2px;border-radius:6px;cursor:pointer;}
@media (hover:hover){.mb-expand:hover{background:color-mix(in srgb,var(--mb-color) 10%,transparent);}}
.mb-expand:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.mb-headArtist{flex:0 1 auto;min-width:0;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);}
.mb-headSep{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);}
.mb-headTitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-primary);}
.mb-topActions{position:absolute;top:5px;right:5px;z-index:3;display:flex;align-items:center;gap:1px;}\n.mb-collapse{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);padding:0;cursor:pointer;}
@media (hover:hover){.mb-collapse:hover{background:color-mix(in srgb,var(--mb-color) 14%,transparent);color:var(--dsw-alias-label-primary);}}
.mb-collapse:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.mb-collapse .mb-chevronIcon{transform:rotate(90deg);}
.mb-bgEq{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:space-between;gap:3px;padding:0 6px 4px;pointer-events:none;opacity:.17;color:var(--mb-color);z-index:0;overflow:hidden;filter:drop-shadow(0 0 5px color-mix(in srgb,var(--mb-color) 32%,transparent));}
.mb-bgEqBar{flex:1 1 0;min-width:2px;max-width:4px;height:2%;border-radius:3px 3px 0 0;background:currentColor;transition:none;will-change:height;}
.mb-bgEq[data-playing="false"] .mb-bgEqBar{animation-play-state:paused;opacity:.45;}
@keyframes mb-bg-eq{0%{transform:scaleY(.22)}70%{transform:scaleY(1)}100%{transform:scaleY(.62)}}
.mb-headControls{display:inline-flex;align-items:center;gap:1px;flex:none;}
.mb-headButton{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0;cursor:pointer;}
@media (hover:hover){.mb-headButton:hover{background:color-mix(in srgb,var(--mb-color) 14%,transparent);color:var(--dsw-alias-label-primary);}}
.mb-headButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.mb-headButton:disabled{cursor:default;opacity:.45;background:transparent;}
.mb-headPlay{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:999px;background:linear-gradient(135deg,color-mix(in srgb,var(--mb-color) 82%,var(--dsw-alias-bg-base)),color-mix(in srgb,var(--mb-color) 58%,var(--dsw-alias-bg-base)));color:var(--dsw-alias-label-primary);padding:0;cursor:pointer;box-shadow:0 1px 4px color-mix(in srgb,var(--mb-color) 32%,transparent);}
@media (hover:hover){.mb-headPlay:hover{filter:brightness(1.08);}}
.mb-headPlay:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.mb-headPlay:disabled{cursor:default;opacity:.45;box-shadow:none;}
.mb-chevronIcon{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease;}
.mb-chevronIcon[data-open='true']{transform:rotate(90deg);}
@media (prefers-reduced-motion:reduce){.mb-chevronIcon{transition:none;}}
.mb-list{position:relative;z-index:1;display:flex;flex-direction:column;gap:1px;max-height:min(46vh,380px);overflow:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);padding-bottom:1px;}
.mb-foot[data-single='true'] .mb-list{max-height:none;overflow:visible;}
.mb-hero{position:relative;display:flex;flex-direction:column;padding:2px 2px 1px;margin:0;border:0;background:transparent;box-shadow:none;overflow:visible;}
.mb-hero::before{content:'';position:absolute;top:-28px;left:-18px;width:150px;height:130px;border-radius:999px;background:radial-gradient(circle,color-mix(in srgb,var(--mb-color,var(--dsw-alias-brand-primary)) 22%,transparent),transparent 70%);pointer-events:none;}
.mb-heroTop{position:relative;z-index:1;display:flex;align-items:center;gap:11px;min-width:0;padding-right:56px;}
.mb-cover{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:9px;color:var(--dsw-alias-label-primary);overflow:hidden;}
.mb-coverHero{width:56px;height:56px;border-radius:13px;box-shadow:0 6px 18px color-mix(in srgb,var(--mb-color,var(--dsw-alias-brand-primary)) 26%,transparent),inset 0 0 0 .5px color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);}
.mb-coverSmall{width:30px;height:30px;border-radius:8px;}
.mb-cover[data-tone='0']{background:linear-gradient(135deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 50%,var(--dsw-alias-state-success-primary)));}
.mb-cover[data-tone='1']{background:linear-gradient(135deg,var(--dsw-alias-state-success-primary),color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,var(--dsw-alias-brand-primary)));}
.mb-cover[data-tone='2']{background:linear-gradient(135deg,var(--dsw-alias-state-warn-primary),color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-brand-primary)));}
.mb-cover[data-tone='3']{background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,var(--dsw-alias-state-warn-primary)),color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-state-success-primary)));}
.mb-coverImage{display:block;width:100%;height:100%;object-fit:cover;}
.mb-coverPlaying{position:absolute;right:3px;bottom:3px;display:inline-flex;align-items:center;justify-content:center;padding:2px 3px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 48%,transparent);backdrop-filter:blur(3px);color:var(--dsw-alias-label-primary);}
.mb-coverPlaying .mb-eq{height:9px;gap:1.5px;}
.mb-coverPlaying .mb-eqBar{width:2px;height:5px;}
.mb-coverPlaying .mb-eqBar:nth-child(2){height:8px;}
.mb-coverPlaying .mb-eqBar:nth-child(3){height:6px;}
.mb-eq{display:inline-flex;align-items:flex-end;gap:2px;height:16px;}
.mb-eqBar{display:block;width:3px;height:8px;border-radius:2px;background:currentColor;transform-origin:bottom;animation:mb-eq .9s ease-in-out infinite alternate;}
.mb-eqBar:nth-child(2){height:14px;animation-delay:.15s;}
.mb-eqBar:nth-child(3){height:10px;animation-delay:.3s;}
@keyframes mb-eq{0%{transform:scaleY(.45)}100%{transform:scaleY(1)}}
.mb-heroText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;}
.mb-eyebrow{font-size:9px;line-height:12px;letter-spacing:.6px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mb-heroTitle{font-size:14px;line-height:19px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mb-heroArtist{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mb-heroProgress{position:relative;z-index:1;display:flex;align-items:center;gap:8px;margin-top:10px;}
.mb-time{font-size:10px;line-height:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;min-width:25px;}
.mb-time:last-child{text-align:right;}
.mb-progress{flex:1;height:4px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);overflow:hidden;}\n.mb-seek{flex:1;min-width:0;height:4px;-webkit-appearance:none;appearance:none;border:0;border-radius:999px;background:linear-gradient(90deg,var(--mb-color) 0 var(--mb-seek,0%),color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent) var(--mb-seek,0%) 100%);outline:none;cursor:pointer;}\n.mb-seek::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:10px;height:10px;border-radius:999px;background:var(--mb-color);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-bg-layer-1) 85%,transparent);}\n.mb-seek::-moz-range-thumb{width:10px;height:10px;border:0;border-radius:999px;background:var(--mb-color);}\n.mb-seek:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:3px;}
.mb-progressFill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--mb-color),color-mix(in srgb,var(--mb-color) 45%,var(--dsw-alias-state-success-primary)));transition:width .45s linear;}
.mb-heroControls{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px;padding:0 4px;}
.mb-transportButton{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0;cursor:pointer;}
@media (hover:hover){.mb-transportButton:hover{background:color-mix(in srgb,var(--mb-color) 14%,transparent);color:var(--dsw-alias-label-primary);}}
.mb-transportButton:active{background:var(--dsw-alias-interactive-bg-active);}
.mb-transportButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.mb-transportButton:disabled{cursor:default;opacity:.45;background:transparent;}
.mb-playButton{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:999px;background:linear-gradient(135deg,color-mix(in srgb,var(--mb-color) 82%,var(--dsw-alias-bg-base)),color-mix(in srgb,var(--mb-color) 58%,var(--dsw-alias-bg-base)));color:var(--dsw-alias-label-primary);padding:0;cursor:pointer;box-shadow:0 2px 8px color-mix(in srgb,var(--mb-color) 34%,transparent);}
.mb-playButtonHero{width:34px;height:34px;}
@media (hover:hover){.mb-playButton:hover{filter:brightness(1.08);}}
.mb-playButton:active{transform:scale(.97);}
.mb-playButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px;}
.mb-playButton:disabled{cursor:default;opacity:.45;box-shadow:none;transform:none;}
.mb-volumeButton{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);padding:0;cursor:pointer;}
@media (hover:hover){.mb-volumeButton:hover{background:color-mix(in srgb,var(--mb-color) 14%,transparent);color:var(--dsw-alias-label-primary);}}
.mb-volumeButton[data-muted='true']{color:var(--mb-color);}
.mb-volumeButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.mb-volumeRange{flex:1;min-width:0;height:3px;-webkit-appearance:none;appearance:none;background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);border-radius:999px;outline:none;cursor:pointer;}
.mb-volumeRange::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:10px;height:10px;border-radius:999px;background:var(--mb-color);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-bg-layer-1) 85%,transparent);}
.mb-volumeRange::-moz-range-thumb{width:10px;height:10px;border:0;border-radius:999px;background:var(--mb-color);}
.mb-volumeRange:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:3px;}
.mb-volumeValue{flex:none;min-width:28px;text-align:right;font-size:9.5px;line-height:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}\n.mb-volumePop{position:fixed;z-index:1000;box-sizing:border-box;display:flex;align-items:center;gap:7px;padding:7px 8px;border:.5px solid color-mix(in srgb,var(--mb-color) 34%,var(--dsw-alias-border-l1));border-radius:9px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 6px 20px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);}\n.mb-volumePop .mb-volumeValue{min-width:30px;}
.mb-sectionLabel{padding:9px 3px 3px;font-size:8.5px;line-height:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);border-top:.5px solid color-mix(in srgb,var(--mb-color,var(--dsw-alias-border-l2)) 32%,var(--dsw-alias-border-l2));margin-top:6px;}
.mb-other{display:flex;align-items:center;gap:2px;border-radius:8px;min-width:0;}
@media (hover:hover){.mb-other:hover{background:var(--dsw-alias-interactive-bg-hover);}}
.mb-otherMain{display:flex;align-items:center;gap:7px;flex:1;min-width:0;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;padding:3px 2px;cursor:pointer;}
.mb-otherMain:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px;}
.mb-otherText{display:flex;flex-direction:column;gap:0;min-width:0;flex:1;}
.mb-otherTitle{font-size:11.5px;line-height:15px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mb-otherApp{font-size:9.5px;line-height:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mb-otherPlay{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:999px;background:color-mix(in srgb,var(--mb-color) 14%,transparent);color:var(--mb-color);padding:0;cursor:pointer;}
@media (hover:hover){.mb-otherPlay:hover{background:color-mix(in srgb,var(--mb-color) 24%,transparent);}}
.mb-otherPlay:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.mb-otherPlay:disabled{cursor:default;opacity:.45;background:transparent;}
.mb-other[data-pending='true']{opacity:.7;}
.mb-error{margin:0;padding:2px 5px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;}
@media (prefers-reduced-motion:reduce){.mb-eqBar{animation:none;}.mb-bgEqBar{transition:none;}.mb-progressFill{transition:none;}.mb-playButton:active{transform:none;}}
`

    /** The widget-local stylesheet element. */
    function StyleSheet() {
      return h('style', { 'data-music-board': '' }, CSS)
    }

    /* ------------------------------------------------------------------ *
     * Plugin
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'music-board: dictionaries')
        const tr = ctx.locale.bind(NS)
        const music = createMusicStore()
        music.start()

        ctx.effect(
          () => () => music.dispose(),
          'music-board: stream subscription',
        )

        /* ---- Sidebar footer order (shared convention with @local/sidebar-widget-order) ---- */
        const SIDEBAR_ORDER_KEY = 'dsh.sidebar.footer.order.v1'
        const SIDEBAR_ORDER_EVENT = 'dsh/sidebar-footer-order'

        const readSidebarOrder = () => {
          try {
            const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SIDEBAR_ORDER_KEY)
            const list = raw === null ? [] : JSON.parse(raw)
            return Array.isArray(list) ? list.filter(id => typeof id === 'string') : []
          } catch {
            return []
          }
        }

        const sidebarOrder = (id, fallback) => {
          const index = readSidebarOrder().indexOf(id)
          return index < 0 ? fallback : (index + 1) * 10
        }

        ctx.slots.inject('sidebar.footer.action', () => {
          let disposeEntry
          let live = true

          const install = () => {
            if (!live) return
            if (disposeEntry !== undefined) disposeEntry()
            disposeEntry = ctx.slots.register(
              {
                name: 'sidebar.footer.action',
                id: 'music-board-foot',
                order: sidebarOrder('music-board-foot', 30),
                locale: NS,
                label: () => tr('panel'),
                inject: () => ({ music, tr }),
              },
              MusicFooter,
            )
          }

          install()
          const off = ctx.on(SIDEBAR_ORDER_EVENT, install)
          return () => {
            live = false
            off()
            if (disposeEntry !== undefined) disposeEntry()
          }
        })
      },
    }
  },
})
