import { describe, expect, it } from 'vitest'
import { wifiSignInLink } from '../../web/src/components/settings/sections/cloud/WifiSignIn.js'
import { formatSignInCode } from '../../web/src/components/common/sign-in-code.js'

describe('Wi-Fi sign-in link', () => {
  it('opens the Wi-Fi address with the code main.tsx trades on open', () => {
    expect(wifiSignInLink('http://192.0.2.10:3456', 'ABCDEFGH')).toBe('http://192.0.2.10:3456/#pair=ABCDEFGH')
    expect(wifiSignInLink('http://192.0.2.10:3456/', 'ABCDEFGH')).toBe('http://192.0.2.10:3456/#pair=ABCDEFGH')
  })
  it('is read back as its code when pasted into the sign-in field', () => {
    expect(formatSignInCode(wifiSignInLink('http://192.0.2.10:3456', 'ABCDEFGH')).normalized).toBe('ABCDEFGH')
  })
})
