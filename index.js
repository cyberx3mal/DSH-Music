/**
 * Host half of the music board bundle.
 *
 * The browser cannot read Windows media sessions, so this half owns the only
 * privileged part: a long-lived PowerShell watcher over the Windows System
 * Media Transport Controls (SMTC) session manager. The watcher subscribes to
 * the manager and per-session WinRT events and writes one JSON snapshot per
 * change; it never polls the UI. Snapshots reach the browser through an
 * authenticated exact Fetch route (`/api/dsh-music/stream`, SSE) and transport
 * commands go back through `/api/dsh-music/action`.
 *
 * Only apps that publish to the Windows media controls appear here. The
 * watcher is started on the first subscription and stopped shortly after the
 * last one, so an idle page owns no helper process.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const WATCHER_SCRIPT = path.join(PACKAGE_DIR, 'smtc-watcher.ps1')
const CONTROL_SCRIPT = path.join(PACKAGE_DIR, 'smtc-control.ps1')
const POWERSHELL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const IS_WINDOWS = process.platform === 'win32'
const MAX_SESSIONS = 32
const MAX_TEXT = 400
const MAX_LINE_BYTES = 512 * 1024
const IDLE_STOP_MS = 5000
const RESTART_DELAYS_MS = [500, 1500, 4000, 10000, 20000]
const CONTROL_TIMEOUT_MS = 10000
const ACTIONS = new Set(['toggle', 'play', 'pause', 'next', 'previous'])
const ART_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const ART_NEGATIVE_TTL_MS = 60 * 60 * 1000
const ART_CACHE_LIMIT = 80
const ART_MAX_BYTES = 160 * 1024
const ART_FETCH_TIMEOUT_MS = 5000

/** Services this half needs; without Connection it stays inactive. */
export const inject = ['connection']

/** Snapshot sent before any state exists. */
function pendingSnapshot() {
  return { supported: true, ready: false, sessions: [], at: Date.now() }
}

/** Snapshot for an unavailable integration. */
function unsupportedSnapshot() {
  return { supported: false, ready: true, sessions: [], at: Date.now() }
}

/**
 * Cut a value to a bounded single-line string.
 * @param value - raw value.
 * @param max - maximum characters.
 * @returns the cleaned text.
 */
function text(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return ''
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned
}

/**
 * Coerce a numeric field into a non-negative safe integer.
 * @param value - raw value.
 * @returns the number, or 0.
 */
function count(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), 86_400_000) : 0
}

/**
 * Normalize one watcher row into the shape the widget consumes.
 * @param row - raw watcher session object.
 * @param index - row index, used for a stable fallback id.
 * @param seen - duplicate app-id counter.
 * @returns the normalized session, or undefined to skip it.
 */
function normalizeSession(row, index, seen) {
  if (row === null || typeof row !== 'object') return undefined
  const appId = text(row.appId, 200)
  const title = text(row.title, 240)
  const artist = text(row.artist, 200)
  const album = text(row.album, 200)
  const app = text(row.app, 80) || appId || appNameFallback(index)
  const status = row.status === 'playing' || row.status === 'paused' ? row.status : 'idle'
  if (appId === '' && title === '' && artist === '') return undefined
  if (status === 'idle' && title === '' && artist === '') return undefined

  const base = appId || `source-${String(index)}`
  const occurrence = (seen.get(base) ?? 0) + 1
  seen.set(base, occurrence)
  const id = occurrence === 1 ? base : `${base}#${String(occurrence)}`
  const durationMs = count(row.durationMs)
  const positionMs = Math.min(count(row.positionMs), durationMs > 0 ? durationMs : 86_400_000)

  return {
    id,
    appId,
    app,
    title,
    artist,
    album,
    status,
    positionMs,
    durationMs,
    canPlayPause: row.canPlayPause !== false,
    canNext: row.canNext !== false,
    canPrevious: row.canPrevious !== false,
    canSeek: row.canSeek === true,
  }
}

/** Last-resort app label when the watcher supplied nothing. */
function appNameFallback(index) {
  return index === 0 ? 'Media' : `Media ${String(index + 1)}`
}

/**
 * Resolve the occurrence index encoded in a normalized duplicate id.
 * @param id - session id (`appId` or `appId#n`).
 * @returns the zero-based occurrence among sessions with that appId.
 */
function occurrenceOf(id) {
  const at = id.lastIndexOf('#')
  if (at <= 0) return 0
  const value = Number(id.slice(at + 1))
  return Number.isInteger(value) && value >= 2 && value <= MAX_SESSIONS ? value - 1 : 0
}

/** Stable cache key for a source's current track. */
function artKeyOf(session) {
  const title = text(session?.title, 240)
  if (title === '') return ''
  const artist = text(session?.artist, 200)
  const app = text(session?.appId, 200) || text(session?.app, 80)
  return `${app}|${artist}|${title}`.toLowerCase()
}

