/**
 * Whose download it is in the extension (packages/browser-extension/src/download-owner.ts): a
 * download with no referrer is the agent's only while one agent tab is being acted in AND the
 * file's address is on the origin of one of that owner's agent tabs, so the person's own
 * download from another site at that moment is never handed to the agent.
 */
import { describe, expect, it } from 'vitest'
import { downloadOwner, type AgentTabNow } from '../../../packages/browser-extension/src/download-owner'

const tab = (over: Partial<AgentTabNow> = {}): AgentTabNow => ({ id: 1, owner: 'task:a', url: 'https://files.example.test/list', history: [], acting: true, ...over })

describe('a download with no referrer', () => {
  it('is the acting owner\'s when the file is on one of its tabs\' origins', () => {
    expect(downloadOwner({ url: 'https://files.example.test/report.csv' }, [tab()])).toEqual({ owner: 'task:a', tab: 1 })
    // Another of that owner's tabs (not the acting one) on the file's origin counts too.
    expect(downloadOwner({ url: 'https://cdn.example.test/r.csv' }, [tab(), tab({ id: 2, url: 'https://cdn.example.test/', acting: false })])).toEqual({ owner: 'task:a', tab: 1 })
  })

  it('is no agent\'s when the file is on another origin (the person\'s own download in that moment)', () => {
    expect(downloadOwner({ url: 'https://bank.other.test/statement.pdf' }, [tab()])).toBeUndefined()
    expect(downloadOwner({ url: 'http://files.example.test/report.csv' }, [tab()])).toBeUndefined()
    // Another owner's tab on that origin does not make it this owner's.
    expect(downloadOwner({ url: 'https://bank.other.test/s.pdf' }, [tab(), tab({ id: 3, owner: 'task:b', url: 'https://bank.other.test/', acting: false })])).toBeUndefined()
  })

  it('is no agent\'s outside the time window, or with two tabs acting', () => {
    expect(downloadOwner({ url: 'https://files.example.test/report.csv' }, [tab({ acting: false })])).toBeUndefined()
    expect(downloadOwner({ url: 'https://files.example.test/report.csv' }, [tab(), tab({ id: 2, owner: 'task:b' })])).toBeUndefined()
  })
})

describe('a download with a referrer', () => {
  it('a full referrer that is an agent tab\'s page is that tab\'s', () => {
    expect(downloadOwner({ referrer: 'https://files.example.test/list', url: 'https://cdn.other.test/x' }, [tab({ acting: false })])).toEqual({ owner: 'task:a', tab: 1 })
  })
  it('an origin-only referrer counts only for the one acting tab on that origin', () => {
    expect(downloadOwner({ referrer: 'https://files.example.test/', url: 'https://cdn.other.test/x' }, [tab()])).toEqual({ owner: 'task:a', tab: 1 })
    expect(downloadOwner({ referrer: 'https://elsewhere.test/', url: 'https://files.example.test/x' }, [tab()])).toBeUndefined()
  })
})
