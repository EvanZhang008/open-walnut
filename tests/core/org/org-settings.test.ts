/** The org's own names (src/core/org/org-settings.ts), pure part. */
import { describe, it, expect } from 'vitest'
import { orgSettingsOf, FOUNDER_TITLE_DEFAULT, ORG_NAME_DEFAULT, ORG_NAME_MAX } from '../../../src/core/org/org-settings.js'

describe('org names', () => {
  it('reads the stored names, else the defaults', () => {
    expect(orgSettingsOf({})).toEqual({ name: ORG_NAME_DEFAULT, founderTitle: FOUNDER_TITLE_DEFAULT })
    expect(orgSettingsOf({ org: { name: '  Walnut   Labs ', founder_title: 'Chair' } })).toEqual({ name: 'Walnut Labs', founderTitle: 'Chair' })
    // A blank or a hand-edited wrong type is the default.
    expect(orgSettingsOf({ org: { name: '   ', founder_title: 7 as never } })).toEqual({ name: 'Org', founderTitle: 'Founder' })
    expect(orgSettingsOf({ org: { name: 'x'.repeat(200) } }).name).toHaveLength(ORG_NAME_MAX)
  })
})
