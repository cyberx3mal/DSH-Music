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
    function nextSnapshot(message) {
      if (message === null || typeof message !== 'object') return undefined
      if (message.supported === false) {
        return { supported: false, ready: true, sessions: [], at: Date.now() }
      }
      if (!Array.isArray(message.sessions)) return undefined
      return {
        supported: true,
        ready: true,
        sessions: normalizeSessions(message.sessions),
        at: typeof message.at === 'number' ? message.at : Date.now(),
      }
    }

    /**
     * Own the authenticated SSE subscription and the control endpoint.
     * @returns the store consumed by `useSyncExternalStore`.
     */
    function createMusicStore() {
      let snapshot = { supported: true, ready: false, sessions: [], at: 0 }
      const listeners = new Set()
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
              const next = nextSnapshot(message)
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

      const action = async (id, appId, verb) => {
        if (typeof id !== 'string' || id === '') return { ok: false, error: 'invalid-target' }
        if (typeof appId !== 'string' || appId === '') return { ok: false, error: 'invalid-target' }
        try {
          const response = await fetch(ACTION_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
            body: JSON.stringify({ id, appId, action: verb }),
          })
          if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
          const answer = await response.json()
          return answer !== null && typeof answer === 'object' ? answer : { ok: false, error: 'invalid-answer' }
        } catch (error) {
          console.error('[music-board] action', error)
          return { ok: false, error: 'transport' }
        }
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        start() {
          if (!disposed) void connect()
        },
        action,
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

    /**
     * Short state label used by the hero transport line.
     * @param session - normalized session.
     * @param tr - translate function.
     * @returns the localized state label.
     */
    function stateLabelOf(session, tr) {
      if (session.status === 'playing') return tr('statusPlaying')
      if (session.status === 'paused') return tr('statusPaused')
      return tr('statusIdle')
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
      const timers = React.useRef(new Set())

      const view = React.useMemo(() => deriveView(snapshot.sessions), [snapshot])
      const primary = view.rows.find(session => session.id === selectedId) ?? view.primary
      const others = primary === undefined ? [] : view.rows.filter(session => session.id !== primary.id)
      const anyPlaying = !collapsed && view.rows.some(session => session.status === 'playing')
      const now = useNow(anyPlaying)

      React.useEffect(
        () => () => {
          for (const timer of timers.current) clearTimeout(timer)
          timers.current.clear()
        },
        [],
      )

      React.useEffect(() => {
        if (error === null) return undefined
        const timer = setTimeout(() => setError(null), 4000)
        return () => clearTimeout(timer)
      }, [error])

      if (!wide) return null
      if (!snapshot.ready || !snapshot.supported || snapshot.sessions.length === 0) return null

      const toggleCollapsed = () => {
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
            )
          : null

      const hero = session => {
        const title = session.title || tr('noTitle')
        const app = appNameOf(session)
        const tone = coverTone(session)
        const position = displayedPosition(session, snapshot.at, now)
        const rawElapsed = formatClock(position)
        const duration = formatClock(session.durationMs)
        const elapsed = rawElapsed !== '' ? rawElapsed : duration !== '' ? '0:00' : ''
        const percent = session.durationMs > 0 ? Math.max(0, Math.min(100, (position / session.durationMs) * 100)) : 0
        const playLabel = tr(session.status === 'playing' ? 'pause' : 'play')
        const stateLabel = stateLabelOf(session, tr)
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
                h(
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
            h('span', { className: 'mb-heroState', title: stateLabel }, stateLabel),
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
        },
        h(StyleSheet),
        h(
          'div',
          { className: 'mb-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'mb-title',
              'aria-expanded': collapsed ? 'false' : 'true',
              title: collapsed ? tr('expandWidget') : tr('collapseWidget'),
              onClick: toggleCollapsed,
            },
            h(Chevron, { open: !collapsed }),
            h('span', { className: 'mb-mark', 'aria-hidden': 'true' }, h(NoteIcon, { size: 11 })),
            h('span', { className: 'mb-titleText' }, tr('panel')),
          ),
          headControls,
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
      )
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const CSS = `
.mb-foot{box-sizing:border-box;width:100%;padding:6px 6px 5px;border:.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 94%,var(--dsw-alias-brand-primary)) 0%,var(--dsw-alias-bg-layer-1) 46%);display:flex;flex-direction:column;gap:2px;margin-bottom:2px;flex:none;}
.mb-foot:not([data-collapsed='true'])[data-tone='0']{--mb-tone:var(--dsw-alias-brand-primary);background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 54%);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,var(--dsw-alias-border-l1));}
.mb-foot:not([data-collapsed='true'])[data-tone='1']{--mb-tone:var(--dsw-alias-state-success-primary);background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 54%);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 28%,var(--dsw-alias-border-l1));}
.mb-foot:not([data-collapsed='true'])[data-tone='2']{--mb-tone:var(--dsw-alias-state-warn-primary);background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 54%);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 28%,var(--dsw-alias-border-l1));}
.mb-foot:not([data-collapsed='true'])[data-tone='3']{--mb-tone:var(--dsw-alias-brand-primary);background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,var(--dsw-alias-bg-layer-1)),color-mix(in srgb,var(--dsw-alias-state-warn-primary) 5%,var(--dsw-alias-bg-layer-1)) 54%);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,var(--dsw-alias-border-l1));}
.mb-foot[data-collapsed='true']{height:31px;min-height:31px;padding:4px 5px 3px;justify-content:center;}
.mb-head{display:flex;align-items:center;gap:5px;padding:1px 2px 3px;min-width:0;}
.mb-foot[data-collapsed='true'] .mb-head{padding:0 2px;min-height:18px;}
.mb-title{display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;border:0;border-radius:6px;background:transparent;padding:1px 3px;margin-right:1px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:500;line-height:16px;cursor:pointer;flex:none;}
@media (hover:hover){.mb-title:hover{background:var(--dsw-alias-interactive-bg-hover);}}
.mb-title:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.mb-titleText{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mb-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;width:17px;height:17px;border-radius:5px;background:linear-gradient(135deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 50%,var(--dsw-alias-state-success-primary)));color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);}
.mb-headControls{display:inline-flex;align-items:center;gap:1px;margin-left:auto;flex:none;}
.mb-headButton{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0;cursor:pointer;}
@media (hover:hover){.mb-headButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}}
.mb-headButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.mb-headButton:disabled{cursor:default;opacity:.45;background:transparent;}
.mb-headPlay{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:999px;background:linear-gradient(135deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-state-success-primary)));color:var(--dsw-alias-bg-base);padding:0;cursor:pointer;box-shadow:0 1px 4px color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent);}
@media (hover:hover){.mb-headPlay:hover{filter:brightness(1.08);}}
.mb-headPlay:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.mb-headPlay:disabled{cursor:default;opacity:.45;box-shadow:none;}
.mb-chevronIcon{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease;}
.mb-chevronIcon[data-open='true']{transform:rotate(90deg);}
@media (prefers-reduced-motion:reduce){.mb-chevronIcon{transition:none;}}
.mb-list{display:flex;flex-direction:column;gap:1px;max-height:min(46vh,380px);overflow:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);padding-bottom:1px;}
.mb-foot[data-single='true'] .mb-list{max-height:none;overflow:visible;}
.mb-hero{position:relative;display:flex;flex-direction:column;padding:2px 2px 1px;margin:0;border:0;background:transparent;box-shadow:none;overflow:visible;}
.mb-hero::before{content:'';position:absolute;top:-28px;left:-18px;width:150px;height:130px;border-radius:999px;background:radial-gradient(circle,color-mix(in srgb,var(--mb-tone,var(--dsw-alias-brand-primary)) 22%,transparent),transparent 70%);pointer-events:none;}
.mb-heroTop{position:relative;z-index:1;display:flex;align-items:center;gap:11px;min-width:0;}
.mb-cover{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:9px;color:var(--dsw-alias-label-primary);overflow:hidden;}
.mb-coverHero{width:56px;height:56px;border-radius:13px;box-shadow:0 6px 18px color-mix(in srgb,var(--mb-tone,var(--dsw-alias-brand-primary)) 20%,transparent),inset 0 0 0 .5px color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);}
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
.mb-progress{flex:1;height:4px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);overflow:hidden;}
.mb-progressFill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-state-success-primary)));transition:width .45s linear;}
.mb-heroControls{position:relative;z-index:1;display:flex;align-items:center;gap:4px;margin-top:9px;}
.mb-transportButton{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0;cursor:pointer;}
@media (hover:hover){.mb-transportButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}}
.mb-transportButton:active{background:var(--dsw-alias-interactive-bg-active);}
.mb-transportButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.mb-transportButton:disabled{cursor:default;opacity:.45;background:transparent;}
.mb-playButton{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:999px;background:linear-gradient(135deg,var(--dsw-alias-brand-primary),color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-state-success-primary)));color:var(--dsw-alias-bg-base);padding:0;cursor:pointer;box-shadow:0 2px 8px color-mix(in srgb,var(--mb-tone,var(--dsw-alias-brand-primary)) 28%,transparent);}
.mb-playButtonHero{width:32px;height:32px;margin-left:1px;}
@media (hover:hover){.mb-playButton:hover{filter:brightness(1.08);}}
.mb-playButton:active{transform:scale(.97);}
.mb-playButton:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px;}
.mb-playButton:disabled{cursor:default;opacity:.45;box-shadow:none;transform:none;}
.mb-heroState{margin-left:auto;font-size:9.5px;line-height:12px;letter-spacing:.2px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-transform:lowercase;}
.mb-sectionLabel{padding:9px 3px 3px;font-size:8.5px;line-height:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);border-top:.5px solid color-mix(in srgb,var(--mb-tone,var(--dsw-alias-border-l2)) 28%,var(--dsw-alias-border-l2));margin-top:6px;}
.mb-other{display:flex;align-items:center;gap:2px;border-radius:8px;min-width:0;}
@media (hover:hover){.mb-other:hover{background:var(--dsw-alias-interactive-bg-hover);}}
.mb-otherMain{display:flex;align-items:center;gap:7px;flex:1;min-width:0;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;padding:3px 2px;cursor:pointer;}
.mb-otherMain:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px;}
.mb-otherText{display:flex;flex-direction:column;gap:0;min-width:0;flex:1;}
.mb-otherTitle{font-size:11.5px;line-height:15px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mb-otherApp{font-size:9.5px;line-height:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.mb-otherPlay{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,transparent);color:var(--dsw-alias-brand-primary);padding:0;cursor:pointer;}
@media (hover:hover){.mb-otherPlay:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent);}}
.mb-otherPlay:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.mb-otherPlay:disabled{cursor:default;opacity:.45;background:transparent;}
.mb-other[data-pending='true']{opacity:.7;}
.mb-error{margin:0;padding:2px 5px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;}
@media (prefers-reduced-motion:reduce){.mb-eqBar{animation:none;}.mb-progressFill{transition:none;}.mb-playButton:active{transform:none;}}
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
