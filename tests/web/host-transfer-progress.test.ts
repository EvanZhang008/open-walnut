/**
 * The progress bar of the daemon file going onto a host (2026-11-12, the user: "this
 * uploading to old dev please have some kind of progress bar"): read from the active step,
 * worded in megabytes, and nothing at all when the server sends no numbers.
 */
import { describe, expect, it } from 'vitest'
import { transferProgress, transferWords } from '@/utils/host-connect'
import type { HostConnectStep } from '@/api/hosts'

const MB = 1_048_576
const steps = (progress?: HostConnectStep['progress'], status: HostConnectStep['status'] = 'active'): HostConnectStep[] => [
  { phase: 'ssh', label: 'SSH', status: 'done' },
  { phase: 'upload', label: 'Upload daemon', status, ...(progress ? { progress } : {}) },
  { phase: 'start', label: 'Start daemon', status: 'todo' },
]

describe('the daemon file transfer progress', () => {
  it('an upload in progress: its fraction and the megabytes sent', () => {
    const p = transferProgress({ steps: steps({ via: 'upload', done: 23 * MB, total: 67 * MB }) })!
    expect(p.fraction).toBeCloseTo(23 / 67)
    expect(transferWords(p)).toBe('23 of 67 MB sent')
  })

  it('the host downloading it says so', () => {
    const p = transferProgress({ steps: steps({ via: 'download', done: 4.25 * MB, total: 67 * MB }) })!
    expect(transferWords(p)).toBe('4.3 of 67 MB, downloaded by the host')
  })

  it('a total not known: no fraction, only the megabytes', () => {
    const p = transferProgress({ steps: steps({ via: 'upload', done: 2 * MB, total: 0 }) })!
    expect(p.fraction).toBeNull()
    expect(transferWords(p)).toBe('2.0 MB sent')
  })

  it('never past 100%', () => {
    expect(transferProgress({ steps: steps({ via: 'upload', done: 70 * MB, total: 67 * MB }) })!.fraction).toBe(1)
  })

  it('nothing from an older server, a step that is not active, or bad numbers', () => {
    expect(transferProgress(undefined)).toBeNull()
    expect(transferProgress({ steps: steps() })).toBeNull()
    expect(transferProgress({ steps: steps({ via: 'upload', done: MB, total: 2 * MB }, 'done') })).toBeNull()
    expect(transferProgress({ steps: steps({ via: 'upload', done: Number.NaN, total: 2 * MB }) })).toBeNull()
  })
})
