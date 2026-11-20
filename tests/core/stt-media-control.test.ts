/**
 * The Mac's Now Playing controller (src/core/stt/media-control.ts), with osascript stubbed:
 * nothing here runs a script or touches a player.
 *   - the script only ever sends Play (0) and Pause (1), never the toggle (2): a toggle sent
 *     to something already paused would START music;
 *   - Play goes out only after the script checked the same app is still there and paused;
 *   - its answers map to the hold's terms, and a failing script is a "no", never a throw.
 */
import { describe, it, expect } from 'vitest'
import { MEDIA_REMOTE_JXA, mediaRemoteController } from '../../src/core/stt/media-control.js'

const now = { playing: true, bundle: 'com.spotify.client', pid: 31, name: 'Spotify' }

describe('the MediaRemote script', () => {
  it('sends only Play and Pause, never the toggle', () => {
    const sends = [...MEDIA_REMOTE_JXA.matchAll(/send\((\d+)\)/g)].map((m) => Number(m[1]))
    expect(sends.sort()).toEqual([0, 1])
    expect(MEDIA_REMOTE_JXA).not.toMatch(/send\(\s*2\s*\)/)
  })

  it('plays only after checking the same app is still paused', () => {
    const play = MEDIA_REMOTE_JXA.slice(MEDIA_REMOTE_JXA.indexOf("if (action === 'play')"))
    const check = play.indexOf('before.playing')
    const sameApp = play.indexOf('before.bundle !== wantBundle')
    const send = play.indexOf('send(0)')
    expect(check).toBeGreaterThan(-1)
    expect(sameApp).toBeGreaterThan(check)
    expect(send).toBeGreaterThan(sameApp)
  })

  it('pauses only what plays', () => {
    const pause = MEDIA_REMOTE_JXA.slice(MEDIA_REMOTE_JXA.indexOf("if (action === 'pause')"), MEDIA_REMOTE_JXA.indexOf("if (action === 'play')"))
    expect(pause.indexOf('!before.playing')).toBeLessThan(pause.indexOf('send(1)'))
  })
})

describe('mediaRemoteController', () => {
  it('reads what plays', async () => {
    const c = mediaRemoteController(async (args) => { expect(args).toEqual(['read']); return JSON.stringify({ ok: true, now }) })
    expect(await c.read()).toEqual(now)
  })

  it('a pause of something playing names it; of nothing, null', async () => {
    const playing = mediaRemoteController(async () => JSON.stringify({ ok: true, now, paused: true }))
    expect(await playing.pauseNowPlaying()).toEqual({ paused: { bundle: 'com.spotify.client', pid: 31, name: 'Spotify' } })
    const idle = mediaRemoteController(async () => JSON.stringify({ ok: true, now: { ...now, playing: false }, paused: false }))
    expect(await idle.pauseNowPlaying()).toEqual({ paused: null })
  })

  it('a pause that did not take is not recorded (nothing to resume)', async () => {
    const c = mediaRemoteController(async () => JSON.stringify({ ok: true, now, paused: false }))
    const out = await c.pauseNowPlaying()
    expect(out.paused).toBeNull()
    expect(out.error).toMatch(/did not pause/)
  })

  it('resume passes the exact app and reads the answer', async () => {
    let seen: string[] = []
    const c = mediaRemoteController(async (args) => { seen = args; return JSON.stringify({ ok: true, now, resumed: false, reason: 'playing' }) })
    expect(await c.resume({ bundle: 'com.spotify.client', pid: 31, name: 'Spotify', pausedAt: 1 })).toEqual({ resumed: false, reason: 'playing' })
    expect(seen).toEqual(['play', 'com.spotify.client', '31'])
  })

  it('a script that fails is a no, never a throw', async () => {
    const c = mediaRemoteController(async () => { throw new Error('execution error: -1743') })
    expect(await c.read()).toBeNull()
    expect((await c.pauseNowPlaying()).paused).toBeNull()
    expect((await c.resume({ bundle: 'x', pid: 1, name: 'x', pausedAt: 1 })).resumed).toBe(false)
    const bad = mediaRemoteController(async () => JSON.stringify({ ok: false, error: 'MediaRemote did not load' }))
    expect((await bad.pauseNowPlaying()).error).toMatch(/did not load/)
  })
})
