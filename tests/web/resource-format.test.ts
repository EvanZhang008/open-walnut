/**
 * The words for what a session costs its machine (web/src/utils/resource-format.ts).
 */
import { describe, it, expect } from 'vitest'
import { formatCpu, formatMemory, formatProcCount, heavyPillText, hostReasonText, hostTotalsText, staleReadingText } from '../../web/src/utils/resource-format'

const MB = 1024 ** 2
const GB = 1024 ** 3

describe('formatMemory', () => {
  it('whole MB under a GB, one decimal to 10 GB, whole above', () => {
    expect(formatMemory(0)).toBe('0 MB')
    expect(formatMemory(-5)).toBe('0 MB')
    expect(formatMemory(NaN)).toBe('0 MB')
    expect(formatMemory(300 * 1024)).toBe('1 MB')
    expect(formatMemory(640 * MB)).toBe('640 MB')
    expect(formatMemory(1023.6 * MB)).toBe('1024 MB')
    expect(formatMemory(1.5 * GB)).toBe('1.5 GB')
    expect(formatMemory(12.34 * GB)).toBe('12 GB')
  })
})

describe('formatCpu', () => {
  it('a rounded percent, a dash before the first delta', () => {
    expect(formatCpu(null)).toBe('—')
    expect(formatCpu(undefined)).toBe('—')
    expect(formatCpu(0)).toBe('0%')
    expect(formatCpu(85.4)).toBe('85%')
    expect(formatCpu(120.5)).toBe('121%')
  })
})

describe('heavyPillText', () => {
  it('memory alone unless CPU is the reason', () => {
    expect(heavyPillText({ rssBytes: 1.8 * GB, cpuPct: 20 })).toBe('1.8 GB')
    expect(heavyPillText({ rssBytes: 300 * MB, cpuPct: 140 })).toBe('300 MB · 140% CPU')
    expect(heavyPillText({ rssBytes: 300 * MB, cpuPct: null })).toBe('300 MB')
  })
})

describe('host sentences', () => {
  it('totals read as one line, with CPU only when known', () => {
    expect(hostTotalsText({ sessions: 0, rssBytes: 0, cpuPct: null })).toBe('No sessions running')
    expect(hostTotalsText({ sessions: 1, rssBytes: 700 * MB, cpuPct: null })).toBe('1 session · 700 MB')
    expect(hostTotalsText({ sessions: 9, rssBytes: 6.2 * GB, cpuPct: 140 })).toBe('9 sessions · 6.2 GB · 140% CPU')
    expect(formatProcCount(1)).toBe('1 process')
    expect(formatProcCount(7)).toBe('7 processes')
  })
  it('each no-reading reason has its own words', () => {
    expect(hostReasonText('not_connected')).toBe('Not connected')
    expect(hostReasonText('daemon_needs_upgrade')).toMatch(/update its daemon/)
    expect(hostReasonText('error', 'ps failed: timed out')).toBe('No reading: ps failed: timed out')
    expect(hostReasonText('error')).toBe('No reading')
    expect(hostReasonText(undefined)).toBe('')
    expect(hostReasonText('sampling')).toBe('Reading…')
    expect(staleReadingText('daemon command timeout')).toBe('Last reading shown, the newest failed: daemon command timeout')
    expect(staleReadingText()).toBe('Last reading shown, the newest failed')
  })
})
