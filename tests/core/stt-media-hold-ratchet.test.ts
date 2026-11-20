/**
 * Every voice input that opens a microphone holds the music off (src/core/stt/media-hold.ts).
 *
 * The class: a place that starts dictation recording. The members are found in the
 * source, so a NEW way to dictate that forgets the hold fails here:
 *   - the web: every file under web/src that calls getUserMedia(...) for audio;
 *   - the Mac app: every desktop/*.swift file that makes an AVAudioRecorder;
 *   - the server: every route file that calls startMicRecording().
 * Each must reach the media hold (acquireMediaHold / /api/stt/media-hold / mediaHold()).
 * A recorder that is NOT voice input (none today) goes in NOT_VOICE_INPUT with its reason.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

/** Files that open a mic for something other than dictation, with why. */
const NOT_VOICE_INPUT: Record<string, string> = {}

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, ext, out)
    else if (ext.test(entry.name)) out.push(full)
  }
  return out
}

function members(dir: string, ext: RegExp, opens: RegExp): string[] {
  return walk(path.join(ROOT, dir), ext)
    .filter((file) => opens.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(ROOT, file))
}

const HOLDS = /acquireMediaHold\(|\/api\/stt\/media-hold|mediaHold\(\)\.hold\(/

describe('every voice input holds the music off', () => {
  const found = [
    ...members('web/src', /\.(ts|tsx)$/, /getUserMedia\(\s*\{\s*audio/),
    ...members('desktop', /\.swift$/, /AVAudioRecorder\(/),
    ...members('src/web/routes', /\.ts$/, /startMicRecording\(\)/),
  ]

  it('finds the known members (the scan itself works)', () => {
    expect(found).toEqual(expect.arrayContaining([
      'web/src/hooks/useSpeechToText.ts',
      'desktop/GlobalDictation.swift',
      'src/web/routes/stt.ts',
    ]))
  })

  it.each(found)('%s holds the music while its mic is open', (file) => {
    if (NOT_VOICE_INPUT[file]) return
    expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).toMatch(HOLDS)
  })

  // A released id stays ended (late renews start nothing), so an id that is a constant
  // would hold the music only for the first recording (review of 2026-11-20).
  it.each(found)('%s never holds under a fixed id', (file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    expect(text).not.toMatch(/mediaHold\(\)\.hold\(\s*['"`][^'"`$]*['"`]/)
    expect(text).not.toMatch(/acquireMediaHold\([^)]*\bid\s*:/)
  })
})
