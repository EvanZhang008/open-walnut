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
import type { Page } from '@playwright/test'
import { writeWhiteboardY4m } from './fake-camera'

const SAMPLE_RATE = 48_000
const TONE_HZ = 440
const AMPLITUDE = 0.1

/** 16-bit PCM mono WAV of `samples` (-1..1) at `rate`. */
export function wavOf(samples: ArrayLike<number>, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function toneWav(): Buffer {
  const samples = new Float32Array(SAMPLE_RATE) // one second, looped by Chromium
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE) * AMPLITUDE
  return wavOf(samples, SAMPLE_RATE)
}

/** A WAV in a temp folder of its own (written before any browser launches: module load). */
function writeWavFile(wav: Buffer, name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fake-mic-'))
  const file = path.join(dir, name)
  fs.writeFileSync(file, wav)
  return file
}

/** The flags for a fake microphone that plays `wav` (Chromium loops it). */
export function fakeMicArgsFor(wav: Buffer, name = 'mic.wav'): string[] {
  return [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${writeWavFile(wav, name)}`,
  ]
}

export const FAKE_MIC_ARGS: string[] = fakeMicArgsFor(toneWav(), 'tone.wav')

export interface SyntheticMicOptions {
  /** The tone's level to start with (0 = digital zero, a dead mic). Default 0.3. */
  gain?: number
  /** Speak and pause by turns, like sentences: the tone is on for `onMs`, then a faint hiss for `offMs`, from `leadMs`. Left out, it is steady. */
  speech?: { leadMs: number; onMs: number; offMs: number }
  /** Wait this long before answering, as a slow device does. */
  openDelayMs?: number
  /** Refuse instead, with this DOMException name (e.g. 'NotAllowedError'): one override in every engine. */
  refuse?: string
}

/**
 * The one synthetic microphone of the browser specs, for any engine (WebKit has no fake capture
 * flag): getUserMedia answers a stream made in the page, a 220 Hz tone through a gain into a
 * MediaStream destination, so nothing reaches the speakers (in WebKit an automated page keeps its
 * AudioContext only with the voice-test agent, webkit-recorder.ts). Patched on the prototype as
 * well as the instance: WebKit kept answering with the native method after an instance-only patch.
 * The page gets `__micGain(g)` (set the level now), `__syntheticMicGain` (the newest stream's
 * gain node), `__micStreams` (every stream handed out) and `__syntheticMic`; it logs
 * `[synthetic-mic]` lines a spec can print when a recording never starts.
 */
export async function useSyntheticMic(page: Page, opts: SyntheticMicOptions = {}): Promise<void> {
  await page.addInitScript((o: SyntheticMicOptions) => {
    const fake = async (): Promise<MediaStream> => {
      console.log('[synthetic-mic] getUserMedia called')
      if (o.refuse) throw new DOMException('denied', o.refuse)
      if (o.openDelayMs) await new Promise((r) => setTimeout(r, o.openDelayMs))
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      // Never hang the recorder on a context that will not resume.
      await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))])
      console.log(`[synthetic-mic] context ${ctx.state}`)
      const osc = ctx.createOscillator()
      osc.frequency.value = 220
      const gain = ctx.createGain()
      const dst = ctx.createMediaStreamDestination()
      osc.connect(gain).connect(dst)
      if (o.speech) {
        // A pitch that wanders (4 Hz) and a level that speaks, then pauses over a hiss.
        const wobble = ctx.createOscillator()
        wobble.frequency.value = 4
        const depth = ctx.createGain()
        depth.gain.value = 40
        wobble.connect(depth).connect(osc.frequency)
        wobble.start()
        const quiet = 0.001
        gain.gain.value = quiet
        const t0 = ctx.currentTime + o.speech.leadMs / 1000
        const cycle = (o.speech.onMs + o.speech.offMs) / 1000
        for (let i = 0; i < 400; i++) {
          gain.gain.setValueAtTime(o.gain ?? 0.3, t0 + i * cycle)
          gain.gain.setValueAtTime(quiet, t0 + i * cycle + o.speech.onMs / 1000)
        }
      } else gain.gain.value = o.gain ?? 0.3
      osc.start()
      const w = window as unknown as { __micStreams?: MediaStream[]; __micGain?: (g: number) => void; __syntheticMicGain?: GainNode }
      w.__micStreams = [...(w.__micStreams ?? []), dst.stream]
      w.__micGain = (g: number) => { gain.gain.cancelScheduledValues(ctx.currentTime); gain.gain.setValueAtTime(g, ctx.currentTime) }
      w.__syntheticMicGain = gain
      console.log('[synthetic-mic] stream ready')
      return dst.stream
    }
    if (typeof MediaDevices !== 'undefined') {
      Object.defineProperty(MediaDevices.prototype, 'getUserMedia', { value: fake, configurable: true, writable: true })
    }
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true })
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: fake, configurable: true, writable: true });
    (window as unknown as { __syntheticMic?: boolean }).__syntheticMic = true
  }, opts)
}

/**
 * A fake camera and microphone together (the chat camera's specs, Chromium only): the camera
 * plays a drawn whiteboard (fake-camera.ts), the microphone the steady tone. Fake UI answers
 * every permission prompt yes; a spec that needs a refusal patches getUserMedia in the page.
 */
export function fakeCameraArgs(): string[] {
  return [
    ...FAKE_MIC_ARGS,
    `--use-file-for-fake-video-capture=${writeWhiteboardY4m()}`,
  ]
}
