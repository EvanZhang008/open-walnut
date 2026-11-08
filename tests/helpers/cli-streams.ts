// Catches a runTools call's output (stream writes and console), minus the logger's own stderr lines.
import { vi } from 'vitest'

type Sink = (text: string) => void

const fromLogger = (): boolean => /[\\/]src[\\/]logging[\\/]/.test(new Error().stack ?? '')
const line = (chunk: unknown): string => String(chunk).replace(/\n$/, '')

export function spyCliStreams(sinks: { out: Sink; err: Sink }): void {
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (!fromLogger()) sinks.out(line(chunk))
    ;(rest.find((r) => typeof r === 'function') as (() => void) | undefined)?.()
    return true
  }) as typeof process.stdout.write)
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (!fromLogger()) sinks.err(line(chunk))
    ;(rest.find((r) => typeof r === 'function') as (() => void) | undefined)?.()
    return true
  }) as typeof process.stderr.write)
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { sinks.out(a.map(String).join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { sinks.err(a.map(String).join(' ')) })
}