/** Normalize a catalog string for a conservative match. */
function normalizedText(value) {
  return text(value, 240)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Whether one iTunes result describes the current track. */
function matchesResult(result, session) {
  if (result === null || typeof result !== 'object') return false
  const title = normalizedText(session.title)
  const resultTitle = normalizedText(result.trackName)
  if (title === '' || resultTitle === '') return false
  if (!resultTitle.includes(title) && !title.includes(resultTitle)) return false
  const artist = normalizedText(session.artist)
  const resultArtist = normalizedText(result.artistName)
  if (artist === '' || resultArtist === '') return true
  return resultArtist.includes(artist) || artist.includes(resultArtist)
}

/**
 * Normalize a whole snapshot.
 * @param raw - watcher message.
 * @returns a session array, or undefined when the message is not a snapshot.
 */
function normalizeSessions(raw) {
  if (!Array.isArray(raw)) return undefined
  const seen = new Map()
  const sessions = []
  for (let index = 0; index < raw.length && sessions.length < MAX_SESSIONS; index += 1) {
    const session = normalizeSession(raw[index], index, seen)
    if (session !== undefined) sessions.push(session)
  }
  return sessions
}

/** JSON response for the exact Fetch routes. */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * The watcher and the transport commands bound to one plugin lifetime.
 */
class MusicHub {
  constructor() {
    this.child = null
    this.buffer = ''
    this.stderr = ''
    this.snapshot = pendingSnapshot()
    this.subscribers = new Set()
    this.idleTimer = null
    this.restartTimer = null
    this.restartAttempt = 0
    this.unsupported = !IS_WINDOWS
    this.disposed = false
    this.pendingActions = new Set()
    this.artCache = new Map()
    this.artPending = new Set()
  }

  /** Publish one snapshot to every open stream. */
  publish(snapshot) {
    const enriched = this.withArt(snapshot)
    this.snapshot = enriched
    for (const send of [...this.subscribers]) {
      try {
        send(enriched)
      } catch (error) {
        console.error('[music-board] subscriber', error)
      }
    }
  }

  /**
   * Attach cached cover art and start a lookup for new tracks.
   * @param snapshot - watcher snapshot.
   * @returns the snapshot with any cached art attached.
   */
  withArt(snapshot) {
    if (snapshot === null || typeof snapshot !== 'object' || !Array.isArray(snapshot.sessions)) return snapshot
    if (snapshot.sessions.length === 0 || this.disposed) return snapshot
    let changed = false
    const sessions = snapshot.sessions.map(session => {
      const key = artKeyOf(session)
      if (key === '') return session
      const entry = this.artCache.get(key)
      const ttl = entry?.art ? ART_CACHE_TTL_MS : ART_NEGATIVE_TTL_MS
      if (entry !== undefined && Date.now() - entry.at < ttl) {
        if (entry.art !== '' && session.art !== entry.art) {
          changed = true
          return { ...session, art: entry.art }
        }
        return session
      }
      if (entry !== undefined) this.artCache.delete(key)
      if (!this.artPending.has(key)) {
        this.artPending.add(key)
        void this.lookupArt(session, key)
      }
      return session
    })
    return changed ? { ...snapshot, sessions } : snapshot
  }

  /**
   * Find a conservative iTunes match and cache its artwork as a data URL.
   * Track title and artist leave the machine only for this lookup; the cache
   * keeps repeated snapshots offline.
   * @param session - session with title and artist.
   * @param key - art cache key.
   */
  async lookupArt(session, key) {
    try {
      const term = [session.artist, session.title].filter(Boolean).join(' ')
      if (term.trim() === '') {
        this.artCache.set(key, { art: '', at: Date.now() })
        return
      }
      const endpoint = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=5`
      const response = await fetch(endpoint, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(ART_FETCH_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      const results = Array.isArray(payload?.results) ? payload.results : []
      const chosen = results.find(result => matchesResult(result, session))
      if (chosen === undefined || typeof chosen.artworkUrl100 !== 'string') {
        this.artCache.set(key, { art: '', at: Date.now() })
        return
      }
      const artwork = new URL(chosen.artworkUrl100)
      if (artwork.protocol !== 'https:' || !/(^|\.)mzstatic\.com$/i.test(artwork.hostname)) {
        throw new Error('unexpected artwork host')
      }
      const image = await fetch(artwork, {
        headers: { accept: 'image/*' },
        signal: AbortSignal.timeout(ART_FETCH_TIMEOUT_MS),
      })
      if (!image.ok) throw new Error(`art HTTP ${image.status}`)
      const mediaType = image.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
      if (!mediaType.startsWith('image/')) throw new Error('art is not an image')
      const bytes = Buffer.from(await image.arrayBuffer())
      if (bytes.length === 0 || bytes.length > ART_MAX_BYTES) throw new Error('art is too large')
      const art = `data:${mediaType};base64,${bytes.toString('base64')}`
      this.artCache.set(key, { art, at: Date.now() })
      if (this.artCache.size > ART_CACHE_LIMIT) {
        const oldest = this.artCache.keys().next().value
        if (oldest !== undefined) this.artCache.delete(oldest)
      }
    } catch {
      this.artCache.set(key, { art: '', at: Date.now() })
    } finally {
      this.artPending.delete(key)
      this.refreshArt()
    }
  }

  /** Re-publish the current snapshot after a cover lookup settles. */
  refreshArt() {
    if (this.disposed || this.snapshot === null || this.subscribers.size === 0) return
    this.publish(this.snapshot)
  }

  /** Mark the integration unavailable and stop restarting the watcher. */
  markUnsupported() {
    this.unsupported = true
    this.publish(unsupportedSnapshot())
    this.stopWatcher()
  }

  /** Start the watcher if it is not already running. */
  ensureStarted() {
    if (this.disposed || this.unsupported || this.child !== null) return
    if (!IS_WINDOWS) {
      this.markUnsupported()
      return
    }
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WATCHER_SCRIPT],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    this.child = child
    this.buffer = ''
    this.stderr = ''

    child.stdout?.on('data', chunk => this.consume(String(chunk)))
    child.stderr?.on('data', chunk => {
      this.stderr = (this.stderr + String(chunk)).slice(-8000)
    })
    child.on('error', error => {
      console.error('[music-board] watcher spawn', error)
      this.stderr = `${this.stderr}\nspawn: ${error instanceof Error ? error.message : String(error)}`
      if (this.child !== child) return
      this.child = null
      this.handleExit()
    })
    child.on('close', () => {
      if (this.child !== child) return
      this.child = null
      this.handleExit()
    })
  }

  /** Split stdout into JSON lines and apply each snapshot. */
  consume(chunk) {
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE_BYTES) {
      console.error('[music-board] watcher output exceeded the line limit')
      this.buffer = this.buffer.slice(-Math.floor(MAX_LINE_BYTES / 2))
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line !== '') this.applyLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  /** Apply one watcher JSON line. */
  applyLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return

    if (message.type === 'unsupported') {
      console.error('[music-board] media sessions unavailable:', text(message.message, 500))
      this.markUnsupported()
      return
    }

    if (message.type === 'snapshot') {
      const sessions = normalizeSessions(message.sessions)
      if (sessions === undefined) return
      this.restartAttempt = 0
      this.publish({ supported: true, ready: true, sessions, at: Date.now() })
      return
    }

    if (message.type === 'error') {
      console.error('[music-board] watcher error:', text(message.message, 500))
    }
  }

  /** Release the watcher process. */
  stopWatcher() {
    const child = this.child
    this.child = null
    this.buffer = ''
    if (child !== null) {
      try {
        child.kill()
      } catch {
        /* the process may already be gone */
      }
    }
  }

  /** Restart after a crash while somebody is still listening. */
  handleExit() {
    this.buffer = ''
    if (this.disposed || this.unsupported) return
    if (this.restartTimer !== null) return
    if (this.snapshot.ready === false) this.publish(pendingSnapshot())
    if (this.subscribers.size === 0) return
    if (this.stderr.trim() !== '') {
      const first = this.stderr.trim().split(/\r?\n/)[0]
      console.error('[music-board] watcher stopped:', text(first, 300))
    }
    const delay = RESTART_DELAYS_MS[Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)]
    this.restartAttempt += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.disposed && this.subscribers.size > 0) this.ensureStarted()
    }, delay)
    if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref()
  }

  /** Register one stream listener and keep the helper alive. */
  subscribe(send) {
    this.subscribers.add(send)
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.ensureStarted()
    return () => {
      this.subscribers.delete(send)
      if (this.subscribers.size === 0) this.scheduleIdleStop()
    }
  }

  /** Stop the helper after a short grace period on the last disconnect. */
  scheduleIdleStop() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.subscribers.size === 0) {
        this.stopWatcher()
        this.snapshot = pendingSnapshot()
      }
    }, IDLE_STOP_MS)
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref()
  }

  /** Wait briefly for the first snapshot, for the one-shot state route. */
  async waitReady(timeoutMs = 1500) {
    this.ensureStarted()
    if (this.snapshot.ready || this.unsupported) return this.snapshot
    return new Promise(resolve => {
      let settled = false
      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribe()
        resolve(value)
      }
      const unsubscribe = this.subscribe(snapshot => {
        if (snapshot.ready) finish(snapshot)
      })
      const timer = setTimeout(() => finish(this.snapshot), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  /** Run one control command against a session that is currently present. */
  async control(id, appId, action) {
    if (this.unsupported) return { ok: false, error: 'unsupported' }
    if (typeof id !== 'string' || id === '' || id.length > 240) {
      return { ok: false, error: 'invalid-target' }
    }
    if (typeof appId !== 'string' || appId === '' || appId.length > 200) {
      return { ok: false, error: 'invalid-target' }
    }
    if (!ACTIONS.has(action)) return { ok: false, error: 'invalid-action' }
    const session = this.snapshot.sessions.find(item => item.id === id && item.appId === appId)
    if (session === undefined) return { ok: false, error: 'not-found' }
    if (this.pendingActions.has(id)) return { ok: false, error: 'busy' }
    this.pendingActions.add(id)
    try {
      return await this.runControlScript(appId, action, occurrenceOf(id))
    } finally {
      this.pendingActions.delete(id)
    }
  }

  /** Spawn the one-shot control script and parse its answer. */
  runControlScript(appId, action, occurrence) {
    return new Promise(resolve => {
      let child
      try {
        child = spawn(
          POWERSHELL,
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            CONTROL_SCRIPT,
            '-AppId',
            appId,
            '-Action',
            action,
            '-Index',
            String(occurrence),
          ],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        )
      } catch (error) {
        resolve({ ok: false, error: 'spawn-failed', message: text(String(error), 300) })
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false

      const finish = value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        finish({ ok: false, error: 'timeout' })
      }, CONTROL_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()

      child.stdout?.on('data', chunk => {
        stdout = (stdout + String(chunk)).slice(-16_000)
      })
      child.stderr?.on('data', chunk => {
        stderr = (stderr + String(chunk)).slice(-16_000)
      })
      child.on('error', error => {
        finish({ ok: false, error: 'spawn-failed', message: text(String(error), 300) })
      })
      child.on('close', () => {
        const lines = stdout
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line.startsWith('{'))
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          try {
            const answer = JSON.parse(lines[index])
            if (answer !== null && typeof answer === 'object') {
              finish({
                ok: answer.ok === true,
                error: answer.ok === true ? undefined : text(answer.error, 120) || 'rejected',
              })
              return
            }
          } catch {
            /* keep looking for the last JSON answer */
          }
        }
        finish({
          ok: false,
          error: 'no-answer',
          message: text(stderr.trim().split(/\r?\n/)[0] ?? '', 300),
        })
      })
    })
  }

  /** Stop everything owned by the plugin. */
  dispose() {
    this.disposed = true
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.stopWatcher()
    this.subscribers.clear()
  }
}

/**
 * Register the state, stream and control routes for the life of the plugin.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  const hub = new MusicHub()

  ctx.effect(() => () => hub.dispose(), 'music-board: watcher lifecycle')

  const register = (path, methods, fetch) =>
    ctx.effect(
      () => ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }),
      `music-board: ${path}`,
    )

  register('/api/dsh-music/state', ['GET'], async () => jsonResponse(200, await hub.waitReady()))

  register('/api/dsh-music/action', ['POST'], async request => {
    let body
    try {
      body = await request.json()
    } catch {
      return jsonResponse(400, { ok: false, error: 'invalid-body' })
    }
    const id = typeof body?.id === 'string' ? body.id : ''
    const appId = typeof body?.appId === 'string' ? body.appId : ''
    const action = typeof body?.action === 'string' ? body.action : ''
    return jsonResponse(200, await hub.control(id, appId, action))
  })

  register('/api/dsh-music/stream', ['GET'], async request => {
    const encoder = new TextEncoder()
    let closed = false
    let unsubscribe
    let heartbeat

    const stream = new ReadableStream({
      start(controller) {
        const stop = () => {
          if (closed) return
          closed = true
          if (heartbeat !== undefined) clearInterval(heartbeat)
          if (unsubscribe !== undefined) unsubscribe()
          request.signal.removeEventListener('abort', stop)
          try {
            controller.close()
          } catch {
            /* the bridge may already have closed the stream */
          }
        }

        const send = snapshot => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`))
          } catch {
            stop()
          }
        }

        unsubscribe = hub.subscribe(send)
        send(hub.snapshot)
        heartbeat = setInterval(() => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(': keep-alive\n\n'))
          } catch {
            stop()
          }
        }, 15_000)
        if (typeof heartbeat.unref === 'function') heartbeat.unref()
        request.signal.addEventListener('abort', stop, { once: true })
      },
      cancel() {
        if (unsubscribe !== undefined) unsubscribe()
        if (heartbeat !== undefined) clearInterval(heartbeat)
        closed = true
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    })
  })
}
