/**
 * Rhythm focus music: which files in the folder are tracks and in what order, how the
 * folder setting resolves, what plays after a track ends, and the raw URL each surface
 * streams from. The op runs against a real temp folder through the fake host.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeWalnut } from '../../../packages/plugin-api/src/testing.js'
import { activate, deactivate } from '../../../plugin-store/walnut-rhythm/src/server'
import { normalizeConfig } from '../../../plugin-store/walnut-rhythm/src/server/config'
import { listMusic, resolveMusicFolder, trackTitle, type MusicFs } from '../../../plugin-store/walnut-rhythm/src/server/music'
import { nextTrackIndex, trackUrl } from '../../../plugin-store/walnut-rhythm/src/web/music'

function fakeFs(files: Record<string, number>, dirs: string[] = []): MusicFs {
  return {
    readdir: async () => [
      ...Object.keys(files).map((name) => ({ name, isFile: () => true, isSymbolicLink: () => false })),
      ...dirs.map((name) => ({ name, isFile: () => false, isSymbolicLink: () => false })),
    ],
    stat: async (file) => {
      const bytes = files[path.basename(file)]
      if (bytes === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      return { size: bytes, isFile: true }
    },
  }
}

describe('the music folder', () => {
  it('lists playable files in natural order, brown noise first, and skips the rest', async () => {
    const listing = await listMusic('/m', true, fakeFs({
      '10 Rain.mp3': 5, '2 Pink Noise.wav': 5, '01 Brown Noise.m4a': 9, 'Cafe.flac': 5,
      'cover.jpg': 5, '.hidden.m4a': 5, 'empty.mp3': 0, 'notes.txt': 3, 'Song.MP3': 4, 'Vol..2.mp3': 4,
    }, ['Sub folder']))
    expect(listing.tracks.map((track) => track.id)).toEqual(['01 Brown Noise.m4a', '2 Pink Noise.wav', '10 Rain.mp3', 'Song.MP3'])
    expect(listing.tracks[0]).toEqual({ id: '01 Brown Noise.m4a', title: 'Brown Noise', file: '/m/01 Brown Noise.m4a', bytes: 9, type: 'audio/mp4' })
    expect(listing.tracks[3]!.type).toBe('audio/mpeg')
    // The raw file route refuses "..", so that name is named as skipped rather than listed to fail.
    expect(listing.skipped).toEqual(['Cafe.flac', 'Vol..2.mp3'])
    expect(listing.exists).toBe(true)
  })

  it('a missing folder is empty, an unreadable one says why', async () => {
    const missing: MusicFs = { readdir: async () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }) }, stat: async () => ({ size: 1, isFile: true }) }
    expect(await listMusic('/nope', false, missing)).toEqual({ folder: '/nope', isDefault: false, exists: false, tracks: [], skipped: [] })
    const denied: MusicFs = { readdir: async () => { throw Object.assign(new Error('no'), { code: 'EACCES' }) }, stat: async () => ({ size: 1, isFile: true }) }
    expect((await listMusic('/locked', false, denied)).error).toBe('Rhythm could not read /locked: permission denied.')
  })

  it('resolves empty to the plugin folder, expands ~, refuses a relative path', () => {
    expect(resolveMusicFolder('', '/data/rhythm', '/home/me')).toEqual({ folder: '/data/rhythm/focus-music', isDefault: true })
    expect(resolveMusicFolder(' ~/Music/Focus/ ', '/data', '/home/me')).toEqual({ folder: '/home/me/Music/Focus/', isDefault: false })
    expect(resolveMusicFolder('Music', '/data', '/home/me').error).toMatch(/not an absolute path/)
  })

  it('titles drop the ordering number only', () => {
    expect(trackTitle('01 Brown Noise.m4a')).toBe('Brown Noise')
    expect(trackTitle('3 - Rain.mp3')).toBe('Rain')
    expect(trackTitle('2001 A Space Odyssey.mp3')).toBe('2001 A Space Odyssey')
    expect(trackTitle('42.mp3')).toBe('42')
    expect(trackTitle('棕噪音.m4a')).toBe('棕噪音')
  })

  it('config: folder defaults to empty and music plays with focus by default', () => {
    expect(normalizeConfig({})).toMatchObject({ musicFolder: '', musicWithFocus: true })
    expect(normalizeConfig({ music_folder: ' ~/Music ', music_with_focus: false })).toMatchObject({ musicFolder: '~/Music', musicWithFocus: false })
  })
})

describe('what plays next', () => {
  it('repeat one stays, in order wraps, shuffle never repeats the last track', () => {
    expect(nextTrackIndex('one', 2, 5, 0.5)).toBe(2)
    expect(nextTrackIndex('in_order', 4, 5, 0.5)).toBe(0)
    expect(nextTrackIndex('in_order', 1, 5, 0.5)).toBe(2)
    expect(nextTrackIndex('shuffle', 0, 1, 0.9)).toBe(0)
    expect(nextTrackIndex('in_order', 0, 0, 0.1)).toBe(-1)
    for (let current = 0; current < 4; current++) {
      for (const random of [0, 0.24, 0.5, 0.74, 0.999]) {
        const next = nextTrackIndex('shuffle', current, 4, random)
        expect(next).not.toBe(current)
        expect(next).toBeGreaterThanOrEqual(0)
        expect(next).toBeLessThan(4)
      }
    }
  })

  it('streams from the path-shaped raw route with every segment encoded', () => {
    expect(trackUrl('/Users/me/.open-walnut/plugin-data/walnut-rhythm/focus-music/01 Brown Noise.m4a'))
      .toBe('/api/file-raw/local/Users/me/.open-walnut/plugin-data/walnut-rhythm/focus-music/01%20Brown%20Noise.m4a')
    expect(trackUrl('/m/a#b?c.mp3')).toBe('/api/file-raw/local/m/a%23b%3Fc.mp3')
  })
})

describe('the music_tracks op', () => {
  let dir = ''
  afterEach(async () => {
    await deactivate()
    if (dir) await fsp.rm(dir, { recursive: true, force: true })
    dir = ''
  })

  it('lists a real folder named in the settings, and a later file shows up on the next call', async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rhythm-music-'))
    await fsp.writeFile(path.join(dir, '01 Brown Noise.m4a'), Buffer.alloc(64))
    const fake = createFakeWalnut({ pluginId: 'walnut-rhythm', config: { mirror_macos_focus: false, macos_focus_shortcuts: false, quiet_hours: '', music_folder: dir } })
    await activate(fake.api)
    const call = fake.registeredOps.find((definition) => definition.name === 'music_tracks')!
    const first = await call.handler({}, { call: async () => undefined }) as { tracks: Array<{ id: string; file: string }>; withFocus: boolean; isDefault: boolean }
    expect(first.tracks.map((track) => track.id)).toEqual(['01 Brown Noise.m4a'])
    expect(first.tracks[0]!.file).toBe(path.join(dir, '01 Brown Noise.m4a'))
    expect(first.withFocus).toBe(true)
    expect(first.isDefault).toBe(false)
    await fsp.writeFile(path.join(dir, '02 Rain.mp3'), Buffer.alloc(32))
    // A link to a file elsewhere is a track; a link to a folder and a broken link are not.
    const elsewhere = await fsp.mkdtemp(path.join(os.tmpdir(), 'rhythm-music-src-'))
    try {
      await fsp.writeFile(path.join(elsewhere, 'ocean.wav'), Buffer.alloc(16))
      await fsp.symlink(path.join(elsewhere, 'ocean.wav'), path.join(dir, '03 Ocean.wav'))
      await fsp.symlink(elsewhere, path.join(dir, '04 Folder.mp3'))
      await fsp.symlink(path.join(elsewhere, 'missing.mp3'), path.join(dir, '05 Broken.mp3'))
      const second = await call.handler({}, { call: async () => undefined }) as { tracks: Array<{ id: string; bytes: number }> }
      expect(second.tracks.map((track) => track.id)).toEqual(['01 Brown Noise.m4a', '02 Rain.mp3', '03 Ocean.wav'])
      expect(second.tracks[2]!.bytes).toBe(16)
    } finally {
      await fsp.rm(elsewhere, { recursive: true, force: true })
    }
  })
})
