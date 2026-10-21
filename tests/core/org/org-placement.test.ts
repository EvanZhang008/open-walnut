/**
 * Work a project lead files is one of its project's teams: in the project, at
 * the top, never in a folder made beside the lead (an ordinary worker's work
 * joins or makes a folder with it, caller-placement.ts). The lead is hidden from
 * the board, so a folder holding it would show up as a folder of strangers.
 */
import { describe, it, expect } from 'vitest'
import { decidePlacement, type CallerPlacement } from '../../../src/core/sessions/caller-placement.js'

const session = { id: 's1', host: '' }
const lead: CallerPlacement = { kind: 'worker', session, task: { id: 'lead1', title: 'Walnut lead', project: 'Walnut', orgLead: true } }
const worker: CallerPlacement = { kind: 'worker', session, task: { id: 'w1', title: 'A team', project: 'Walnut' } }

describe('placement from a project lead', () => {
  it('files into its project with the parent link and no folder', () => {
    expect(decidePlacement({}, lead)).toEqual({ project: 'Walnut', group_id: undefined, placeBesideCaller: false, inheritedFrom: 'lead1', parentTaskId: 'lead1' })
  })

  it('an explicit project or folder still wins', () => {
    expect(decidePlacement({ project: 'Other', group_id: 'g_1' }, lead)).toEqual({ project: 'Other', group_id: 'g_1', placeBesideCaller: false, parentTaskId: 'lead1' })
  })

  it('an ordinary worker is still placed beside itself', () => {
    expect(decidePlacement({}, worker)).toMatchObject({ project: 'Walnut', placeBesideCaller: true, parentTaskId: 'w1' })
  })
})
