/**
 * A workout the watch kept recording into the night is drawn as its first two
 * hours (ending at bedtime when that comes first), not as exercise until the
 * morning. Real shape: a game from 20:41 "lasting" until 08:11 the next day.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('timeline-workout-trim'))

import { LEFT_RUNNING_KEEP_MS, trimLeftRunningWorkout } from '../../../src/core/time-tracking/timeline/core-sources.js'

const t = (d: number, h: number, m = 0): number => new Date(2026, 9, d, h, m).getTime()
const NIGHT: Array<[number, number]> = [[t(8, 1, 30), t(8, 8, 7)]]

describe('trimLeftRunningWorkout', () => {
  it('keeps the first two hours of a workout that runs into the night', () => {
    expect(trimLeftRunningWorkout(t(7, 20, 41), t(8, 8, 11), NIGHT)).toEqual({ endMs: t(7, 20, 41) + LEFT_RUNNING_KEEP_MS, trimmed: true })
  })

  it('ends at bedtime when bed comes first', () => {
    expect(trimLeftRunningWorkout(t(8, 0, 30), t(8, 8, 11), NIGHT)).toEqual({ endMs: t(8, 1, 30), trimmed: true })
  })

  it('leaves alone a workout clear of sleep, and one that starts inside a night', () => {
    expect(trimLeftRunningWorkout(t(8, 20, 27), t(8, 22, 14), NIGHT)).toEqual({ endMs: t(8, 22, 14), trimmed: false })
    expect(trimLeftRunningWorkout(t(8, 3), t(8, 3, 30), NIGHT)).toEqual({ endMs: t(8, 3, 30), trimmed: false })
  })
})
