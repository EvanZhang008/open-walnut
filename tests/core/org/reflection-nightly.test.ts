/**
 * The nightly hand-off of the reflection duty (src/core/org/reflection/nightly.ts): after 19:45
 * local, a node whose reflection wrote a record today gets one note naming the file and each
 * finding; never before, never twice a night, and nothing on a day with no finding.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-nightly'))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { nightlyNote, nightlyText } from '../../../src/core/org/reflection/nightly.js'
import { reflectionDayFileOf } from '../../../src/core/org/reflection/records.js'
import { localDate } from '../../../src/core/org/reflection/state.js'

const vp = { id: 'vp-marina', title: 'Marina VP', org_role: 'lead', phase: 'IN_PROGRESS' } as Task
const at = (h: number, m: number) => new Date(2026, 10, 19, h, m).getTime()
const RECORD = '# Session reflection: Marina VP, x\n\n## 14:02 Upgrade the autoscaler (w-1)\n- Why looked: x\n- What went wrong: It kept 1.8.1 inside 1.4.\n- The right way: y\n\n## 15:10 Send on the real account (w-2)\n- What went wrong: It tried four times on the real account.\n'

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the nightly record', () => {
  it('goes to the node once after 19:45, naming the file and each finding', async () => {
    const file = reflectionDayFileOf(vp.id, localDate(at(20, 0)))
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, RECORD, 'utf-8')
    const sent: string[] = []
    const send = async (_n: Task, text: string) => { sent.push(text); return true }
    expect(await nightlyNote(vp, 'Marina VP', at(19, 30), send)).toBe('early')
    expect(await nightlyNote(vp, 'Marina VP', at(19, 50), send)).toBe('sent')
    expect(await nightlyNote(vp, 'Marina VP', at(22, 0), send)).toBe('done')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(file)
    expect(sent[0]).toContain('- 14:02 Upgrade the autoscaler (w-1): It kept 1.8.1 inside 1.4.')
    expect(sent[0]).toContain('found 2 decisions')
  })

  it('sends nothing on a day with no finding', async () => {
    const sent: string[] = []
    expect(await nightlyNote(vp, 'Marina VP', at(21, 0), async (_n, t) => { sent.push(t); return true })).toBe('none')
    expect(sent).toEqual([])
  })

  it('keeps the note short whatever the record holds', () => {
    const many = Array.from({ length: 60 }, (_, i) => `## 10:${String(i).padStart(2, '0')} Task ${i} (t-${i})\n- What went wrong: ${'a long sentence about the work '.repeat(3)}\n`).join('\n')
    const text = nightlyText('Marina VP', '/x/2026-11-19.md', many)
    expect(text.length).toBeLessThan(2200)
    expect(text).toMatch(/- \.\.\. \d+ more in the record/)
  })
})
