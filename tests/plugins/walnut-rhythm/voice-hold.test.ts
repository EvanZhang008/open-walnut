/**
 * Rhythm's focus music in the page pauses for voice input (Walnut's `stt:media-hold`) and
 * plays again after, only when it was Rhythm's music that the hold paused.
 * The audio element is a stub: no sound anywhere.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

class FakeAudio extends EventTarget {
  paused = true
  ended = false
  loop = false
  volume = 1
  preload = ''
  error: null = null
  private source = ''
  get src() { return this.source }
  set src(value: string) { this.source = `http://localhost${value}` }
  getAttribute(name: string) { return name === 'src' ? this.source || null : null }
  removeAttribute() { this.source = '' }
  load() {}
  play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve() }
  pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event('pause')) }
}

type Handler = (event: { name: string; data: unknown }) => void

function setup(hostname = 'localhost') {
  const handlers: Handler[] = []
  const controller = new AbortController()
  const walnut = {
    signal: controller.signal,
    events: { on: (_prefix: string, handler: Handler) => { handlers.push(handler); return { dispose() {} } } },
  }
  const store = {
    get: () => null,
    subscribe: () => () => {},
    call: async () => ({ ok: true, result: { folder: '/m', isDefault: true, exists: true, tracks: [{ id: 'a.m4a', title: 'A', file: '/m/a.m4a', bytes: 1, type: 'audio/mp4' }], skipped: [] } }),
  }
  vi.stubGlobal('location', { hostname })
  const emit = (active: boolean) => { for (const h of handlers) h({ name: 'stt:media-hold', data: { active } }) }
  return { walnut, store, emit, handlers, abort: () => controller.abort() }
}

beforeEach(() => {
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {} } })
  vi.stubGlobal('navigator', {})
})
afterEach(() => { vi.unstubAllGlobals() })

async function player(hostname?: string) {
  const { createMusicPlayer } = await import('../../../plugin-store/walnut-rhythm/src/web/music.js')
  const s = setup(hostname)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = createMusicPlayer(s.walnut as any, s.store as any)
  await p.refresh()
  return { p, ...s }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('Rhythm music and voice input', () => {
  it('playing: pauses for the hold, plays again at its end', async () => {
    const { p, emit, abort } = await player()
    p.play(); await settle()
    expect(p.get().playing).toBe(true)
    emit(true)
    expect(p.get()).toMatchObject({ playing: false, paused: true })
    emit(false); await settle()
    expect(p.get().playing).toBe(true)
    abort()
  })

  it('not playing: the end of the hold starts nothing', async () => {
    const { p, emit, abort } = await player()
    emit(true)
    emit(false); await settle()
    expect(p.get().playing).toBe(false)
    abort()
  })

  it('paused by the person before: stays paused', async () => {
    const { p, emit, abort } = await player()
    p.play(); await settle()
    p.pause()
    emit(true)
    emit(false); await settle()
    expect(p.get()).toMatchObject({ playing: false, paused: true })
    abort()
  })

  it('the person played or stopped it during the hold: their choice stays', async () => {
    const played = await player()
    played.p.play(); await settle()
    played.emit(true)
    played.p.play(); await settle()
    played.p.pause()
    played.emit(false); await settle()
    expect(played.p.get().playing).toBe(false)
    played.abort()

    const stopped = await player()
    stopped.p.play(); await settle()
    stopped.emit(true)
    stopped.p.stop()
    stopped.emit(false); await settle()
    expect(stopped.p.get().playing).toBe(false)
    stopped.abort()
  })

  it('a window on another computer does not listen', async () => {
    const { handlers, abort } = await player('192.168.1.20')
    expect(handlers).toHaveLength(0)
    abort()
  })
})
