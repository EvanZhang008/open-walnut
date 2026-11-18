import { describe, it, expect } from 'vitest'
import { SSH_CERT_EXPIRY, sshCertExpiredTurn } from '../../src/core/human-inbox/walnut-letters/ssh-cert-expiry.js'

const expiresAt = Date.UTC(2026, 10, 17, 18, 36)
describe('certificate letters distinguish credential owner from login targets', () => {
  it.each(['en', 'zh'] as const)('the %s warning, expired letter and thread state where renewal runs', lang => {
    for (const expired of [false, true]) {
      const letter = SSH_CERT_EXPIRY.render(lang, { hosts: ['Cloud workstation'], owner: 'your Mac', expiresAt,
        now: expiresAt - 3_600_000, hint: 'run acmelogin on the Mac', expired })
      expect(letter.subject).toContain(lang === 'zh' ? '你的 Mac 上的 SSH 证书' : 'SSH certificate on your Mac')
      expect(letter.markdown).toContain('Cloud workstation')
      expect(letter.markdown).toContain('run acmelogin on the Mac')
      expect(letter.markdown).toContain(lang === 'zh' ? '凭据所在机器：你的 Mac' : 'Credential location: your Mac')
      expect(letter.markdown).toContain(lang === 'zh' ? '续期不会更新其他机器上的凭据' : 'does not update credentials on other machines')
    }
    const turn = sshCertExpiredTurn(lang, { hosts: ['Cloud workstation'], owner: 'your Mac', expiresAt, hint: 'run acmelogin on the Mac' })
    expect(turn).toContain(lang === 'zh' ? '续期位置：你的 Mac' : 'Renew on your Mac')
  })
  it('without a configured command, it names the correct machine without inventing a command', () => {
    const letter = SSH_CERT_EXPIRY.render('en', { hosts: ['Cloud workstation'], owner: 'your Mac', expiresAt, now: expiresAt - 3_600_000 })
    expect(letter.markdown).toContain('Renew SSH login credentials on your Mac, not on the login targets')
    expect(letter.markdown).not.toContain('acmelogin')
  })
})
