/** The org's own names (src/core/org/org-settings.ts), pure part. */
import { describe, it, expect } from 'vitest'
import { orgSettingsOf, FOUNDER_TITLE_DEFAULT, ORG_NAME_DEFAULT, ORG_NAME_MAX } from '../../../src/core/org/org-settings.js'

describe('org names', () => {
  it('reads the stored names, else the defaults', () => {
    expect(orgSettingsOf({})).toMatchObject({ name: ORG_NAME_DEFAULT, founderTitle: FOUNDER_TITLE_DEFAULT })
    // The editors show Walnut's default core instructions while the user has set none.
    expect(Object.keys(orgSettingsOf({}).defaultInstructions)).toEqual(['main', 'lead'])
    expect(orgSettingsOf({ org: { name: '  Walnut   Labs ', founder_title: 'Chair' } })).toMatchObject({ name: 'Walnut Labs', founderTitle: 'Chair' })
    // A blank or a hand-edited wrong type is the default.
    expect(orgSettingsOf({ org: { name: '   ', founder_title: 7 as never } })).toMatchObject({ name: 'Org', founderTitle: 'Founder' })
    expect(orgSettingsOf({ org: { name: 'x'.repeat(200) } }).name).toHaveLength(ORG_NAME_MAX)
  })
})
