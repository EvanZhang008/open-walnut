/**
 * Chromium launch flags for a fake microphone that is never digitally silent.
 *
 * `--use-fake-device-for-media-stream` alone captures exact zeros with a 20 ms beep
 * every 500 ms. Since dictation asks for `echoCancellation: false`
 * (web/src/utils/mic-constraints.ts), Chromium no longer runs that capture through
 * its audio processing, so the recorder's analyser reads those zeros as they are: a
 * 1.2 s recording often sampled no beep at all, the hook judged the stream dead
 * ("No sound detected from the microphone") and transcribed nothing. A real mic is
 * never pure zero, so the fake one plays a steady tone instead, loud enough to count
 * as speech (above `VOICE_RMS` in useSpeechToText.ts). Chromium loops the file.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SAMPLE_RATE = 48_000
const TONE_HZ = 440
const AMPLITUDE = 0.1

function toneWav(): Buffer {
  const samples = SAMPLE_RATE // one second, looped by Chromium
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE) * AMPLITUDE
    data.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** Written once per worker, before any browser launches (module load). */
function writeToneFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fake-mic-'))
  const file = path.join(dir, 'tone.wav')
  fs.writeFileSync(file, toneWav())
  return file
}

export const FAKE_MIC_ARGS: string[] = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${writeToneFile()}`,
]
