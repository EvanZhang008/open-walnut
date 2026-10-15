/**
 * The phone's one-line session status (web/src/utils/phone-session-label.ts,
 * spec 4.2): visible text, four readings, a waiting prompt wins.
 */
import { describe, it, expect } from 'vitest'
import { phoneSessionLabel } from '../../web/src/utils/phone-session-label'

describe('phoneSessionLabel', () => {
  it('names the tool a prompt waits on, over any process state', () => {
    expect(phoneSessionLabel({ process_status: 'running', pendingPermissionTool: 'Bash' })).toBe('Needs you: Bash')
    expect(phoneSessionLabel({ process_status: 'idle', pendingPermissionTool: ' Edit ' })).toBe('Needs you: Edit')
  })

  it('reads the process state otherwise', () => {
    expect(phoneSessionLabel({ process_status: 'running' })).toBe('Running')
    expect(phoneSessionLabel({ process_status: 'idle', pendingPermissionTool: null })).toBe('Idle')
    expect(phoneSessionLabel({ process_status: 'stopped' })).toBe('Stopped')
  })

  it('reads an errored, unknown or absent process as stopped', () => {
    expect(phoneSessionLabel({ process_status: 'error' })).toBe('Stopped')
    expect(phoneSessionLabel({ process_status: 'weird' })).toBe('Stopped')
    expect(phoneSessionLabel({})).toBe('Stopped')
    expect(phoneSessionLabel(null)).toBe('Stopped')
    expect(phoneSessionLabel(undefined)).toBe('Stopped')
  })

  it('N6: a stopped process with an old prompt reads Stopped, as the desktop does', () => {
    expect(phoneSessionLabel({ process_status: 'stopped', pendingPermissionTool: 'AskUserQuestion' })).toBe('Stopped')
    expect(phoneSessionLabel({ pendingPermissionTool: 'Bash' })).toBe('Stopped')
    expect(phoneSessionLabel({ process_status: 'error', pendingPermissionTool: 'Bash' })).toBe('Stopped')
  })

  it('N6: says what a person does, not the tool identifier', () => {
    expect(phoneSessionLabel({ process_status: 'running', pendingPermissionTool: 'AskUserQuestion' })).toBe('Needs your answer')
    expect(phoneSessionLabel({ process_status: 'idle', pendingPermissionTool: 'ExitPlanMode' })).toBe('Needs you: plan review')
    expect(phoneSessionLabel({ process_status: 'running', pendingPermissionTool: 'mcp__files__read_file' })).toBe('Needs you: read_file')
  })

  it('ignores an empty tool name', () => {
    expect(phoneSessionLabel({ process_status: 'running', pendingPermissionTool: '  ' })).toBe('Running')
  })
})

describe('phoneSessionLabel: the bar agrees with the timeline (N2-10)', () => {
  it('a card the timeline draws names the bar, even over a stopped record', () => {
    expect(phoneSessionLabel({ process_status: 'stopped', cardTool: 'Bash' })).toBe('Needs you: Bash')
    expect(phoneSessionLabel({ process_status: 'idle', cardTool: 'AskUserQuestion' })).toBe('Needs your answer')
    expect(phoneSessionLabel({ process_status: undefined, cardTool: 'a prompt' })).toBe('Needs you')
  })
  it('a session whose record is gone says so, not Stopped', () => {
    expect(phoneSessionLabel({ process_status: undefined, missing: true })).toBe('Not available')
  })
})

describe('phoneSessionLabel: a task handed back (N2-10)', () => {
  it('reads Needs you like its home row, unless a turn runs', () => {
    expect(phoneSessionLabel({ process_status: 'idle', taskNeedsYou: true })).toBe('Needs you')
    expect(phoneSessionLabel({ process_status: 'stopped', taskNeedsYou: true })).toBe('Needs you')
    expect(phoneSessionLabel({ process_status: 'running', taskNeedsYou: true })).toBe('Running')
  })
})

describe('phoneSessionLabel: before the record loads (N2-10)', () => {
  it('says nothing for an unknown process instead of a default Stopped', () => {
    expect(phoneSessionLabel({ process_status: undefined, loading: true })).toBe('')
    expect(phoneSessionLabel({ process_status: null, loading: true })).toBe('')
  })
  it('reads what a list surface already reported', () => {
    expect(phoneSessionLabel({ process_status: 'running', loading: true })).toBe('Running')
    expect(phoneSessionLabel({ process_status: 'idle', pendingPermissionTool: 'Bash', loading: true })).toBe('Needs you: Bash')
    expect(phoneSessionLabel({ process_status: undefined, taskNeedsYou: true, loading: true })).toBe('Needs you')
  })
  it('a loaded record with no process still reads Stopped', () => {
    expect(phoneSessionLabel({ process_status: undefined })).toBe('Stopped')
  })
})
